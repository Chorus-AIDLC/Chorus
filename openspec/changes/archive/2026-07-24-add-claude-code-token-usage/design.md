# Technical Design: Claude Code E2E per-turn token usage

## Overview

Carry a normalized per-turn `TokenUsage` from the daemon's Claude Code stream, through the existing `turn-advance` report, into new `DaemonSessionTurn` columns + a `DaemonSession` rollup, out over the `transcript:{sessionUuid}` SSE channel, and into the chat UI as a per-turn badge + a conversation total.

The whole change is modeled on the **#444 `relayError` thread** — a single nullable turn annotation that already flows daemon → Zod body → service opts → `advanceTurn` → `TurnView` → `toTurnView` → `TranscriptEvent` → UI. We follow that exact path; the only structural difference is carrying five nullable fields instead of one string, plus a session-level rollup the relay-error case didn't need.

## The `TokenUsage` contract (source of truth for the theme)

One shape, defined once, reused by every later backend. A **broad, mostly-nullable superset** — each backend fills what it can and leaves the rest `null`.

```ts
interface TokenUsage {
  inputTokens: number | null;         // new (non-cache) input tokens
  outputTokens: number | null;        // generated tokens
  cacheCreationTokens: number | null; // cache-WRITE (Claude only; Codex/others null)
  cacheReadTokens: number | null;     // cache-READ
  model: string | null;               // e.g. "claude-opus-4-8"
  source: string;                     // backend id, e.g. "claude_code" — always set
}
```

- **`source` is the only always-present field** — it names which backend produced the row so partial data is interpretable. Everything else is nullable.
- **Cost is deliberately absent** (elaboration: tokens-only this slice). No `costUsd` field is added to the contract, the wire, the DB, or the view — a later idea introduces cost end-to-end.
- Claude Code populates the token fields from `result.usage`: `inputTokens` = `input_tokens`, `outputTokens` = `output_tokens`, `cacheCreationTokens` = `cache_creation_input_tokens`, `cacheReadTokens` = `cache_read_input_tokens`. `source` = `"claude_code"`.
- **`model` is NOT inside the `usage` object.** Anthropic's `usage` schema carries token counts only — no model key. The model string lives at the message/envelope level (the `assistant` frame's `message.model`, and/or a top-level field on the `result` envelope). The extractor reads it from there, not from `result.usage.model`. If the live frame exposes no model at the point usage is captured, `model` is `null` (the shape allows it).

> **Field-name verification note (HALLUCINATION GUARD):** the daemon developer MUST confirm the exact key names AND the model's location against a live `claude -p --output-format stream-json --verbose` capture on the installed CLI (the codebase pins verified CLI versions per file — e.g. claude-spawner cites 2.1.177). Do not trust these field names from memory; the [headless docs](https://code.claude.com/docs/en/headless) and [Anthropic usage schema](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) are the reference, but the live frame is authoritative. In particular, resolve where `model` actually appears before wiring it.

## Capture — where and how (`cli/`)

### Source: the `result` envelope, authoritative, not summed

