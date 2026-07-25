# Technical Design: Codex per-turn token usage capture

## Overview

Plug Codex into the already-shipped `daemon-token-usage` pipeline. The pipeline is backend-agnostic below the capture layer, so this change touches exactly one production file (`cli/upload-hooks.mjs`) plus its test. Everything downstream — the `turn-advance` wire object, the `DaemonSessionTurn.usage` JSON column, the `DaemonSession` rollup, the SSE `turn_status_changed` projection, the per-turn badge, and the header total — is reused unchanged.

## What already exists (do not rebuild)

Verified in the current tree:

- **`TokenUsage` shape** (`cli/upload-hooks.mjs`): `{ inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens, model, source }`, all nullable except `source`. Tokens-only (no cost). This is the reuse target.
- **`extractTurnUsage(obj)`** (Claude): returns a `TokenUsage` for a `type:"result"` envelope, else `null`, never throws. Uses `toTokenInt` to coerce each count to a non-negative int or `null`.
- **Capture site**: `createTranscriptUploadHooks` → `onTranscriptMessage` calls `extractTurnUsage(message)`; a non-null result sets `lastUsage`. `onSessionStart` resets `lastUsage = null` (per-wake hygiene). `onSessionEnd` returns `{ relayError, usage: lastUsage }`.
- **Waker → server thread**: `waker.mjs` reads `outcome?.usage`, forwards it on the terminal `#advanceTurn` only; `turn-reporter.mjs` → `daemon-rest-client.mjs` (+ OpenClaw twin) → `/api/daemon/turn-advance` Zod body (`usage.source: z.string().min(1).max(60)` — **no enum**) → `advanceTurn` writes the JSON column + increments the rollup atomically on the terminal edge. Untouched by this change.
- **Codex stream already flows through this hook**: `codex-spawner.mjs` streams every parsed JSONL object through `onMessage` → the waker's `onTranscriptMessage`. `extractTranscriptText` already has a Codex branch (`item.completed` / `agent_message`). Codex `turn.completed` frames currently reach `onTranscriptMessage` and are dropped — that is the frame we will now also read for usage.

## The Codex `turn.completed` event (verified)

Live `codex exec --json` against codex-cli **0.145.0**:

```json
{"type":"turn.completed","usage":{"input_tokens":13497,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0}}
```

Source of truth: `../codex/codex-rs/exec/src/exec_events.rs` — `TurnCompletedEvent { usage: Usage }`, `Usage { input_tokens, cached_input_tokens, cache_write_input_tokens (#[serde(default)]), output_tokens, reasoning_output_tokens }`. No `model` field on any event (`thread.started` / `turn.started` / `item.completed` / `turn.completed`). `total_tokens` is not on the stream (on-disk rollout only) and is out of scope — we compute nothing from it.

## New code

### `extractCodexTurnUsage(obj)` in `cli/upload-hooks.mjs`

```js
export const CODEX_USAGE_SOURCE = "codex";

export function extractCodexTurnUsage(obj) {
  if (!obj || typeof obj !== "object" || obj.type !== "turn.completed") return null;
  const usage = obj.usage;
  if (!usage || typeof usage !== "object") return null;

  return {
    inputTokens: toTokenInt(usage.input_tokens),
    // output_tokens ALREADY includes reasoning_output_tokens (a subdivision, not a
    // separate bucket) — do NOT add reasoning or it double-counts.
    outputTokens: toTokenInt(usage.output_tokens),
    cacheCreationTokens: toTokenInt(usage.cache_write_input_tokens),
    cacheReadTokens: toTokenInt(usage.cached_input_tokens),
    model: null, // Codex stream carries no model id on any event
    source: CODEX_USAGE_SOURCE,
  };
}
```

