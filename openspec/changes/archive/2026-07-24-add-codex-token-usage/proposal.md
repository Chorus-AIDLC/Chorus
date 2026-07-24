# Proposal: Codex — plug per-turn token usage into the shared pipeline

## Why

The [Claude Code E2E slice](https://github.com/Chorus-AIDLC/chorus/pull/446) built the entire per-turn token-usage pipeline — the normalized `TokenUsage` contract, the `turn-advance` wire object, the `DaemonSessionTurn.usage` JSON column + `DaemonSession` scalar rollup, the SSE projection, the per-turn badge, and the conversation header total. That pipeline is **backend-agnostic by construction**: the wire `usage.source` field is `z.string().min(1).max(60)` (no enum), and the persistence / read projection / UI never branch on backend. The theme (`155dbb29`) built it once so each follow-on backend only plugs in its capture.

Codex is the next backend. Today `cli/codex-spawner.mjs` runs `codex exec --json` and the daemon parses two of its JSONL events — `thread.started` (thread id) and `item.completed` (agent_message text, via `extractTranscriptText`) — but **drops the usage-bearing `turn.completed` event**. This is the exact shape of the Claude slice: we keep a frame we already stream past, we do not add a new capture mechanism. No wire change, no schema change, no server change, no UI change — capture-only.

**Verified against the installed codex-cli (not the idea's original assumptions).** The idea was written against codex-cli 0.142.3; the installed CLI is **0.145.0**. A live `codex exec --json` run produced:

```json
{"type":"turn.completed","usage":{"input_tokens":13497,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0}}
```

This corrected three stale facts in the original idea, resolved in elaboration (round `387eb62c`, owner-confirmed):

1. **`cache_write_input_tokens` is now on the stream** (idea assumed no cache-write). → map it to `cacheCreationTokens` (owner: "map").
2. **`reasoning_output_tokens` is on the stream** (idea assumed on-disk-only). It is NOT added to `output_tokens`: reasoning is a subdivision already counted *inside* `output_tokens` (the OpenAI Responses API `output_tokens_details.reasoning_tokens` shape — verified against `../codex/codex-rs`), so adding it double-counts. `outputTokens ← output_tokens` alone, which already includes reasoning and matches Claude, whose output also folds thinking. (Elaboration round 387eb62c initially locked a "sum" on the mistaken premise that reasoning was billed separately; the ship-time code-review gateway caught the double-count and it was corrected to `output_tokens` alone — same intent, correct formula.)
3. **No model id appears on any `--json` event.** → `model` is `null` for Codex; `source:"codex"` still makes the partial data interpretable (owner: "null").

## What Changes

### Capture (daemon) — the ONLY code change

- In `cli/upload-hooks.mjs`, add `extractCodexTurnUsage(obj)` — the Codex counterpart to the existing `extractTurnUsage` (Claude). It returns a normalized `TokenUsage` for a `turn.completed` frame, else `null`, and never throws. The two extractors are discriminated purely by top-level event type (`type:"result"` for Claude vs `type:"turn.completed"` for Codex — disjoint, so no backend flag is needed, exactly as `extractTranscriptText` already distinguishes the two dialects).
- Add a `CODEX_USAGE_SOURCE = "codex"` constant beside `CLAUDE_CODE_USAGE_SOURCE` (matching the `clientType` the daemon already reports for the Codex backend — see `cli/daemon-agent.mjs`).
- In the transcript hook's `onTranscriptMessage`, extract usage from **both** dialects: try the Claude extractor, then the Codex extractor; whichever returns non-null updates `lastUsage`. This keeps the single capture site the Claude slice established (`lastUsage` → returned from `onSessionEnd` → ridden onto the terminal `#advanceTurn` by the waker). No change to `waker.mjs`, `turn-reporter.mjs`, `daemon-rest-client.mjs`, or the server — those already carry `usage` end-to-end for any backend.

### Locked mapping (`turn.completed.usage` → `TokenUsage`)

| `TokenUsage` field | Source | Note |
|---|---|---|
| `inputTokens` | `input_tokens` | int-guarded, null on garble |
| `outputTokens` | `output_tokens` | **alone** — reasoning is a subdivision already inside `output_tokens`; adding it double-counts |
| `cacheReadTokens` | `cached_input_tokens` | |
| `cacheCreationTokens` | `cache_write_input_tokens` | present on 0.145.0; null on an older CLI that omits it |
| `model` | — | `null` (no model on the Codex stream) |
| `source` | — | `"codex"` |

Each numeric field is coerced through the same `toTokenInt` guard the Claude path uses (non-negative integer, else `null`) — a CLI that ever drops or garbles a field yields `null` for that field, never a bogus number or a throw. `outputTokens` is `output_tokens` alone (null if absent/garbled); `reasoning_output_tokens` is intentionally ignored since it is already counted inside `output_tokens`.

### Verification

A real Codex daemon conversation must show accurate per-turn input/output + cache-read + cache-write tokens and a correct running total, using the exact pipeline the Claude slice built — proving the pipeline is truly backend-agnostic.

## Capabilities

### Modified Capabilities

- `daemon-token-usage`: extends the capture requirement set with a Codex-specific capture requirement — the daemon captures per-turn usage from the Codex `turn.completed` stream event and normalizes it to the same `TokenUsage` contract, with `outputTokens` from `output_tokens` alone (reasoning is already inside it), `cacheCreationTokens` from `cache_write_input_tokens`, `cacheReadTokens` from `cached_input_tokens`, and `model` null. The contract, wire, persistence, SSE, and UI requirements are unchanged and reused verbatim.

## Impact

- **Code:** one file — `cli/upload-hooks.mjs` (new `extractCodexTurnUsage` + `CODEX_USAGE_SOURCE`, dual-dialect extraction in `onTranscriptMessage`). Plus tests.
- **Wire / schema / server / UI:** **none.** `usage.source` is an unconstrained string server-side; persistence, read projection, SSE, badge, and header total are backend-neutral and already shipped.
- **Backends:** only Codex capture is added. Claude Code capture is unchanged; OpenClaw and Kiro remain separate ideas.
- **Compatibility:** an older codex-cli that omits `cache_write_input_tokens` degrades gracefully (that field reads `null`) — no version pin required.
- **Risk:** low. The capture reuses an already-parsed stream and an already-shipped end-to-end pipeline; the extractor is pure and non-throwing; a non-`turn.completed` frame is a cheap no-op, leaving the transcript-text path (`item.completed`) untouched.
