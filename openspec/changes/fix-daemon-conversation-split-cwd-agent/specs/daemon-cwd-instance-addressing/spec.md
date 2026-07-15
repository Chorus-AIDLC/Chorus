## MODIFIED Requirements

### Requirement: The autonomous wake SHALL honor a pinned cwd and fall back to online-first

When a `task_assigned` or `mentioned` notification wakes an agent, the connection-selection step SHALL honor a pinned target instance if one was recorded with the trigger: it SHALL resolve the `DaemonConnection` matching the pinned `(agentUuid, host, cwd)` AND being ONLINE, and pin the session origin to it. A trigger with NO pin SHALL fall back to the existing online-first connection selection, exactly as before this change. A PINNED trigger whose pin matches NO online connection (the pinned instance is offline, or the place is not registered) SHALL create NO turn and SHALL wake NO instance: the already-recorded notification SHALL stand as the plain record (notify-only) — the wake SHALL NOT silently fall back to a different online instance, because routing a pinned wake to a cwd the user did not choose is the user-visible defect this change fixes. When the agent has NO online connection at all (pinned or not), the wake likewise SHALL create no turn and the notification SHALL stand as the plain record. There is no durable queue or backfill that holds a pinned turn until its instance comes online. The wake SHALL NOT infer a cwd from the project under any circumstance.

Beyond selecting the origin connection, the LIVE wake for a PINNED `task_assigned` or `mentioned` notification SHALL be DIRECTED so that only the daemon at the resolved online `(host, cwd)` instance wakes and answers. The server SHALL emit a `deliver_turn` control ping on the resolved target connection's `control:{connectionUuid}` channel carrying the created turn's precise `turnUuid`, reusing the existing reverse-control / pending-turn machinery that already delivers `human_instruction` turns. Because the notification SSE stream is per-agent (every online connection of the agent receives the same `new_notification`), the resolved target connection SHALL ALSO be communicated to the daemon as transport-only data on the notification the daemon reads (NOT a persisted column) so that each daemon can compare it to its own registered connection identity: a daemon whose own connection identity is NOT the resolved target SHALL suppress the broadcast wake for that pinned notification; the daemon whose connection identity IS the target SHALL wake (and the target's broadcast copy and `deliver_turn` delivery SHALL collapse to exactly one wake via the shared dedup set). A wake that carries NO resolved target (an un-pinned `task_assigned`/`mentioned`, or a pinned/offline wake for which no turn was created) SHALL behave exactly as before this change — no `deliver_turn` is emitted, no suppression occurs, and an un-pinned broadcast wakes the online-first daemon. A daemon that has not yet learned its own connection identity (before the SSE handshake completes) SHALL treat a targeted wake as "not mine" and suppress it, relying on the `deliver_turn` delivery to the actual target and the reconnect pending-turn backfill. The directed-delivery transport SHALL reuse the existing reverse control channel and pending-turn machinery (`control:{connectionUuid}` / `deliver_turn` / the connection-scoped pending-turns read); it SHALL NOT add a new transport, a new permission bit, or a schema migration.

For the session business key, a DIRECTED idea-anchored wake SHALL keep ONE conversation per idea per agent (`sessionId === directIdeaUuid`) and SHALL NOT fork a per-instance session. When the resolved online origin connection differs from the idea's existing canonical session origin (the cross-cwd case), the wake SHALL RE-POINT that canonical session's `originConnectionUuid` to the resolved online origin and create the turn on the SAME session row, so the user's turn and the daemon's transcript/turn-lifecycle reports land on the same conversation. This re-point is the second — and only other — deliberate, companyUuid-scoped reversal of the write-once `originConnectionUuid` invariant, alongside the explicit `repointSessionOriginAndSend` send path; the autonomous wake SHALL NOT create a `${directIdeaUuid}::${connectionUuid}` per-instance session. Re-pointing is safe because the daemon probes the on-disk transcript per-cwd and starts a fresh session in a new cwd rather than failing `claude --resume`; prior turns remain as read-only history on the same row. This re-point SHALL NOT add a schema migration, a new column, or a new endpoint.

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

#### Scenario: A cross-cwd directed idea wake re-points the canonical session instead of forking

- **GIVEN** an idea whose existing daemon session origin is the ONLINE-or-offline instance `(Laptop-Q3, dev/ai-pm)` and whose session has `sessionId === directIdeaUuid`
- **AND** a directed idea-anchored wake (e.g. a pinned `task_assigned`, or a `human_instruction` resolved to a different instance) resolves to a different ONLINE instance `(Laptop-Q3, dev/strands)`
- **WHEN** the wake creates the turn
- **THEN** it MUST re-point the SAME canonical session's `originConnectionUuid` to `(Laptop-Q3, dev/strands)` and create the turn on that same session row (keeping `sessionId === directIdeaUuid`, `directIdeaUuid` non-null)
- **AND** it MUST NOT create a `${directIdeaUuid}::${connectionUuid}` per-instance session
- **AND** the user's turn and the daemon's later transcript/turn-lifecycle reports MUST land on the same conversation so the running turn is interruptible from the thread the user is viewing
