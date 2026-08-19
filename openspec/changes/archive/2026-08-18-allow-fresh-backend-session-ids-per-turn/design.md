## Context

`/api/daemon/turn-advance` accepts a backend-owned identifier and delegates to `advanceTurnForWake`. Today that service compare-and-sets `DaemonSession.backendSessionId` before resolving the active turn. This is correct only for backends that resume one native session forever. A fresh dsh process instead creates a new native session for each daemon wake, even though Chorus intentionally reuses the durable idea-anchored `DaemonSession`.

The observed failure completed the second dsh wake under backend ID B, but the durable session was already bound to first-wake ID A. The session-wide guard returned `backend_session_conflict` before the running turn could transition to `ended`.

## Goals / Non-Goals

**Goals:**

- Make one turn the authority for the backend identifier reported by that wake.
- Preserve the existing session-level identifier as an immutable first-wake compatibility value.
- Keep identical report retries idempotent and retain a 409 for a genuine different-ID race on one turn.
- Let a later serialized turn bind another identifier and reach `ended` or `interrupted`.
- Correlate a terminal report and its retries to the exact turn without breaking older daemons.
- Keep historical rows valid without data backfill.

**Non-Goals:**

- Resuming dsh's native session across daemon wakes.
- Replacing the Chorus `(agentUuid, sessionId)` routing key.
- Changing the session header's copy control or redefining its first-wake value.
- Rewriting historical turns from the session-level identifier.
- Repairing or backfilling the already-orphaned pre-fix turn `7b273290`.

## Decisions

### Add a nullable identifier to each turn

Add `DaemonSessionTurn.backendSessionId String?` through a Prisma-generated, DDL-only migration. Extend `DaemonSessionTurnRow`, `TurnView`, `toTurnView`, test fixtures, session reads, and existing `TranscriptEvent.turn` projection. Old turns remain null.

The session column stays in place. It remains the stable first observed backend identifier used by existing session consumers; the new turn column is authoritative for individual wake execution.

Alternative considered: replace or reinterpret the session column as the latest value. That would make existing UI and attribution consumers drift after every wake and would lose the stable origin anchor.

### Correlate terminal reports with the turn resolved at the running edge

`advanceTurnForWake` already resolves lifecycle targets by status and FIFO order:

- `running` targets the oldest `pending` turn.
- `ended` and `interrupted` target the oldest `running` turn when no correlation UUID is supplied.

The successful running transition already returns `{ turn }` from `/api/daemon/turn-advance`. Update the shared REST clients to parse that existing response and expose `turn.uuid`. The CLI waker and OpenClaw run context retain the returned UUID for the duration of the wake and send it as an optional `turnUuid` on terminal reports.

When `turnUuid` is present, the server resolves that exact turn under the authenticated agent/company/session fence. When absent, it retains status-based FIFO resolution for older daemons.

An exact correlated replay against an already terminal turn is successful only when the requested terminal status and backend identifier match its stored values. It returns the existing turn without rerunning the transition, usage rollup, or other terminal side effects. A different status or identifier remains a 409.

Alternative considered: infer a retry by matching only `backendSessionId`. Persistent backends legitimately reuse one native identifier across multiple turns, so that inference can mistake turn 2's first terminal report for a retry of turn 1.

### Bind the identifier on the correlated turn

Use the resolved or correlated turn UUID for an atomic compare-and-set:

```text
WHERE turn.uuid = target
  AND (turn.backendSessionId IS NULL OR turn.backendSessionId = reported)
SET turn.backendSessionId = reported
```

A count of zero returns `backend_session_conflict` without advancing the turn. A count of one permits the normal transition. This preserves identical retry idempotency and scopes a different-ID 409 to the actual turn.

Alternative considered: key the guard by session plus current identifier. That reproduces the restart failure because native backend identity is not the durable Chorus conversation identity.

### Initialize the session value without making it a gate

When a non-empty identifier is reported, independently initialize `DaemonSession.backendSessionId` only where it is null. Never overwrite a non-null value and never treat a zero-row session update as a conflict. Thus first wake A remains the session value while a later turn can bind B.

The turn binding is the conflict authority. Concurrent reports for one turn remain protected by the turn compare-and-set; serialized later turns have separate nullable cells.

### Evolve the wire additively

Add optional `turnUuid` to the `turn-advance` body. New daemons obtain it from the successful running response and send it on terminal reports; old daemons omit it and continue through FIFO resolution. Keep the shared JavaScript client and OpenClaw TypeScript twin in lock-step. The existing `backend_session_conflict` response remains unchanged.

The pre-fix orphan `7b273290` is intentionally expendable. The change adds no repair endpoint, backfill, or hand-migration path; acceptance creates fresh turns and proves the corrected behavior going forward.

## Risks / Trade-offs

- [Risk] Binding the identifier before a later lifecycle transition failure can leave metadata on a turn whose status did not advance. -> Keep target resolution and compare-and-set adjacent to the existing transition path, and test conflict paths write no status transition; a correlated idempotent retry remains safe.
- [Risk] Session and first turn initialization can race. -> Both writes are monotonic null-to-value operations; the per-turn compare-and-set is authoritative, and the session update never overwrites a prior first value.
- [Risk] Adding the field to `TurnView` can break hand-built fixtures. -> Update structural fixtures and projection tests together.
- [Risk] A terminal retry could target a newer running turn. -> Correlate terminal reports with the UUID returned by the running transition and test a retry while a later turn is running.
- [Risk] Mixed daemon/server versions omit or ignore `turnUuid`. -> Keep the field optional and preserve FIFO fallback; response parsing treats a missing UUID as legacy behavior.

## Migration Plan

1. Add the nullable Prisma field and generate an additive `ALTER TABLE` migration.
2. Deploy the server/service changes with optional correlation and FIFO fallback.
3. Deploy daemon client/reporter changes that consume the running response and send `turnUuid`.
4. Re-run restart continuity on `pnpm dev:local` with fresh turns; do not mutate the pre-fix orphan.
5. Rollback application code if needed while leaving the nullable column in place; old code ignores it.

## Open Questions

None. The elaboration fixed the authority, conflict, and migration contracts.
