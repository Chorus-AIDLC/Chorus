# Proposal: Claude Code E2E per-turn token usage — capture → upload → persist → display

## Why

Daemon-driven conversations consume real tokens, but Chorus shows none of it. A human watching a daemon agent grind through an idea has no idea whether a turn cost 3k tokens or 300k — the conversation view renders text and status, never usage. Cost/consumption visibility is the single most-requested piece of daemon observability that the platform still lacks.

Claude Code is the right backend to build this on first, for three reasons:

1. **It has the richest usage data.** Its headless `--output-format stream-json` stream ends each turn with a `type:"result"` envelope carrying full `usage` (`input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`) plus `total_cost_usd`. Every other backend reports a strict subset (Codex has cache-read only; OpenClaw's lives in host telemetry; Kiro reports nothing).
2. **The daemon already parses that stream.** `cli/claude-spawner.mjs` streams every NDJSON line through `onMessage`, and `cli/upload-hooks.mjs` already extracts transcript text from it — but `extractTranscriptText` drops the `result` envelope, which is exactly where the usage lives. We are keeping a frame we currently throw away, not adding a new capture mechanism.
3. **It is the template for the theme.** This idea is the 主体 (first child) of the "Per-turn token usage" theme (`155dbb29`). It builds ALL the shared plumbing — the normalized `TokenUsage` contract, the wire fields, the DB columns, the SSE projection, and the UI — once. The three follow-on ideas (Codex, OpenClaw, Kiro) each only plug their capture into the pipeline this idea lays down.

**⚠️ Do NOT read usage from the on-disk transcript JSONL.** Claude Code's session `*.jsonl` records `output_tokens` as a placeholder (1–2), a known upstream bug ([claude-code#25941](https://github.com/anthropics/claude-code/issues/25941)). Real per-turn usage is only on the LIVE `result` stream frame the daemon already consumes. The daemon does not read the on-disk JSONL for content anyway; it must not start reading it for usage.

The `relayError` annotation shipped in #444 is the exact precedent this follows: a single nullable field added to `DaemonSessionTurn` and threaded end-to-end (Zod body → service opts → `advanceTurn` → `TurnView` → `toTurnView` → `TranscriptEvent` SSE → UI). We reuse that thread verbatim, just carrying token fields instead of one string.

## What Changes

### 1. Capture (daemon)
- In `cli/upload-hooks.mjs`, add a usage extractor for the Claude Code `type:"result"` stream envelope. The `result` frame's `usage` is the **authoritative** per-turn total (matches Claude's own turn accounting); per-message `assistant.message.usage` frames are **NOT** summed (elaboration decision — avoids double-counting).
- Normalize to one **`TokenUsage`** shape — a **broad, mostly-nullable superset** so every later backend fits it and fills only the fields it can obtain:
  ```
  { inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens, model, source }
  ```
  Claude Code fills all four token fields + `model` + `source:"claude_code"`. Fields a backend can't report are `null` (elaboration decision: "define a broad standard, each agent picks the fields it can get").
- Cost is **out of scope this slice** (elaboration: tokens-only). `total_cost_usd` is neither captured, persisted, nor displayed here — a later idea can add cost end-to-end. The contract stays tokens-only so it is uniform across backends.
- The daemon knows the final turn usage at subprocess exit, so it rides the existing exit-path `turn-advance` (→ `ended`) alongside the #444 `relayError` — no new endpoint.

### 2. Upload (wire contract)
- Add the `TokenUsage` fields to `cli/daemon-rest-client.mjs` `turnAdvance`, and mirror them **byte-for-byte** into the OpenClaw twin `packages/openclaw-plugin/src/daemon-rest-client.ts` (the two are kept in lock-step by contract).
- Add matching optional/nullable fields to the `/api/daemon/turn-advance` Zod body, meaningful only on the terminal (`→ ended`) edge — exactly the `transcriptRelayError` posture.

