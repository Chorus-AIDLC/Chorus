## MODIFIED Requirements

### Requirement: The autonomous wake SHALL honor a pinned cwd and fall back to online-first

When a `task_assigned` or `mentioned` notification wakes an agent, the connection-selection step SHALL honor a pinned target instance if one was recorded with the trigger: it SHALL resolve the `DaemonConnection` matching the pinned `(agentUuid, host, cwd)` AND being ONLINE, and pin the session origin to it. A trigger with NO pin SHALL fall back to the existing online-first connection selection, exactly as before this change. A PINNED trigger whose pin matches NO online connection (the pinned instance is offline, or the place is not registered) SHALL create NO turn and SHALL wake NO instance: the already-recorded notification SHALL stand as the plain record (notify-only) — the wake SHALL NOT silently fall back to a different online instance, because routing a pinned wake to a cwd the user did not choose is the user-visible defect this change fixes. When the agent has NO online connection at all (pinned or not), the wake likewise SHALL create no turn and the notification SHALL stand as the plain record. There is no durable queue or backfill that holds a pinned turn until its instance comes online. The wake SHALL NOT infer a cwd from the project under any circumstance.

Beyond selecting the origin connection, the LIVE wake for a PINNED `task_assigned` or `mentioned` notification SHALL be DIRECTED so that only the daemon at the resolved online `(host, cwd)` instance wakes and answers. The server SHALL emit a `deliver_turn` control ping on the resolved target connection's `control:{connectionUuid}` channel carrying the created turn's precise `turnUuid`, reusing the existing reverse-control / pending-turn machinery that already delivers `human_instruction` turns. Because the notification SSE stream is per-agent (every online connection of the agent receives the same `new_notification`), the resolved target connection SHALL ALSO be communicated to the daemon as transport-only data on the notification the daemon reads (NOT a persisted column) so that each daemon can compare it to its own registered connection identity: a daemon whose own connection identity is NOT the resolved target SHALL suppress the broadcast wake for that pinned notification; the daemon whose connection identity IS the target SHALL wake (and the target's broadcast copy and `deliver_turn` delivery SHALL collapse to exactly one wake via the shared dedup set). A wake that carries NO resolved target (an un-pinned `task_assigned`/`mentioned`, or a pinned/offline wake for which no turn was created) SHALL behave exactly as before this change — no `deliver_turn` is emitted, no suppression occurs, and an un-pinned broadcast wakes the online-first daemon. A daemon that has not yet learned its own connection identity (before the SSE handshake completes) SHALL treat a targeted wake as "not mine" and suppress it, relying on the `deliver_turn` delivery to the actual target and the reconnect pending-turn backfill. The directed-delivery transport SHALL reuse the existing reverse control channel and pending-turn machinery (`control:{connectionUuid}` / `deliver_turn` / the connection-scoped pending-turns read); it SHALL NOT add a new transport, a new permission bit, or a schema migration.

#### Scenario: A pinned online instance is honored at wake time

- **GIVEN** a `task_assigned` notification whose assignment pinned `(Laptop-Q3, dev/chorus)`
- **AND** an ONLINE connection matching that `(agent, host, cwd)` exists
- **WHEN** the wake selects a connection
- **THEN** it MUST pin the session origin to that matching online connection rather than the first online connection

#### Scenario: A pin matching an offline instance wakes no instance (notify-only)

- **GIVEN** a `mentioned` (or `task_assigned`) wake whose pin matches an OFFLINE connection while another instance of the same agent is online
- **WHEN** the wake resolves its target
- **THEN** it MUST create no turn and wake NO instance (the already-recorded notification stands as the plain record)
- **AND** it MUST NOT silently fall back to the other online instance (routing to an unchosen cwd is the defect being fixed)
- **AND** the pinned turn MUST NOT be queued or backfilled to wait for the pinned instance to come online

#### Scenario: An unpinned wake uses online-first as before

- **GIVEN** a wake notification that carries no pinned instance
- **WHEN** the wake selects a connection
- **THEN** it MUST select the first online connection exactly as before this change, with no cwd inference from the project

#### Scenario: Only the pinned daemon wakes when two instances are online

- **GIVEN** an agent with two ONLINE instances, `(Laptop-Q3, dev/ai-pm)` and `(Laptop-Q3, dev/strands)`
- **AND** a `mentioned` notification pinned to `(Laptop-Q3, dev/ai-pm)`
- **WHEN** both daemons receive the agent-wide `new_notification` broadcast
- **THEN** only the `dev/ai-pm` daemon MUST wake and answer
- **AND** the `dev/strands` daemon MUST suppress the wake because it is not the resolved target

#### Scenario: An un-pinned mention still wakes the online-first daemon

- **GIVEN** an agent with two online instances
- **AND** a `mentioned` notification that carries no pin
- **WHEN** both daemons receive the broadcast
- **THEN** the wake MUST proceed exactly as before this change (no target is stamped, so no suppression occurs and the online-first daemon answers)

#### Scenario: A daemon that has not yet registered suppresses a targeted wake

- **GIVEN** a pinned `mentioned` notification carrying a resolved target connection
- **AND** a daemon that has not yet learned its own connection identity (handshake incomplete)
- **WHEN** that daemon receives the broadcast
- **THEN** it MUST treat the targeted wake as "not mine" and suppress it
- **AND** delivery MUST rely on the precise reverse-channel delivery / reconnect pending-turn backfill to the actual target

#### Scenario: A cross-cwd mention opens a per-instance session rather than re-pointing

- **GIVEN** an idea whose existing daemon session origin is `(Laptop-Q3, dev/ai-pm)`
- **AND** a new `mentioned` pin resolves to a different online instance `(Laptop-Q3, dev/strands)`
- **WHEN** the wake creates the turn
- **THEN** it MUST target a per-instance session for `(Laptop-Q3, dev/strands)` with its own cwd-bound transcript
- **AND** it MUST NOT re-point the existing `dev/ai-pm` session's origin to `dev/strands` (which would fail `claude --resume` with "No conversation found")

## ADDED Requirements

### Requirement: The proposal-writing wake SHALL be directed to the idea's existing session origin

When a human verifies an idea's elaboration (the "Verify Elaborate" action) and the resulting `elaboration_verified` wake dispatches the idea's assigned daemon agent to write the proposal, the live wake SHALL be directed to the daemon instance where that idea's conversation already lives — its existing `DaemonSession.originConnectionUuid` for the idea-anchored session — rather than fanning out to every online instance of the agent. The `Idea` entity carries no pinned-instance columns, so the origin SHALL be taken from the idea's existing session; when the idea has NO existing daemon session (it was elaborated entirely in the UI and the daemon was never woken on it), or that session's origin is offline, the wake SHALL fall back to the existing online-first selection. This wake SHALL reuse the same directed-delivery transport as the pinned `mentioned`/`task_assigned` wakes (the resolved target communicated to the daemon for broadcast suppression); it SHALL NOT introduce an Idea pin column, a new picker, a new permission bit, or a schema migration.

#### Scenario: Verify Elaborate wakes the cwd where the idea conversation already lives

- **GIVEN** an idea with an existing daemon session whose origin is the ONLINE instance `(Laptop-Q3, dev/ai-pm)`
- **AND** the same agent also has another online instance `(Laptop-Q3, dev/strands)`
- **WHEN** a human clicks "Verify Elaborate" and the `elaboration_verified` wake is dispatched
- **THEN** only the `dev/ai-pm` daemon MUST wake to write the proposal
- **AND** the `dev/strands` daemon MUST suppress the wake

#### Scenario: Verify Elaborate falls back to online-first when no session exists

- **GIVEN** an idea that was elaborated entirely in the UI, with NO existing daemon session
- **WHEN** a human clicks "Verify Elaborate" and the wake is dispatched
- **THEN** the wake MUST fall back to the existing online-first selection (no target is stamped)
- **AND** the behavior MUST match the pre-change proposal-writing wake exactly

#### Scenario: Verify Elaborate falls back when the idea's session origin is offline

- **GIVEN** an idea whose existing session origin instance is OFFLINE
- **AND** the agent has another online instance
- **WHEN** the `elaboration_verified` wake is dispatched
- **THEN** it MUST fall back to online-first selection (the offline origin is not wakeable and is not queued)
