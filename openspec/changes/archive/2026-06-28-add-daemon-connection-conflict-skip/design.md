# Design: Daemon connection conflict — warn + skip

## Overview

The `DaemonConnection` registry keys a row on the composite unique
`(agentUuid, clientType, host, cwd)`. A second daemon started under the *same*
key issues a byte-identical upsert `where`, so today `registerConnection`
silently refreshes (takes over) the incumbent's row. The problem: at the key
level, **"another live daemon process is preempting"** and **"the same daemon
dropped and reconnected"** are indistinguishable — so we cannot reject on
"key exists and is fresh" alone without breaking normal reconnect.

The discriminator is a **process identity**: the self-reported `startedAt`
(`PROCESS_STARTED_AT`, captured once at daemon module load and re-sent verbatim
on every reconnect). Detection therefore reduces to a small truth table over
`(incumbent freshness, startedAt equality)`.

Two decisions from elaboration shape this design and are treated as fixed:

- **DEC-1 (Q1 = startedAt only).** Process identity is `startedAt` alone — no new
  `instanceId` column, no pid. Minimal change; accepted cost is that two daemons
  started in the *same millisecond* are indistinguishable and the later one is
  allowed to refresh (treated as a reconnect). This is vanishingly rare and
  fails safe toward today's behavior.
- **DEC-2 (Q2 = `(agent, host, cwd)` triple, clientType-agnostic).** Conflict is
  judged across **all** client types at the same `(agent, host, cwd)`, not just
  the same `(agent, clientType, host, cwd)` row. Running two backends
  (claude_code + codex) in the *same* cwd under the *same* agent is therefore
  **not a supported configuration** — both would be woken by the same
  `notification:agent:<uuid>` batch and double-execute, which is exactly the
  harm this change exists to prevent. This grain is consistent with the existing
  `AgentInstance` unique key `(companyUuid, agentUuid, host, cwd)`, which already
  omits `clientType` — from the addressing/wake perspective the two backends are
  already "the same instance."

## Detection rule (server, `registerConnection`)

Applied **only on the real-cwd path** (`cwd !== null`). Let the incoming report
carry `startedAt = S_new` for identity `(agent, host, cwd)`.

1. Query for any existing connection row at `(agentUuid, host, cwd)` — **across
   all clientTypes** (DEC-2) — that is **effectively online**: `status = "online"`
   AND `now - lastSeenAt <= STALE_THRESHOLD_MS` (90s; reuse the exported constant,
   never re-derive it).
2. Branch:
   - **No fresh incumbent** → not a conflict. Proceed with the normal upsert /
     instance-link path exactly as today (this covers both first-connect and
     **stale takeover** — the incumbent dead/`>90s` silent).
   - **Fresh incumbent, `startedAt === S_new`** → **same process reconnect**.
     Not a conflict; proceed with the normal refresh. (Preserves reconnect
     semantics 1:1.)
   - **Fresh incumbent, `startedAt !== S_new`** (including incumbent
     `startedAt = null` vs. a non-null `S_new`, and vice-versa) → **CONFLICT**.
     Return a conflict signal and **write nothing**.

### Truth table

| Incumbent at (agent,host,cwd) | startedAt vs incoming | Verdict |
|---|---|---|
| none | — | register (first connect) |
| stale (`>90s` or `status≠online`) | any | register (takeover) |
| fresh | equal | refresh (same-process reconnect) |
| fresh | different (incl. one null) | **conflict → skip, write nothing** |

> **Null-startedAt edge (confirmed with requester):** a fresh incumbent whose
> `startedAt` is null, faced with a non-null incoming `startedAt` (or the
> reverse), counts as **different → conflict → skip**. Rationale: prefer
> non-preemption; a fresh row we cannot prove is "us" is treated as someone
> else's. In practice every current daemon self-reports `startedAt`, so this is a
> defensive corner, not a common path.

## Load-bearing invariant — a skipped registration writes nothing

This is the crux and the easiest thing to get subtly wrong. Because the only
discriminator is `startedAt` (DEC-1), the incumbent's own reconnect must keep
matching itself. If a *rejected* second daemon were allowed to write or refresh
the row (even just `lastSeenAt`), it would pollute the very comparison the
incumbent relies on. Therefore:

- The conflict branch returns a distinct result **before any `upsert` / `update`
  / `create`** — no row mutation, no `AgentInstance` upsert, nothing.
- `registerConnection`'s return type widens to express three outcomes without
  conflating them:
  - **success** → `ConnectionHandle { uuid, connectedAt }` (unchanged shape);
  - **conflict** → a sentinel the route can distinguish from success (e.g.
    `{ conflict: true, host, cwd }`), so the route emits `connection_conflict`
    and the existing lifecycle (heartbeat `touch`, `markDisconnected`,
    execution reconcile) is **not** wired up for a connection that was never
    registered;
  - **null** → unchanged: not a daemon clientType, or a swallowed write failure.
- The existing **swallow-and-log** contract for genuine write *failures* is
  unchanged. A conflict is **not** an error — it is a normal, expected outcome
  with its own signal; it must not be logged as a failure, but it **does** get a
  structured `warn` (Q6) so it is diagnosable.

## Server → daemon signal: `connection_conflict`

