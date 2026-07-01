# daemon-cwd-instance-addressing Specification

## MODIFIED Requirements

### Requirement: The proposal-writing wake SHALL be directed to the idea's existing session origin

An autonomous, idea-anchored wake SHALL be directed to the daemon instance where that idea's conversation already lives — its existing `DaemonSession.originConnectionUuid` for the idea-anchored session (`sessionId === directIdeaUuid`) — rather than fanning out to an arbitrary online instance of the agent, whenever the connection selection would otherwise fall to agent-overall online-first. This direction SHALL apply to the autonomous idea-anchored trigger family: the elaboration-resolve / "Verify Elaborate" handoff wake (`elaboration_verified`), the proposal-review wakes (`proposal_approved` and `proposal_rejected`), the idea-claimed wake (`idea_claimed`), the elaboration request/answer wakes (`elaboration_requested` / `elaboration_answered`), and the task-assignment wakes (`task_assigned` / `task_verified` / `task_reopened`) — every wake that resolves to an Idea anchor and is not already pinned. It SHALL NOT apply to a `mentioned` wake (an un-pinned mention is contractually a broadcast → online-first wake, and a pinned mention is resolved as a hard pin) nor to a `human_instruction` wake (whose exact target session and live delivery are resolved by the instruction send path, not the wake chokepoint).

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

#### Scenario: An un-pinned mention is not redirected to the idea session origin

- **GIVEN** an agent with two online instances, one of which is the origin of some idea's session
- **AND** a `mentioned` notification that carries no pin
- **WHEN** the wake selects a connection
- **THEN** it MUST select the online-first connection with NO target stamped (broadcast), exactly as before this change
- **AND** it MUST NOT be redirected to any idea's session origin

#### Scenario: A human instruction is not re-targeted by the wake chokepoint

- **WHEN** a `human_instruction` wake is processed at the notification chokepoint
- **THEN** the chokepoint MUST NOT apply the idea-session-origin upgrade to it
- **AND** its target and live delivery MUST come solely from the instruction send path
