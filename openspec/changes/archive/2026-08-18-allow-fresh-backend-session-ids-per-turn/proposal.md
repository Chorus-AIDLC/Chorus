## Why

A daemon restart can preserve the Chorus conversation while starting a fresh native backend session. The current session-wide conflict guard rejects that expected second identifier with HTTP 409, leaving an otherwise completed turn stuck in `running`.

## What Changes

- Persist a nullable authoritative backend session identifier on each `DaemonSessionTurn`.
- Keep `DaemonSession.backendSessionId` as the immutable first-wake identifier for compatibility and transcript/usage origin attribution.
- Scope idempotency and conflict detection to the resolved turn: the same identifier can be retried, a different identifier on that turn is rejected, and a later serialized turn can bind a fresh identifier.
- Correlate lifecycle reports by returning the resolved turn UUID from the running transition and carrying it as an optional field on later reports; retain status-based FIFO resolution for older daemons.
- Project the per-turn identifier through existing turn reads and transcript events.
- Add fresh-run restart-continuity coverage proving a second turn can settle with a distinct backend identifier while the session-level value remains unchanged.
- Use an additive, DDL-only migration with no historical backfill.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `backend-session-resume-id`: Change backend identifier authority and conflict detection from session-wide to per-turn while preserving the session's first identifier.
- `daemon-rest-client`: Add optional turn UUID correlation and parse the running transition's resolved turn response without introducing host coupling.

## Impact

- Prisma schema and one additive migration for `DaemonSessionTurn.backendSessionId`.
- `advanceTurnForWake` resolution, compare-and-set behavior, completed-turn idempotency, turn projection, fixtures, and service/API regression tests.
- CLI and OpenClaw daemon REST clients/reporters gain the same optional `turnUuid` field and running-response correlation behavior.
- `/api/daemon/turn-advance` remains backward compatible for older daemons; session-level UI copy behavior is unchanged.
- The already-orphaned pre-fix turn `7b273290` is not repaired or backfilled; acceptance uses a fresh `pnpm dev:local` run.
