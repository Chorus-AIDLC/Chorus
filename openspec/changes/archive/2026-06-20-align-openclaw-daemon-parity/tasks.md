# Tasks: OpenClaw daemon bidirectional parity

> Chorus task drafts are the source of truth; this list mirrors them for OpenSpec.

## 1. Shared daemon REST client (foundation)
- [ ] Extract `daemon-rest-client` (turn-advance / transcript / execution-state / report-interrupt / pending-turns) with `{url, apiKey, getConnectionUuid, fetchImpl, logger}` and zero host coupling.
- [ ] Refactor `cli/daemon.mjs` reporters onto the shared client; prove existing CLI daemon tests stay green (behavior-preserving).

## 2. Type the real SDK surface
- [ ] Verify whether `openclaw` `dist/plugin-sdk` types are cleanly importable; otherwise hand-declare the minimal used surface (runEmbeddedAgent + abortSignal + streaming callbacks + session helpers) in `openclaw-sdk.d.ts`, verified against real source.

## 3. connection_registered + control channel
- [ ] Add `onConnectionId` (store connectionUuid; refresh on reconnect) and `onControl` (fork `type:"control"`, never wake) to the SSE listener; build the control-handler with the double-check.

## 4. OpenClaw daemon client
- [ ] Run wakes via `runEmbeddedAgent` with abortSignal + transcript callbacks; report turn lifecycle + execution snapshot; AbortController registry for real interrupt (user/crash); deterministic session-key mapping; pending-turns backfill with at-most-once seen-set.

## 5. Integration checkpoint
- [ ] End-to-end against a live local server: wake → observe execution+transcript in UI → interrupt → resume → deliver_turn, on the OpenClaw host.

## 6. Docs & design
- [ ] Sync the relevant plugin skill surfaces (plugin-maintenance) and update `docs/design.pen` only if a user-facing surface changes.
