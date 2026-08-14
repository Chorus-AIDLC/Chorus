## MODIFIED Requirements

### Requirement: The autonomous wake SHALL honor a pinned cwd and fall back to online-first

When a `task_assigned` or `mentioned` notification wakes an agent, the connection-selection step SHALL honor a pinned target instance if one was recorded with the trigger: it SHALL resolve the `DaemonConnection` matching the pinned `(agentUuid, host, cwd)` AND being ONLINE, and pin the session origin to it. A trigger with NO pin SHALL fall back to the existing online-first connection selection, exactly as before this change. A PINNED trigger whose pin matches NO online connection (the pinned instance is offline, or the place is not registered) SHALL create NO turn and SHALL wake NO instance: the already-recorded notification SHALL stand as the plain record (notify-only) — the wake SHALL NOT silently fall back to a different online instance, because routing a pinned wake to a cwd the user did not choose is the user-visible defect this change fixes. When the agent has NO online connection at all (pinned or not), the wake likewise SHALL create no turn and the notification SHALL stand as the plain record. There is no durable queue or backfill that holds a pinned turn until its instance comes online. The wake SHALL NOT infer a cwd from the project under any circumstance.

Beyond selecting the origin connection, the LIVE wake for a PINNED `task_assigned` or `mentioned` notification SHALL be DIRECTED so that only the daemon at the resolved online `(host, cwd)` instance wakes and answers. The server SHALL emit a `deliver_turn` control ping on the resolved target connection's `control:{connectionUuid}` channel carrying the created turn's precise `turnUuid`, reusing the existing reverse-control / pending-turn machinery that already delivers `human_instruction` turns. Because the notification SSE stream is per-agent (every online connection of the agent receives the same `new_notification`), the resolved target connection SHALL ALSO be communicated to the daemon as transport-only data on the notification the daemon reads (NOT a persisted column) so that each daemon can compare it to its own registered connection identity: a daemon whose own connection identity is NOT the resolved target SHALL suppress the broadcast wake for that pinned notification; the daemon whose connection identity IS the target SHALL wake (and the target's broadcast copy and `deliver_turn` delivery SHALL collapse to exactly one wake via the shared dedup set). A wake that resolves to NO target (a `task_assigned`/`mentioned` wake for which no pin, no online idea session-origin, and no project-owner pin resolved a target, or a pinned/offline wake for which no turn was created) SHALL behave exactly as before this change — no `deliver_turn` is emitted, no suppression occurs, and an un-pinned broadcast wakes the online-first daemon. A daemon that has not yet learned its own connection identity (before the SSE handshake completes) SHALL treat a targeted wake as "not mine" and suppress it, relying on the `deliver_turn` delivery to the actual target and the reconnect pending-turn backfill. The directed-delivery transport SHALL reuse the existing reverse control channel and pending-turn machinery (`control:{connectionUuid}` / `deliver_turn` / the connection-scoped pending-turns read); it SHALL NOT add a new transport, a new permission bit, or a schema migration. A DIRECTED wake SHALL carry the RESOLVED target connection's OWN cwd as the daemon spawn cwd (the `runtimeCwd` the daemon reads to choose where to start the agent process), NEVER a stale cwd left on the session from a previous origin, so the agent PHYSICALLY spawns in the resolved pinned cwd rather than the daemon's startup cwd or a prior cwd. When the pin itself fixed an explicit runtime cwd (a project-fixed or temporary-runtime target), that explicit runtime cwd SHALL be used; otherwise the resolved online connection's own `(host, cwd)` SHALL be used. This is required because the daemon prefers the wake's `runtimeCwd` over the receiving connection's own bound cwd when selecting the spawn working directory, so a directed wake that omitted or carried a stale `runtimeCwd` would spawn the agent in the wrong cwd even though the wake was correctly routed to the right connection.

For the session business key, a DIRECTED idea-anchored wake SHALL keep ONE conversation per idea per agent (`sessionId === directIdeaUuid`) and SHALL NOT fork a per-instance session. When the resolved online origin connection differs from the idea's existing canonical session origin (the cross-cwd case), the wake SHALL RE-POINT that canonical session's `originConnectionUuid` to the resolved online origin and create the turn on the SAME session row, so the user's turn and the daemon's transcript/turn-lifecycle reports land on the same conversation. This re-point is the second — and only other — deliberate, companyUuid-scoped reversal of the write-once `originConnectionUuid` invariant, alongside the explicit `repointSessionOriginAndSend` send path; the autonomous wake SHALL NOT create a `${directIdeaUuid}::${connectionUuid}` per-instance session. Re-pointing is safe because the daemon probes the on-disk transcript per-cwd and starts a fresh session in a new cwd rather than failing `claude --resume`; prior turns remain as read-only history on the same row. The cross-cwd re-point SHALL ALSO refresh the session's stored runtime cwd to the resolved origin connection's cwd, so a later wake that reads the stored value never re-uses the stale cwd of the previous origin. This re-point SHALL NOT add a schema migration, a new column, or a new endpoint.

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

#### Scenario: An un-pinned mention with no applicable upgrade still wakes the online-first daemon

- **GIVEN** an agent with two online instances
- **AND** a `mentioned` notification that carries no pin, whose mentioned agent is NOT the root Idea's assignee (so no idea session-origin applies) and whose owner has no project cwd preference for that project
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

#### Scenario: A directed wake spawns in the resolved connection's cwd, not a stale session cwd

- **GIVEN** an idea whose existing daemon session origin is `(Laptop-Q3, dev/ai-pm)` with a stored runtime cwd of `dev/ai-pm`
- **AND** a directed wake (an explicit `(host, cwd)` mention pin, an instance pin, or the idea session-origin upgrade) resolves to a DIFFERENT online connection `(Laptop-Q3, dev/strands)`
- **WHEN** the server emits the directed wake
- **THEN** it MUST carry `dev/strands` (the resolved connection's own cwd) as the daemon spawn `runtimeCwd`, NOT the stale `dev/ai-pm`
- **AND** the agent MUST physically spawn in `dev/strands`, not the daemon's startup cwd
- **AND** the cross-cwd re-point MUST refresh the session's stored runtime cwd to `dev/strands`

### Requirement: The proposal-writing wake SHALL be directed to the idea's existing session origin

An autonomous, idea-anchored wake SHALL be directed to the daemon instance where that idea's conversation already lives — its existing `DaemonSession.originConnectionUuid` for the idea-anchored session (`sessionId === directIdeaUuid`) — rather than fanning out to an arbitrary online instance of the agent, whenever the connection selection would otherwise fall to agent-overall online-first. This direction SHALL apply to the autonomous idea-anchored trigger family: the elaboration-resolve / "Verify Elaborate" handoff wake (`elaboration_verified`), the proposal-review wakes (`proposal_approved` and `proposal_rejected`), the idea-claimed wake (`idea_claimed`), the elaboration request/answer wakes (`elaboration_requested` / `elaboration_answered`), and the task-assignment wakes (`task_assigned` / `task_verified` / `task_reopened`) — every wake that resolves to an Idea anchor and is not already pinned. It SHALL ALSO apply to an un-pinned `mentioned` wake, anchored on the mention's **root Idea** (resolved via the shared root-idea resolver), but ONLY when the mentioned agent is that root Idea's assignee agent — i.e. the idea's existing session belongs to the mentioned agent. When the mentioned agent is a different agent, or the mention has no root Idea, this upgrade SHALL NOT apply (the idea's session origin belongs to another agent) and resolution SHALL fall through to the lower-priority steps (project-owner pin, then online-first). A `mentioned` wake that carries an explicit `(host, cwd)` pin SHALL still resolve as that hard pin and skip this upgrade. It SHALL NOT apply to a `human_instruction` wake (whose exact target session and live delivery are resolved by the instruction send path, not the wake chokepoint).

The `Idea` entity carries no pinned-instance columns, so the origin SHALL be taken from the idea's existing session. This direction SHALL apply ONLY when no higher-priority pin matched — that is, only when the connection selection is online-first; a hard mention pin or a soft assignment / idea-instance pin that resolves to an online connection takes priority and SHALL skip this upgrade, preserving the resolution order hard mention pin → soft assignment/idea-instance pin → idea session origin → agent online-first. When the idea has NO existing daemon session (it was elaborated entirely in the UI and the daemon was never woken on it), or that session's origin is offline, the wake SHALL fall back to the existing online-first selection. This wake SHALL reuse the same directed-delivery transport as the pinned `mentioned` / `task_assigned` wakes (the resolved target communicated to the daemon for broadcast suppression); it SHALL NOT introduce an Idea pin column, a new picker, a new permission bit, or a schema migration.

#### Scenario: A proposal-approval wake targets the idea's session origin

- **GIVEN** an idea with an existing daemon session whose origin is the ONLINE instance `(Laptop-Q3, dev/ai-pm)`
- **AND** the same agent also has another online instance `(Laptop-Q3, dev/strands)`
- **AND** the idea is NOT pinned to any `agent_instance`
- **WHEN** that idea's proposal is approved and the `proposal_approved` wake is dispatched
- **THEN** only the `dev/ai-pm` daemon MUST wake to handle the approval
- **AND** the `dev/strands` daemon MUST suppress the wake

#### Scenario: A proposal-rejection wake targets the idea's session origin

- **GIVEN** an idea with an existing daemon session whose origin is an ONLINE instance, the agent having another online instance, and the idea not pinned to an `agent_instance`
- **WHEN** that idea's proposal is rejected and the `proposal_rejected` wake is dispatched
- **THEN** only the daemon at the idea's session origin MUST wake to handle the rejection
- **AND** the agent's other online instance MUST suppress the wake

#### Scenario: An idea-claimed wake targets the idea's session origin

- **GIVEN** an idea with an existing online session origin and an un-pinned assignment, the agent having another online instance
- **WHEN** the `idea_claimed` wake is dispatched
- **THEN** the wake MUST be directed to the idea's session origin rather than agent-overall online-first

#### Scenario: Verify Elaborate wakes the cwd where the idea conversation already lives

- **GIVEN** an idea with an existing daemon session whose origin is the ONLINE instance `(Laptop-Q3, dev/ai-pm)`
- **AND** the same agent also has another online instance `(Laptop-Q3, dev/strands)`
- **WHEN** a human clicks "Verify Elaborate" and the `elaboration_verified` wake is dispatched
- **THEN** only the `dev/ai-pm` daemon MUST wake to write the proposal
- **AND** the `dev/strands` daemon MUST suppress the wake

#### Scenario: An instance-pinned idea takes the pin over the session origin

- **GIVEN** an idea pinned to the ONLINE `agent_instance` A
- **AND** the idea's existing daemon session origin is a DIFFERENT online instance B of the same agent
- **WHEN** a `proposal_approved` (or any autonomous idea-anchored) wake is dispatched
- **THEN** the wake MUST target instance A (the higher-priority pin)
- **AND** the session-origin upgrade MUST be skipped

#### Scenario: Falls back to online-first when no session exists

- **GIVEN** an idea that was elaborated entirely in the UI, with NO existing daemon session
- **WHEN** an autonomous idea-anchored wake (e.g. `proposal_approved` or `elaboration_verified`) is dispatched
- **THEN** the wake MUST fall back to the existing online-first selection (no target is stamped)
- **AND** the behavior MUST match the pre-change wake exactly

#### Scenario: Falls back when the idea's session origin is offline

- **GIVEN** an idea whose existing session origin instance is OFFLINE
- **AND** the agent has another online instance
- **WHEN** an autonomous idea-anchored wake is dispatched
- **THEN** it MUST fall back to online-first selection (the offline origin is not wakeable and is not queued)

#### Scenario: An un-pinned mention to the idea's assignee agent is redirected to the idea session origin

- **GIVEN** an agent that is the root Idea's assignee, with two online instances, one of which is that idea's ONLINE session origin
- **AND** a `mentioned` notification (on that idea or its comments) that carries no explicit pin
- **WHEN** the wake selects a connection
- **THEN** it MUST be redirected to the idea's session origin connection (a target is stamped and the other instance suppresses the wake) rather than agent-overall online-first

#### Scenario: An un-pinned mention to a non-assignee agent is not redirected to the idea session origin

- **GIVEN** a `mentioned` notification, carrying no explicit pin, for an agent that is NOT the root Idea's assignee agent (the idea's session belongs to a different agent)
- **WHEN** the wake selects a connection
- **THEN** the idea-session-origin upgrade MUST NOT apply (that session belongs to another agent)
- **AND** resolution MUST fall through to the project-owner-pin fallback and then to online-first

#### Scenario: A human instruction is not re-targeted by the wake chokepoint

- **WHEN** a `human_instruction` wake is processed at the notification chokepoint
- **THEN** the chokepoint MUST NOT apply the idea-session-origin upgrade to it
- **AND** its target and live delivery MUST come solely from the instruction send path
