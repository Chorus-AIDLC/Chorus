## Why

When a second `chorus daemon` is started on the **same machine, same cwd, and same agent identity** (a forgotten resident daemon, a systemd unit racing a manual start, or a second terminal), the server `registerConnection` upsert silently **overwrites (takes over)** the existing connection row — `connectedAt` / `lastSeenAt` / `status` are all refreshed with **no warning** and **no liveness check**. Two daemon processes then both believe they hold the connection and race for the same task-dispatch / reverse-control channel, causing duplicate wakes, duplicate execution, and tangled transcripts. The operator gets no signal that they started a second, conflicting daemon. The fix is to detect a still-alive incumbent and **warn + skip** instead of silently preempting it.

## What Changes

- **Server-side conflict detection in `registerConnection`.** Before writing, the server checks for an existing **fresh** (effectively-online) connection at the same `(agentUuid, host, cwd)` triple — **regardless of `clientType`** — whose self-reported process identity (`startedAt`) **differs** from the incoming report. When that holds, the registration is a **conflict**: the server returns a conflict signal and **writes nothing** (no upsert, no row refresh).
- **A new `connection_conflict` SSE data event.** On a detected conflict the notification route emits a `connection_conflict` event (distinct from `connection_registered`) carrying the conflicting `host` / `cwd`, instead of the usual `connection_registered`.
- **Daemon warn + skip per cwd.** On receiving `connection_conflict` for one of its path-connections, the daemon prints a prominent **WARNING** (naming host + cwd + that a live daemon already serves it), tears that one cwd's SSE listener down, and **does not reconnect or re-probe it** for the life of the process.
- **Partial vs. total conflict.** A multi-path daemon keeps serving its **non-conflicting** cwds normally; only the conflicting paths are skipped. If **every** declared path conflicts (no connection survives), the daemon process **exits non-zero** with a clear message rather than lingering as a zombie that serves nothing.
- **Server-side structured log** on each rejected (conflicting) registration, carrying `companyUuid` / `agentUuid` / `host` / `cwd` / incumbent-vs-incoming `startedAt`, so a conflict is diagnosable even when the second daemon's stderr lands in a different journal.
- **Preserved paths (no regression):** stale-connection takeover (incumbent dead / `>90s` no heartbeat) and same-process reconnect (same `startedAt`) both continue to refresh the row as today. The legacy `cwd = null` branch (old daemons that don't self-report cwd, HARD-1) is **explicitly exempt** from conflict detection.
- **No schema migration.** Detection reuses the already-persisted `startedAt`, `status`, and `lastSeenAt` columns — no new column, no `instanceId`.

## Capabilities

### New Capabilities
- _(none)_ — this change extends two existing capabilities; it introduces no new spec.

### Modified Capabilities
- `daemon-connection-registry`: adds a conflict-detection requirement to the registration lifecycle — a fresh, different-process incumbent at the same `(agent, host, cwd)` causes the registration to be skipped (nothing written) and a conflict signalled, while stale takeover and same-process reconnect are preserved and the `cwd = null` branch is exempt. Adds the server-side structured conflict log.
- `cli-daemon`: adds a requirement that the daemon warns and permanently skips a conflicting path-connection (no reconnect/re-probe), keeps serving non-conflicting paths, and exits non-zero when all declared paths conflict.

## Impact

- **Code:**
  - `src/services/daemon-connection.service.ts` — conflict pre-check in `registerConnection` (real-cwd path only); a typed conflict result distinct from a successful `ConnectionHandle`; structured warn log.
  - `src/app/api/events/notifications/route.ts` (and, for symmetry, `src/app/api/events/route.ts`) — emit `connection_conflict` instead of `connection_registered` when registration reports a conflict.
  - `cli/sse-listener.mjs` — parse the `connection_conflict` event and surface it via a new `onConflict` callback (forked before `onEvent`, like `connection_registered` / `control`, so it never reaches the wake router).
  - `cli/daemon.mjs` — per-connection conflict handler that disconnects that cwd's listener without scheduling a reconnect; process-level bookkeeping that exits non-zero when no connection survives; banner/log lines that name skipped cwds.
- **APIs / contracts:** no REST or MCP surface change; only a new SSE data-event `type`. Browser `EventSource` clients ignore the unrecognized `type` (same as `connection_registered` / `control` today).
- **Data:** no Prisma schema change; no migration.
- **Behavioral compatibility:** old daemons (no `startedAt`, `cwd = null`) behave exactly as before; single-daemon reconnect and crash-restart takeover are unchanged.
- **Adjacency:** orthogonal to the daemon.json field-merge / auto-start series (`2fbef34d`, `e6ecb2c`), which guard "config not lost"; this idea guards "duplicate process does not silently preempt."
