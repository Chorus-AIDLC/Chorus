# Tasks: Codex per-turn token usage capture

## 1. Codex usage extractor + dual-dialect capture (TDD)

- [ ] 1.1 Add `CODEX_USAGE_SOURCE = "codex"` and `extractCodexTurnUsage(obj)` to `cli/upload-hooks.mjs` (parse `turn.completed.usage`; map per the table; `outputTokens ← output_tokens` alone — reasoning is already inside it; `toTokenInt` guard; never throw).
- [ ] 1.2 Wire dual-dialect extraction in `onTranscriptMessage`: `extractTurnUsage(message) ?? extractCodexTurnUsage(message)`.
- [ ] 1.3 Unit tests in `cli/__tests__/transcript-upload-hooks.test.mjs` mirroring the `extractTurnUsage` suite: real 0.145.0 event, reasoning NOT added (output_tokens alone), older-CLI subset, garbled counts, non-`turn.completed` frames return null, capture-site `onSessionEnd` returns `{usage, source:"codex"}`, Claude regression intact.

## 2. Integration verification

- [ ] 2.1 Extend `cli/__tests__/codex-backend-integration.test.mjs`: a simulated Codex wake whose stream includes `turn.completed` yields a terminal `turn-advance` carrying `usage` with `source:"codex"`.
- [ ] 2.2 Live e2e: a real Codex daemon conversation shows accurate per-turn input/output (+ cache-read, + cache-write) and a correct running total in the conversation UI, using the unchanged shared pipeline.

## 3. Docs

- [ ] 3.1 Note the Codex capture in the daemon token-usage reference where the Claude capture is documented (source table / backend coverage), if such a note exists.
