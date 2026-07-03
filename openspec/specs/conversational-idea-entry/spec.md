# conversational-idea-entry Specification

## Purpose
TBD - created by archiving change add-conversational-idea-entry. Update Purpose after archive.
## Requirements
### Requirement: The create-idea modal SHALL offer a conversational mode when online daemon connections exist
The create-idea modal SHALL keep the static form as its default mode and SHALL show an explicit switch into a conversational mode. The switch SHALL be enabled only when at least one daemon connection with `effectiveStatus === "online"` is visible via the agent presence context; online detection SHALL reuse the presence context (no separate polling) and SHALL treat an absent presence context the same as zero online connections. When the modal is opened in derive-child mode (a `parentUuid` is set), the conversational switch SHALL NOT be shown.

#### Scenario: Online daemon present
- **WHEN** the create-idea modal opens and the presence context reports at least one online daemon connection
- **THEN** the modal shows the static form by default with an enabled switch into conversational mode

#### Scenario: No online daemon
- **WHEN** the create-idea modal opens and no daemon connection is online (or the presence context is unavailable)
- **THEN** the conversational switch is visible but disabled, with a hint explaining no daemon is online and how to start one

#### Scenario: Derive-child mode
- **WHEN** the create-idea modal opens with a parent idea preset (derive-child mode)
- **THEN** only the static form is offered and no conversational switch is rendered

### Requirement: The offline hint SHALL reuse the shared daemon-connect guidance without hardcoding the command in i18n
The disabled-state hint SHALL present the daemon startup guidance by composing the shared daemon-connect CTA (or by interpolating the shared `DAEMON_START_COMMAND` constant as a message parameter). The command literal SHALL NOT appear inside any i18n message string.

#### Scenario: Offline hint content
- **WHEN** the conversational switch renders in its disabled state
- **THEN** the hint shows the copyable daemon startup command sourced from the shared constant, and the i18n messages contain only a `{command}` placeholder rather than the literal command

### Requirement: Conversational mode SHALL let the user target a specific online connection instance
The conversational mode SHALL list agents that have at least one online daemon connection and, for the selected agent, SHALL let the user pick the target connection instance (host + cwd) using the shared instance picker semantics: a single online instance is auto-selected; multiple instances require an explicit pick before sending.

#### Scenario: Multiple instances require explicit pick
- **WHEN** the selected agent has two or more online daemon connections
- **THEN** the send action stays disabled until the user picks one instance, and each choice displays host and cwd per the shared instance formatting rules

#### Scenario: Single instance auto-selected
- **WHEN** the selected agent has exactly one online daemon connection
- **THEN** that instance is auto-selected and the user can send without an extra pick

### Requirement: Sending SHALL dispatch a template-composed human instruction as a new ad-hoc daemon session
On send, the client SHALL compose the final instruction by wrapping the user's verbatim description in a fixed instruction template that embeds the target project's UUID and name and directs the agent to (1) create the idea in that project, (2) claim it and start elaboration, and (3) report the created ideaUuid back into the session. The composed instruction SHALL be dispatched via the existing ad-hoc daemon session endpoint (`POST /api/daemon-sessions/ad-hoc`) targeting the picked agent and connection. The client SHALL cap user input so the composed instruction stays within the server's instruction length limit. The frontend SHALL NOT create the Idea entity itself.

#### Scenario: Successful dispatch
- **WHEN** the user enters a description and sends with a valid online instance selected
- **THEN** exactly one ad-hoc session is created whose first turn's instruction text contains the project UUID, the fixed directive, and the user's description verbatim, and no Idea entity is created by the frontend

#### Scenario: Input exceeds budget
- **WHEN** the user's description exceeds the client-side character budget
- **THEN** the send action is blocked with a visible character counter and no request is issued

#### Scenario: Connection went offline before send
- **WHEN** the dispatch returns the connection-offline conflict error
- **THEN** the component surfaces a retryable error message and refreshes the online-connection list instead of failing silently

#### Scenario: IME-safe Enter handling
- **WHEN** a CJK IME composition is in progress in the description input and the user presses Enter to confirm a candidate
- **THEN** the input treats it as composition (via the shared `isImeComposing` helper) and does not trigger send

### Requirement: Successful dispatch SHALL hand the user off to the daemon chat view focused on the new session
After a successful dispatch, the create-idea modal SHALL close and the daemon chat modal SHALL open with the newly created session selected and its live transcript subscribed, using a one-shot session-focus extension of the presence context's chat focus target. The freshly created session SHALL be selectable immediately (seeded from the dispatch response) even if the session list has not yet refreshed. Existing agent-only focus callers SHALL be unaffected.

#### Scenario: Handoff to chat on new session
- **WHEN** the ad-hoc dispatch succeeds
- **THEN** the create-idea modal closes, the daemon chat modal opens with that session selected, and transcript events for the session stream live

#### Scenario: Focus target is one-shot
- **WHEN** the chat modal consumes the session-focus target and the user later reopens the chat modal manually
- **THEN** the previous session focus is not re-applied

### Requirement: The conversational entry SHALL be a reusable component with the instruction template owned by the consumer
The conversational entry (online detection, agent + instance selection, description input, dispatch, session handoff callback) SHALL be implemented as a reusable component that accepts the instruction-composition function from its consumer. In this change the create-idea modal SHALL be its only consumer, and the create-idea instruction template SHALL live with the create-idea integration as a code-reviewable unit.

#### Scenario: Component reuse contract
- **WHEN** a future entry point supplies a different instruction-composition function to the component
- **THEN** no change to the component's selection/dispatch/handoff logic is required to support it

#### Scenario: Single consumer this release
- **WHEN** this change is complete
- **THEN** the create-idea modal is the only production consumer of the component