`reasoning_output_tokens` is deliberately NOT added to `output_tokens`. In Codex / the OpenAI Responses API it is a subdivision *inside* `output_tokens` (`output_tokens_details.reasoning_tokens`), not a separate bucket — verified against `../codex/codex-rs/codex-api/src/sse/responses.rs` (`From<ResponseCompletedUsage>`; its test asserts `input:100 + output:10 = total:110` with `reasoning:5` already inside output) and `protocol.rs` `blended_total()` = `non_cached_input + output_tokens` (reasoning shown only as a parenthetical). So `outputTokens ← output_tokens` alone already includes reasoning and matches Claude, whose output also folds thinking. Each numeric field is `toTokenInt`-guarded (garble/absent → `null`, "no fabricated zeros").

### Dual-dialect extraction in `onTranscriptMessage`

The capture site tries both extractors; the dialects are disjoint (Claude `type:"result"` vs Codex `type:"turn.completed"`), so at most one returns non-null:

```js
const usage = extractTurnUsage(message) ?? extractCodexTurnUsage(message);
if (usage) lastUsage = usage;
```

Wrapped in the existing try/catch (`warn`, never throw). No other capture-site change; `lastUsage`, `onSessionStart` reset, and `onSessionEnd` return are all reused.

## Module contracts

- **Discriminator, not a flag.** The backend is inferred from the event's top-level `type`, never from a spawner-passed flag — identical to how `extractTranscriptText` already serves both dialects. This keeps the hook backend-neutral and avoids threading an agent-type parameter into the capture path.
- **`toTokenInt` guard applies to every numeric field** — a string / float / negative / missing count becomes `null` (renders no badge) rather than a bogus number.
- **`reasoning_output_tokens` is ignored, not summed** — it is already inside `output_tokens`.
- **`source` must equal the daemon's Codex client type** (`"codex"`, per `cli/daemon-agent.mjs` `backendClientType`) so persisted usage is attributable to the right backend and consistent with the connection's `clientType`.

## Risks & Mitigations

- **CLI drift (fields renamed/removed upstream).** Mitigated: every field is optional-guarded; a missing field → `null`, and a missing `turn.completed` entirely → the turn simply reports no usage (no badge), exactly like a Claude turn with no `result`. No version pin.
- **Older codex-cli without a cache-write field.** `cache_write_input_tokens` reads `null`; input/output/cache-read still populate. Graceful subset, no error.
- **Double-counting.** Two guards: (a) `reasoning_output_tokens` is NOT added to `output_tokens` (it is already inside it — the whole-feature bug the ship-time gateway caught); (b) Codex emits one `turn.completed` per turn (verified), and the capture keeps the last-seen usage — a resume run starts a fresh turn with its own `turn.completed`, so nothing is summed across frames.

## Test plan

Mirror the existing `extractTurnUsage` suite in `cli/__tests__/transcript-upload-hooks.test.mjs`:

- `extractCodexTurnUsage` maps the real 0.145.0 event correctly (the captured JSON above): `outputTokens ← output_tokens` alone, cache-write → cacheCreationTokens, cache-read → cacheReadTokens, model null, source `"codex"`.
- Reasoning is NOT added (`output_tokens=5, reasoning=2000`) → `outputTokens=5`.
- Older-CLI subset (no `cache_write_input_tokens`) → that field null; input/output/cache-read still valid.
- Garbled counts (string / negative / float) → that field null; never throws.
- Non-`turn.completed` frames (`item.completed`, `thread.started`, `turn.started`, Claude `result`) → `null` (no cross-dialect capture; Claude's `result` is NOT consumed by the Codex extractor and vice-versa).
- Capture-site: an `onTranscriptMessage` fed a Codex `turn.completed` then `onSessionEnd` returns `{ usage }` with `source:"codex"`; a Codex stream with no `turn.completed` returns `usage: null`.
- Regression: the existing Claude `extractTurnUsage` / capture tests still pass unchanged.
- Integration (`codex-backend-integration.test.mjs`): a simulated Codex wake whose stream includes `turn.completed` results in the terminal `turn-advance` carrying `usage` with `source:"codex"`.
