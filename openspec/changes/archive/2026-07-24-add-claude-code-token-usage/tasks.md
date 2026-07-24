# Tasks: Claude Code E2E per-turn token usage

## 1. Capture — daemon usage extractor
- [ ] 1.1 Verify the Claude Code `result` envelope usage field names AND the model's location against a LIVE `claude -p --output-format stream-json --verbose` capture on the installed CLI (model is NOT inside `usage`).
- [ ] 1.2 Define the `TokenUsage` JSDoc typedef and add `extractTurnUsage(obj) → TokenUsage | null` in `cli/upload-hooks.mjs` (result-frame only; `null` for every other frame).
- [ ] 1.3 Remember the last-seen per-session `result` usage in the transcript hooks (mirror `lastRelayError` scoping) and RETURN it from `onSessionEnd` as `{ relayError, usage }`.
- [ ] 1.4 Unit tests: full Claude usage, missing-cache partial, no-result-frame → null, non-result frames ignored, `onSessionEnd` returns usage, transcript extractor unchanged.

## 2. Forwarding chain + wire contract (the full 6-file relayError thread)
- [ ] 2.1 `cli/waker.mjs`: read `outcome.usage` from `onSessionEnd` and thread it through `#advanceTurn(..., usage)` → `this.advanceTurn({ ..., usage })` on the terminal edge (mirror `transcriptRelayError`).
- [ ] 2.2 `cli/turn-reporter.mjs`: destructure `usage` in the `advanceTurn` closure and pass it to `client.turnAdvance`.
- [ ] 2.3 Add optional nested `usage` to `cli/daemon-rest-client.mjs` `turnAdvance` (spread only on a terminal status).
- [ ] 2.4 Mirror byte-for-byte into `packages/openclaw-plugin/src/daemon-rest-client.ts` (`turnAdvance` + `DaemonRestClient` interface + `TokenUsage` type).
- [ ] 2.5 Add the optional `usage` object to the `/api/daemon/turn-advance` Zod body (nonneg ints nullish, bounded strings); pass into `advanceTurnForWake`.

## 3. Persist + project (server)
- [ ] 3.1 Prisma: add ONE nullable `usage Json?` turn column + two `@default(0)` scalar session rollup columns; `pnpm db:migrate:dev` then `pnpm db:generate`.
- [ ] 3.2 `advanceTurn`: write the single `usage` JSON verbatim + increment the scalar session rollup atomically (one transaction, Prisma `increment`) on the terminal edge only (ignore on → running).
- [ ] 3.3 Thread `usage` through `advanceTurnForWake`; extend `DaemonSessionTurnRow` / `toTurnView` (defensive cast → null on malformed) / `TurnView` / `TurnWithMessagesView` with one `usage` field and `DaemonSessionRow` / `toSessionView` / `SessionView` with the rollup; usage rides the existing `turn_status_changed` `TranscriptEvent`.
- [ ] 3.4 Service tests: terminal JSON write + rollup increment, running no-op, atomicity, malformed-blob → null projection, SSE payload carries usage.

## 4. Display (UI)
- [ ] 4.1 Per-turn compact badge + breakdown tooltip in `turn-band.tsx`; no badge when usage is null.
- [ ] 4.2 Header running total + conditional cache line in `transcript-view.tsx` (headline = in+out from rollup; cache excluded from headline).
- [ ] 4.3 i18n keys in en/zh/ko/ja; verify light AND dark themes; humanized number helper.
- [ ] 4.4 Update `docs/design.pen` (turn band badge + header total).

## 5. Integration checkpoint
- [ ] 5.1 Live Claude Code daemon conversation: accurate per-turn count on each turn + correct running total, live-patched over SSE (no refetch), both themes.
