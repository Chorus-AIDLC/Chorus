## 1. Persist and project per-turn backend identity

- [x] 1.1 Add nullable `DaemonSessionTurn.backendSessionId` through a Prisma-generated DDL-only migration with no backfill.
- [x] 1.2 Extend turn row/view mapping, session transcript reads, SSE payloads, and test fixtures to expose the nullable per-turn identifier while preserving the session-level field.

## 2. Scope lifecycle conflict detection to one turn

- [x] 2.1 Add optional `turnUuid` to the authenticated turn-advance route/service contract, fence exact lookup by agent/company/session, and preserve FIFO status resolution for older daemons when it is absent.
- [x] 2.2 Parse the running transition's returned turn UUID in the shared CLI and OpenClaw REST clients, retain it in each wake context, and send it on terminal reports with mixed-version fallback.
- [x] 2.3 Resolve the lifecycle target turn before identifier binding and atomically accept a first binding or correlated identical retry while rejecting a different identifier on that turn.
- [x] 2.4 Treat a correlated replay of an already matching terminal transition as success without repeating usage rollups or other terminal side effects.
- [x] 2.5 Initialize `DaemonSession.backendSessionId` only when null, never overwrite it, and do not treat a later turn's distinct identifier as a session conflict.

## 3. Verify restart continuity and compatibility

- [x] 3.1 Add service, route, shared-client, reporter, and OpenClaw twin tests for correlation, same-turn idempotency, same-turn conflict rejection without transition, authenticated fencing, and mixed-version fallback.
- [x] 3.2 Add fresh-run restart-continuity coverage on `pnpm dev:local` where turn 1 binds A, turn 2 after restart binds B and reaches terminal state, the session retains A, and a turn 1 replay cannot affect running turn 2; do not repair or backfill pre-fix turn `7b273290`.
- [x] 3.3 Run focused daemon session and turn-advance suites, Prisma validation, OpenSpec validation, and the repository typecheck.