### 3. Persist (server)
- Add ONE nullable JSON column `usage` to `DaemonSessionTurn` holding the whole `TokenUsage` object (human instruction: one JSON, not a field per number), plus a per-session running rollup on `DaemonSession` (`totalInputTokens`, `totalOutputTokens`, scalar ints defaulting to 0 — kept scalar so the rollup uses Prisma's atomic `increment`, which JSON can't). Migration via `pnpm db:migrate:dev` then regenerate the client. **DDL-only — no backfill** (migrations are DDL-only by project rule); pre-feature turns keep `null` usage.
- Thread `usage` through the full #444-style chain — `upload-hooks.mjs` (`onSessionEnd → { relayError, usage }`) → `waker.mjs` → `turn-reporter.mjs` → `daemon-rest-client.mjs` (+ OpenClaw twin) → `turn-advance` Zod body → `advanceTurnForWake` → `advanceTurn` (write the JSON + increment the rollup on the terminal edge only, atomically), then out through `toTurnView` / `TurnView` / `TurnWithMessagesView` / `SessionView` and the `TranscriptEvent` SSE payload — so a live viewer patches the per-turn badge AND the conversation total without a refetch.

### 4. Display (UI)
- **Per-turn badge** in `src/components/agent-presence/chat/turn-band.tsx`, beside the status `Badge`: a **compact total** (`inputTokens + outputTokens`, humanized e.g. `1.5k`) with a **tooltip** showing the full breakdown (in / out / cache-read / cache-write / model). Elaboration decision: compact + tooltip, not all-inline.
- **Conversation running total** in `transcript-view.tsx` header: a headline `input + output` total across all turns that reported, plus a secondary **cache line** (cache-read / cache-write totals) shown **only when cache data exists**. Cache is kept out of the headline number so a 100×-input cache-read never looks alarming (elaboration decision).
- **No-data turns show no badge at all** (elaboration decision): pre-feature turns and the rare silent turn render nothing; the running total sums only turns with data. The theme-level "not reported" label is reserved for the structurally-silent Kiro backend (its own child idea) — this Claude Code slice simply omits the badge.
- **i18n** across all 4 locales (`en`/`zh`/`ko`/`ja`); correct in **both** light and dark themes (badge + tooltip + header total use semantic tokens or hue-matched `dark:` variants). Update `docs/design.pen`.

## Capabilities

### New Capabilities

- `daemon-token-usage`: The end-to-end Claude Code per-turn token usage feature — the normalized `TokenUsage` contract (broad nullable superset, tokens-only, cost excluded), capture from the `result` envelope (authoritative, not summed, not from on-disk JSONL), the `turn-advance` wire object + the OpenClaw twin lock-step, the single `DaemonSessionTurn.usage` JSON column + `DaemonSession` scalar rollup persisted on the terminal edge, the SSE projection for live patching, the per-turn compact badge + tooltip, the conversation headline total with the conditional cache line, and the no-badge-for-no-data rule.

### Modified Capabilities

- `daemon-session-conversation`: `DaemonSessionTurn` gains one nullable `usage` JSON column and `DaemonSession` gains a scalar usage rollup; `turn-advance` / `advanceTurnForWake` / `advanceTurn` carry usage on the terminal edge; `TurnView` / `SessionView` / `TranscriptEvent` project it.
- `daemon-rest-client`: `turnAdvance` carries the optional `TokenUsage` fields; the OpenClaw twin mirrors them byte-for-byte.

## Impact

- **Schema:** additive-only. One new nullable JSON `usage` column on `DaemonSessionTurn`; two new `@default(0)` scalar rollup columns on `DaemonSession`. No column removed or retyped; no data migration.
- **Wire:** additive-only. New optional fields on the `turn-advance` body — an old daemon that omits them still advances turns exactly as today (usage stays `null`). Forward/backward compatible.
- **Backends:** only Claude Code capture ships here. Codex / OpenClaw / Kiro capture are separate ideas; until they land, their turns simply report no usage and render no badge.
- **Risk:** low. The capture reuses an already-parsed stream; the persistence/projection reuses the #444 nullable-annotation thread; the UI additions are non-blocking (a turn with no usage is the common, well-handled case). No change to the transcript content path, the interrupt path, or turn lifecycle legality.

## Out of Scope

- Cost / USD anywhere (contract, DB, UI) — deferred to a follow-up idea.
- Codex, OpenClaw, and Kiro capture — separate child ideas of the theme.
- Estimating tokens from text length for silent backends — explicitly rejected at the theme level.
- Backfilling usage for turns that completed before this ships (DDL-only migrations; those turns stay no-badge).
- A per-message usage drill-down — only the per-turn `result` total is persisted.