- The notification route (`/api/events/notifications`) today emits a
  `connection_registered` data event once the row is registered. When
  `registerConnection` returns the **conflict** sentinel, the route instead emits
  a single `connection_conflict` data event:
  `{ type: "connection_conflict", host, cwd }`. It does **not** emit
  `connection_registered`, does **not** subscribe the control channel, and does
  **not** start the heartbeat for that stream (there is no row to touch).
- Symmetric handling is added to `/api/events` for consistency, though the daemon
  only uses the notification endpoint.
- The event is a normal SSE `data:` line; browser `EventSource` clients ignore
  the unrecognized `type`, exactly as they already ignore `connection_registered`
  and `control`.

## Daemon side: warn, skip, no-retry, conditional exit

In `cli/sse-listener.mjs`, mirror the existing fork for `connection_registered` /
`control`: a `connection_conflict` event is parsed and routed to a new
`onConflict(event)` callback **before** `onEvent`, so it can never reach the wake
router / WakeQueue (Module Contract: a conflict is not a wake).

In `cli/daemon.mjs`'s per-connection closure (`buildConnection(cwd, index)`):

- **Warn + skip (Q3 partial / Q4 no-retry).** `onConflict` logs a prominent
  WARNING naming `host` + `cwd` and the fact that a live daemon already serves
  this path, then calls the listener's `disconnect()` (which clears the reconnect
  timer and aborts) and marks this connection **permanently skipped** — it is
  never reconnected or re-probed for the life of the process. Stale-takeover of
  this path happens only on the **next daemon start / restart** (a fresh process
  with a fresh `startedAt`), never via background re-probe.
- **Non-conflicting paths unaffected (Q3).** Each connection is an independent
  closure with its own listener/router/backfill, so skipping one cwd leaves the
  others serving normally.
- **All-conflict exit (Q3).** A small process-level latch counts how many of the
  declared connections ended in a conflict vs. successfully registered. When the
  set of declared paths resolves such that **none** registered and **at least
  one** conflicted, the daemon prints a clear "all N paths are already served by
  a live daemon — nothing to do" line and exits **non-zero**. Because conflict is
  reported asynchronously over SSE (not at `start()` return), the latch resolves
  after each connection reaches a terminal state (registered or conflict); the
  exit fires once every declared connection has resolved and none survived.
- **Banner / startup output.** The served-paths line already printed at startup
  is complemented by a per-skip WARNING; skipped cwds are named so an operator
  sees at a glance which path was surrendered and why.

## cwd = null exemption (Q5 / HARD-1)

The legacy `cwd = null` branch in `registerConnection` (old daemons that don't
self-report cwd) is **explicitly exempt** from conflict detection — it keeps
today's `findFirst → update / create` refresh-or-takeover behavior verbatim.
Justification: a daemon carrying this feature always self-reports a real cwd and
never lands on the null branch; an old daemon neither sends `startedAt` nor can
act on a `connection_conflict` event, so adding detection there could only break
its reconnect. The null branch is left untouched.

## Module contracts

1. **`registerConnection` outcome is tri-state.** Callers MUST distinguish
   success / conflict / null and MUST NOT treat conflict as either a handle or a
   failure. Only success wires up `touch` / `markDisconnected` / execution
   reconcile.
2. **Conflict signal is forked before the wake path.** `connection_conflict`,
   like `connection_registered` and `control`, MUST be consumed in
   `#processMessage` and MUST NOT fall through to `onEvent`.
3. **Skip is terminal for that cwd.** Once a path-connection is marked
   conflicted, the daemon MUST NOT reconnect or re-probe it within the process
   lifetime (Q4).
4. **Liveness threshold is shared.** Conflict freshness MUST use the exported
   `STALE_THRESHOLD_MS` and the same `status === "online" && fresh` rule the read
   projection (`toConnectionView`) uses — producer and consumer never drift.

## Risks & mitigations

- **R1 — Rejected daemon pollutes the comparison row.** Mitigated by the
  load-bearing invariant: the conflict branch returns before any write. Covered
  by a test asserting the incumbent row's `connectedAt` / `lastSeenAt` are
  unchanged after a conflicting registration.
- **R2 — Breaking normal reconnect.** Same-`startedAt` fresh incumbent is
  explicitly the reconnect path and refreshes as before. Covered by a regression
  test (fresh + same startedAt → refresh, not conflict).
- **R3 — Breaking crash-restart.** A crashed daemon's row goes stale within the
  90s window; stale incumbents are always takeable. Covered by a test
  (stale incumbent + different startedAt → register/takeover).
- **R4 — Same-millisecond start collision (DEC-1 cost).** Accepted and
  documented; fails safe toward refresh. No mitigation beyond documentation,
  since adding an `instanceId` was explicitly declined.
- **R5 — All-conflict exit racing async SSE.** The exit latch only fires after
  every declared connection has reached a terminal state; a connection still
  awaiting its handshake does not trigger a premature exit.
- **R6 — Cross-tenant / cross-agent false positive.** The conflict query is
  scoped by `agentUuid` (and implicitly company via the authenticated context),
  so a different agent or company on the same host+cwd never collides.

## Out of scope

- Adding an `instanceId` / pid to the registry (declined — DEC-1).
- Auto-takeover of a conflicting path by background re-probe (declined — Q4).
- Supporting two backends in the same cwd as a first-class configuration
  (explicitly unsupported — DEC-2).
- Any change to the daemon.json field-merge / auto-start behavior (orthogonal).
