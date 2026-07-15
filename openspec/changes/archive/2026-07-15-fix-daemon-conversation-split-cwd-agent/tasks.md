# Tasks

## 1. Server: re-point the canonical session instead of forking
- [ ] Replace the `X::<conn>` fork in `createTurnAndResolveTarget` with a re-point of the idea's canonical session origin (same `sessionId === directIdeaUuid`)
- [ ] Reuse the deliberate write-once reversal pattern from `repointSessionOriginAndSend`; scope to `directed && directIdeaUuid && existing.originConnectionUuid !== origin.uuid`
- [ ] Decide + document the live-old-origin rule (R1)
- [ ] Unit tests: re-point branch, no `::` row created, live-old-origin case, un-pinned path unchanged

## 2. UI: harden interrupt to reach the idea's running turn from any thread
- [ ] Widen `daemon-chat.tsx` composer-execution derivation to search across all connection slices for the idea's running execution
- [ ] Make `executionMatchesSession` tolerate the legacy `${ideaUuid}::${conn}` residual key (guard on `sessionId.includes("::") && directIdeaUuid === null`)
- [ ] Unit tests: cross-slice match, `::` tolerance, ad-hoc unchanged, sibling-idea NOT matched

## 3. Integration checkpoint + e2e
- [ ] Drive cwd-switch under one idea end-to-end (live local daemon): one thread, interrupt works
- [ ] Drive agent-switch: interrupt reaches the running turn from the other agent's thread
- [ ] Confirm a pre-existing residual `::` thread regains a working interrupt