`cli/claude-spawner.mjs` already routes every NDJSON line through `onMessage` → the waker → `upload-hooks.mjs`. Claude Code emits, at the end of a `claude -p` turn, a `{ type: "result", usage: {...}, total_cost_usd: ... }` frame. Today `extractTranscriptText` returns `null` for it (it isn't a `user`/`assistant` conversation message), so it is silently dropped.

- **Add a usage extractor** (new exported function in `upload-hooks.mjs`, e.g. `extractTurnUsage(obj) → TokenUsage | null`) that recognizes `obj.type === "result"` and maps `obj.usage` (+ the envelope-level model, see the model-location note above) into the `TokenUsage` shape. Returns `null` for every non-result frame (so the existing transcript extractor is untouched).
- **`result` is authoritative** (elaboration decision). Its `usage` is the cumulative total for the whole turn; we persist THAT and do NOT accumulate per-message `assistant.message.usage` frames. This matches Claude's own turn accounting and avoids the double-count that summing would cause.
- The transcript hooks and the usage capture are **independent concerns** on the same stream — `extractTranscriptText` keeps its exact behavior; the new extractor reads the same lines for a different frame type. No shared state, no ordering coupling.

### Delivery: the exit-path `turn-advance` (→ ended) — the full 6-file thread

The daemon knows the final turn usage only at subprocess exit (the `result` frame arrives near the end of the stream). This is the SAME moment the #444 flow computes `relayError` and issues the terminal `turn-advance`. **We reuse the relayError thread — but "verbatim" means all SIX files it touches, not just the two endpoints.** Traced end-to-end, `relayError` flows:

```
upload-hooks.mjs (onSessionEnd returns { relayError })
  → waker.mjs   (reads outcome.relayError, forwards via #advanceTurn(..., transcriptRelayError))
  → turn-reporter.mjs (advanceTurn closure destructures transcriptRelayError → client.turnAdvance)
  → daemon-rest-client.mjs (spreads it into the POST body on a terminal edge)
  → route.ts    (Zod body accepts it, passes to advanceTurnForWake)
  → daemon-session.service.ts (advanceTurn writes the column on the terminal edge)
```

`usage` MUST ride every one of those links or capture never reaches the wire. The two MIDDLE glue links are the ones easy to miss:

- **`cli/upload-hooks.mjs` — `onSessionEnd` returns usage alongside relayError.** The transcript-usage hook remembers the last-seen `result` usage for the current session (per-session, mirroring how `lastRelayError` is scoped in `createTranscriptUploadHooks`) and `onSessionEnd` returns `{ relayError, usage }` (today it returns `{ relayError }`). Usage capture lives in this same hook so the waker reads BOTH from one call.
- **`cli/waker.mjs` — forward the usage onto the terminal advance.** Today (waker.mjs ~489–511): `const outcome = await this.hooks?.onSessionEnd?.({ sessionId }); transcriptRelayError = outcome?.relayError ?? null;` then `this.#advanceTurn(sessionId, "ended"|"interrupted", entity, reason, transcriptRelayError)`. Add `const usage = outcome?.usage ?? null;` and thread it into `#advanceTurn(..., usage)`; `#advanceTurn` (~603–612) gains a `usage` param and spreads `...(usage ? { usage } : {})` into `this.advanceTurn({...})` — exactly as it already does for `transcriptRelayError`.
- **`cli/turn-reporter.mjs` — map usage into the client call.** The `advanceTurn` closure (~64–102) destructures `transcriptRelayError` and passes it to `client.turnAdvance`. Add `usage` to the destructure and the `client.turnAdvance({ ..., usage })` call. No new validation needed (the client owns the terminal-edge spread).
- Usage is meaningful ONLY on the terminal edge, exactly like `relayError`. A `→ running` advance never carries usage.
- Fire-and-forget + non-throwing, inheriting the existing hook contract: a missing/garbled `result` frame yields `null` usage (the turn still advances; it just renders no badge). No new failure path.

## Wire contract (`daemon-rest-client`)

`cli/daemon-rest-client.mjs` `turnAdvance` gains an optional `usage` argument; it spreads the token fields into the POST body **only when present and only for a terminal status** — the same conditional-spread idiom the file uses for `interruptedReason` / `transcriptRelayError`:

```js
async turnAdvance({ sessionId, status, entityType, entityUuid, interruptedReason, transcriptRelayError, usage }) {
  ...
  const body = {
    connectionUuid, sessionId, status,
    ...(entityType && entityUuid ? { entityType, entityUuid } : {}),
    ...(status === "interrupted" && interruptedReason ? { interruptedReason } : {}),
    ...(transcriptRelayError ? { transcriptRelayError } : {}),
    // usage is meaningful only on a terminal edge; the server ignores it on → running.
    ...(usage ? { usage } : {}),
  };
  ...
}
```

`packages/openclaw-plugin/src/daemon-rest-client.ts` is the **byte-for-byte TS twin** — its `turnAdvance` and the `DaemonRestClient` interface get the same optional `usage` param and body spread. (The OpenClaw plugin won't PRODUCE Claude Code usage, but the client is a shared wire contract and MUST NOT drift — a drift is caught by the live e2e.) The `usage` object is typed as the `TokenUsage` shape (all-nullable except `source`).

> **Body shape choice:** carry `usage` as a **nested object** (`{ usage: { inputTokens, ... } }`), not five sibling fields. It keeps the wire self-describing, matches the `TokenUsage` contract 1:1, and lets the Zod schema validate one optional object.

## Server persistence

### Zod body (`/api/daemon/turn-advance/route.ts`)

Add an optional `usage` object to `bodySchema`, all token fields `.int().nonnegative().nullish()`, `model` `.string().max(...).nullish()`, `source` a bounded string. Like `transcriptRelayError`, it is only acted on for a terminal edge (the service ignores it on `→ running`). Pass `usage` into `advanceTurnForWake`.

### Prisma schema (`prisma/schema.prisma`)

`relationMode = "prisma"`, additive-only. Via `pnpm db:migrate:dev` (never hand-written), then `pnpm db:generate` + dev-server restart (CLAUDE.md pitfall #1).

**Per-turn usage is ONE JSON column, not a column per number** (human instruction 2026-07-24: "用一个 json 就好了，不需要每个数字单独给一个字段"). The whole normalized `TokenUsage` object is stored verbatim in a single nullable `Json` column. This is the natural fit — the wire already carries `usage` as one nested object, so the column stores exactly what arrives; it also dissolves the awkward `usageModel` column and lets a later backend add a field it can report (e.g. a reasoning-token count) without a migration.

```prisma
model DaemonSessionTurn {
  // ... existing fields ...
  // Per-turn token usage (daemon-token-usage) — the whole normalized TokenUsage object
  // ({ inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens, model, source },
  // all nullable except source) stored as ONE JSON blob. Null when the backend reported
  // none (pre-feature turns, silent turns, or backends that can't report). Written on the
  // terminal edge only, verbatim from the authoritative Claude Code `result` envelope.
  // Cost is intentionally NOT included this slice (tokens-only contract).
  usage Json?
}

model DaemonSession {
  // ... existing fields ...
  // Running conversation rollup (daemon-token-usage): headline in+out across all
  // reporting turns. These stay SCALAR Int columns (NOT JSON) on purpose: the rollup is
  // maintained with an atomic Prisma `increment` on the terminal edge, and Prisma cannot
  // atomically increment a value inside a Json column. Two ints keep the increment
  // race-free without a read-modify-write. Cache totals are NOT rolled up here — the
  // header derives the conditional cache line from the per-turn `usage` of loaded turns.
  // Default 0 so an existing session reads a valid (zero) total with no backfill.
  totalInputTokens  Int @default(0)
  totalOutputTokens Int @default(0)
}
```

> **Why the turn is JSON but the rollup is two ints.** The per-turn value is a *record* the UI reads whole (badge + tooltip render fields off one object) and never mutates field-by-field — so JSON is the honest shape and per the human instruction. The session rollup is a *counter* incremented concurrently on every terminal edge; correctness there depends on `prisma … { increment: n }` being atomic, which only works on a scalar column. Mixing the two — JSON where it's a record, Int where it's a counter — is deliberate, not inconsistent.

> **Rollup vs derive.** The headline in+out total is stored on `DaemonSession` (incremented on the terminal edge) so the header renders it without loading every turn — important for a long conversation whose older turns are paginated out. The **cache line** is NOT rolled up: it is derived from the per-turn `usage` of the currently-loaded turns and only shown when present, so it needs no session column. (An accepted limitation: the cache line reflects loaded turns, not the whole history — acceptable because cache is secondary and the headline total is the authoritative number.)

### Service thread (`daemon-session.service.ts`)

Following the `relayError` thread exactly:

1. **`advanceTurn(turnUuid, status, opts)`** — add `opts.usage?: TokenUsage | null`. On a terminal edge (`ended`/`interrupted`), when `usage` is present, write the single `usage` JSON column verbatim. Ignore on `→ running` (same guard as `relayError`). This is also where the `DaemonSession` rollup is incremented: `totalInputTokens: { increment: usage.inputTokens ?? 0 }`, `totalOutputTokens: { increment: usage.outputTokens ?? 0 }` — in the same `prisma.$transaction` as the turn write so the two can't tear. Using Prisma's atomic `increment` (not read-add-write) is exactly why the rollup stays two scalar Ints while the turn value is one JSON blob.
2. **`advanceTurnForWake(params)`** — add `params.usage`, forward into the `advanceTurn` opts spread (`...(params.usage !== undefined ? { usage: params.usage } : {})`).
3. **`DaemonSessionTurnRow`** interface + **`toTurnView`** — read the one `usage` JSON column; **`TurnView`** / **`TurnWithMessagesView`** gain a single `usage: TokenUsage | null` field. The view mapper casts the stored JSON to the `TokenUsage` shape (defensive: a malformed/legacy blob → `null`, never a throw). Timestamps stay ISO strings.
4. **`DaemonSessionRow`** + **`toSessionView`** + **`SessionView`** — gain `totalInputTokens` / `totalOutputTokens`.
5. **`TranscriptEvent`** — the `turn` it carries is already a `TurnView`, so the SSE payload gains usage for free on `turn_status_changed` (the terminal-edge event). The session-total lives on `SessionView`, which the client already holds; the client can also recompute the headline from patched turns, but reading the rolled-up `SessionView` value after the terminal event is the simpler live path.

## SSE / live-update contract

No new channel, no new trigger. When the daemon reports `→ ended` with `usage`, `advanceTurn` writes the columns + rollup and publishes the existing `turn_status_changed` `TranscriptEvent` on `transcript:{sessionUuid}`. The client's existing patch-by-`turn.uuid` logic now receives a turn whose usage fields are populated → the badge appears live. The header total updates from the incremented `SessionView` rollup (the client refetches `SessionView` on the same event, or increments locally from the patched turn — implementer's choice; the server value is authoritative).

## UI

### Per-turn badge — `turn-band.tsx`

Beside the status `Badge` (line ~160–182). Read the turn's single `usage` object; render **only when** it is non-null and has a token count (`usage.inputTokens != null || usage.outputTokens != null`). Compact label = humanized `(usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)` (e.g. `1.5k`, `312`). Wrap in a shadcn `Tooltip` whose content lists in / out / cache-read / cache-write / model off the same `usage` object (each row omitted when its field is null). Reuse the muted secondary-badge styling already in the file; the tooltip is a new shadcn `Tooltip` (add via `npx shadcn@latest add tooltip` if not present). No badge for a no-usage turn — nothing rendered, no placeholder (elaboration decision).

### Conversation total — `transcript-view.tsx` header

In the status-badge flex-wrap line (~370–400). A small chip: headline = humanized `session.totalInputTokens + session.totalOutputTokens` (the scalar rollup) labeled e.g. "N tokens" via i18n. A **secondary cache line**, rendered only when any loaded turn's `usage` has cache data, sums `usage.cacheReadTokens` / `usage.cacheCreationTokens` across the loaded `turns` and shows them de-emphasized. Cache is NEVER folded into the headline number (elaboration decision — cache-read can be 100× input).

### Theme + i18n

- Badge/tooltip/header chip use semantic tokens (`text-muted-foreground`, `bg-secondary`, `text-foreground`) or, where a warm tint is wanted, a hue-matched `dark:` variant — verified in BOTH light and dark (CLAUDE.md theme rules).
- New i18n keys in all four locales (`en`/`zh`/`ko`/`ja`): the per-turn badge aria-label, the tooltip field labels (Input / Output / Cache read / Cache write / Model), and the header "tokens" + cache-line labels. Number humanization (`1.5k`) via an existing formatter if one exists, else a tiny local helper.

## Module Contracts (shared across tasks)

- **`TokenUsage`** shape is defined ONCE and imported by both the daemon (`cli/`, JSDoc typedef) and the server (`daemon-session.service.ts`, TS interface). The wire body nests it under `usage`; it is persisted verbatim in the turn's single `usage` JSON column; the `TurnView` re-exposes it as one `usage` field. All fields nullable except `source`. No `costUsd`. One object, one column, one view field — end to end.
- **The forwarding thread is the #444 `relayError` thread, all 6 files:** `upload-hooks.mjs` (`onSessionEnd → { relayError, usage }`) → `waker.mjs` (`#advanceTurn(..., usage)`) → `turn-reporter.mjs` (`client.turnAdvance({..., usage})`) → `daemon-rest-client.mjs` (+ OpenClaw twin, terminal-edge spread) → `route.ts` (Zod) → `daemon-session.service.ts` (`advanceTurn` write). A task that stops at the two endpoints leaves the two middle glue links unassigned and no usage ever reaches the wire — this is the exact review blocker B1.
- **Terminal-edge-only** rule: usage is written/rolled-up on `→ ended`/`→ interrupted` only, ignored on `→ running` — enforced in `advanceTurn`, not trusted from callers (mirrors the `relayError` invariant).
- **No-data = no badge**: the UI renders nothing (not "not reported") for a turn with null usage.
- **Rollup authority**: `DaemonSession.total*` is the headline number's source of truth; the cache line is derived from loaded turns.

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Claude `result` field names differ from memory | Verify against a LIVE stream capture on the installed CLI before coding the extractor; docs are attached as references. |
| Summing per-message usage would double-count | Persist ONLY the `result` total; never accumulate `assistant.message.usage` (explicit decision). |
| Rollup drift if turn write and session increment tear | Do both in one `prisma` transaction in `advanceTurn`, using atomic `increment` on the scalar rollup (the reason the rollup stays two Ints, not JSON). |
| A malformed/legacy `usage` JSON blob | `toTurnView` casts defensively — a blob that doesn't fit `TokenUsage` maps to `null` (no throw), and the UI just omits the badge. |
| Cache-read dwarfs input and alarms users | Cache is excluded from the headline; shown only on a secondary line, only when present. |
| Old daemon / old turns have no usage | All fields nullable, rollup defaults 0, UI omits the badge — no backfill, no misleading zeros. |
| OpenClaw twin drifts from the CLI client | Mirror the `usage` field byte-for-byte; the live e2e catches a drift. |
| Dark-mode contrast on the new badge/tooltip | Use semantic tokens / hue-matched `dark:`; verify both themes before done. |

## Implementation Plan (order)

1. Define `TokenUsage` + capture the `result` envelope in `upload-hooks.mjs`; have `onSessionEnd` return `{ relayError, usage }` (+ unit tests on the extractor and the returned usage). 
2. Forward + wire fields — the full glue chain: `waker.mjs` (read `outcome.usage`, thread through `#advanceTurn`) → `turn-reporter.mjs` (`advanceTurn` closure passes `usage` to `client.turnAdvance`) → `daemon-rest-client.mjs` `turnAdvance` + the OpenClaw twin + the `turn-advance` Zod body.
3. Schema migration + service thread (`advanceTurn` write + rollup, `advanceTurnForWake`, views, SSE) + service tests.
4. UI: per-turn badge + tooltip, header total + cache line, i18n ×4, both themes, design.pen.
5. Integration checkpoint: a real Claude Code daemon conversation shows an accurate per-turn count and a correct running total, live over SSE.
