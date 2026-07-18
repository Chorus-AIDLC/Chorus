## ADDED Requirements

### Requirement: The conversation-list running indicator SHALL agree with the composer's Interrupt control

The daemon conversation-list row's live status indicator (running / interrupted / error / idle) SHALL be derived from the SAME set of executions that the conversation's composer resolves for its Interrupt control — i.e. the origin-connection slice PREFERRED, with a fallback to every other connection slice when the origin slice has no execution matching this conversation. The match SHALL be strictly by this conversation's own idea anchor (`directIdeaUuid`, or the `::`-prefix heal for a legacy residual session) or its `daemon_session:<sessionId>` id, so a cross-connection match still belongs to this conversation only and SHALL NOT borrow another conversation's execution. As a result, the list row's indicator and the composer's Interrupt control SHALL never disagree: whenever the composer can offer Interrupt for a running turn, the list row SHALL show the running indicator, including after a `cwd`/agent switch or a session re-point that moved the running turn to a connection other than the conversation's origin.

#### Scenario: Running turn on the origin connection lights the row

- **GIVEN** an open agent's conversation whose running `DaemonExecution` is on the conversation's own origin connection
- **WHEN** the conversation list renders that row
- **THEN** the row's status indicator MUST read `running`

#### Scenario: Running turn on a non-origin connection still lights the row

- **GIVEN** a conversation whose origin-connection slice has NO matching execution but whose idea's running `DaemonExecution` lives on a DIFFERENT connection of the agent (after a cwd/agent switch or a session re-point)
- **WHEN** the conversation list renders that row
- **THEN** the row's status indicator MUST read `running` (agreeing with the composer's Interrupt control), NOT idle

#### Scenario: The row never borrows an unrelated conversation's run

- **GIVEN** another conversation's running `DaemonExecution` on a different connection, with no execution matching THIS conversation on any connection
- **WHEN** the conversation list renders THIS conversation's row
- **THEN** the row's status indicator MUST read idle (null) — the unrelated run MUST NOT be borrowed

#### Scenario: A user-interrupt on the fallback connection is reflected

- **GIVEN** a conversation whose origin slice has no match but whose matching execution on another connection is `interrupted` with reason `user`
- **WHEN** the conversation list renders that row
- **THEN** the row's status indicator MUST read `interrupted` (resumable); a crash-interrupt MUST read `error`
