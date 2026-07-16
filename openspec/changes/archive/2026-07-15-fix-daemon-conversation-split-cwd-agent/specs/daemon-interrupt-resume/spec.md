## ADDED Requirements

### Requirement: The chat SHALL let a user interrupt the idea's running turn from any thread

The daemon chat surface SHALL derive the composer's controllable (interruptible / resumable) execution for an idea-anchored conversation by matching the idea's running execution across ALL of the agent's live connection slices, not only the viewed session's `originConnectionUuid` slice. An execution matches the idea when `exec.entityType === "idea" && exec.entityUuid === ideaUuid`, OR `exec.directIdeaUuid === ideaUuid` (covering child task / proposal / document wakes whose direct idea IS this conversation's idea). The idea uuid SHALL be the viewed session's `directIdeaUuid` when present. Because the interrupt control request carries `exec.connectionUuid`, `exec.entityType`, and `exec.entityUuid` taken verbatim from the matched execution, a match found on a different connection (or belonging to a different `(agentUuid, sessionId)` conversation row for the same idea) SHALL still interrupt the correct running subprocess with no server, endpoint, permission, or schema change. The match SHALL be strictly by the DIRECT idea, never the root idea, so a sibling idea's running turn is never interrupted.

#### Scenario: Interrupt reaches the running turn after a cwd switch

- **GIVEN** an idea whose conversation is viewed on screen
- **AND** the idea's running turn executes on a different connection than the viewed session's origin
- **WHEN** the composer derives its controllable execution
- **THEN** it MUST find the idea's running execution across all connection slices
- **AND** the Interrupt control MUST render and, when pressed, MUST target that execution's own `connectionUuid` / `entityType` / `entityUuid` so the running subprocess is stopped

#### Scenario: Interrupt reaches the running turn after an agent switch

- **GIVEN** an idea reassigned from agent A to agent B, where A still has a running turn on its own `(A, idea)` conversation row
- **AND** the user is viewing agent B's conversation for the same idea
- **WHEN** the composer derives its controllable execution for the idea
- **THEN** it MUST match agent A's running `idea:<ideaUuid>` execution and expose an Interrupt control that stops it

#### Scenario: A sibling idea's running turn is never interrupted

- **GIVEN** two distinct ideas each with a running turn
- **WHEN** the composer for one idea's conversation derives its controllable execution
- **THEN** it MUST match only executions whose `entityUuid` or `directIdeaUuid` equals THIS idea's uuid
- **AND** it MUST NOT match the sibling idea's running execution

### Requirement: The per-conversation interrupt match SHALL tolerate the legacy residual per-instance session key

For fix-forward compatibility with residual per-instance sessions created before the fork was removed, when a conversation has `directIdeaUuid === null` AND its `sessionId` contains the `::` separator (the legacy `${ideaUuid}::${connectionUuid}` key), the per-conversation execution match SHALL derive the idea uuid from the `::`-prefix (`sessionId.split("::")[0]`) and match the idea's executions on that derived uuid — the same `::`-split the daemon router already uses for notification matching. A genuinely ad-hoc conversation (a random `sessionId` with no `::` and `directIdeaUuid === null`) SHALL keep the existing ad-hoc match (`exec.entityType === "daemon_session" && exec.entityUuid === sessionId`) unchanged. This heal SHALL be UI-only and SHALL NOT migrate, merge, or rewrite any DaemonSession row.

#### Scenario: A legacy residual thread regains a working interrupt

- **GIVEN** a residual conversation with `directIdeaUuid === null` and `sessionId === "<ideaUuid>::<connUuid>"`
- **AND** the idea's turn is running (reported by the daemon as `idea:<ideaUuid>`)
- **WHEN** the composer derives its controllable execution for that residual conversation
- **THEN** it MUST derive the idea uuid from the `::`-prefix and match the running `idea:<ideaUuid>` execution
- **AND** the Interrupt control MUST render and stop the running subprocess

#### Scenario: A genuinely ad-hoc conversation keeps its own match

- **GIVEN** an ad-hoc conversation whose `sessionId` is a random uuid with no `::` and `directIdeaUuid === null`
- **WHEN** the composer derives its controllable execution
- **THEN** it MUST match only its own `daemon_session:<sessionId>` execution as before, with no idea-prefix derivation
