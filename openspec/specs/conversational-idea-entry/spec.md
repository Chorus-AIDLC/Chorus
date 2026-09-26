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

### Requirement: Successful dispatch SHALL hand the user off to the daemon chat view focused on the new session
After a successful dispatch, the create-idea modal SHALL close and the daemon chat modal SHALL open with the newly created session selected and its live transcript subscribed, using a one-shot session-focus extension of the presence context's chat focus target. The freshly created session SHALL be selectable immediately (seeded from the dispatch response) even if the session list has not yet refreshed. Existing agent-only focus callers SHALL be unaffected.

#### Scenario: Handoff to chat on new session
- **WHEN** the ad-hoc dispatch succeeds
- **THEN** the create-idea modal closes, the daemon chat modal opens with that session selected, and transcript events for the session stream live

#### Scenario: Focus target is one-shot
- **WHEN** the chat modal consumes the session-focus target and the user later reopens the chat modal manually
- **THEN** the previous session focus is not re-applied

### Requirement: Sending SHALL pre-create the Idea and dispatch an idea-anchored daemon session in one transactional operation
On send, the client SHALL post the user's verbatim description together with the picked project, agent, and connection to a dedicated conversational-idea endpoint (`POST /api/ideas/conversational`). The server SHALL, atomically: (1) create the Idea with `createdBy` = the initiating user, a server-derived single-line placeholder title, and the verbatim description as content; (2) assign the Idea to the picked agent instance (`assigneeType = "agent_instance"`) and set its status to `elaborating`; (3) create the daemon session idea-anchored from birth (`sessionId = ideaUuid`, `directIdeaUuid = ideaUuid`, origin = the picked connection); and (4) create the first `human_instruction` turn whose instruction text is composed server-side from a fixed template embedding the ideaUuid, project identity, and the user's verbatim description. If any of these steps fails, none of them SHALL persist. The frontend SHALL NOT create the Idea entity itself, and the pre-existing ad-hoc endpoint (`POST /api/daemon-sessions/ad-hoc`) SHALL remain unchanged.

#### Scenario: Successful dispatch creates idea plus anchored session
- **WHEN** the user enters a description and sends with a valid online instance selected
- **THEN** exactly one Idea exists (createdBy = the user, assigned to the picked instance, status elaborating) and exactly one daemon session exists with `sessionId` equal to that Idea's uuid and `directIdeaUuid` equal to that Idea's uuid, whose first turn's instruction text contains the ideaUuid and the user's description verbatim

#### Scenario: Transactional failure leaves nothing behind
- **WHEN** session or turn creation fails during the dispatch operation
- **THEN** no Idea, no session, and no turn are persisted, and the client surfaces a retryable inline error

#### Scenario: Connection went offline before send
- **WHEN** the dispatch returns the connection-offline conflict error
- **THEN** the component surfaces a retryable error message and refreshes the online-connection list instead of failing silently

#### Scenario: Full advertised description budget is accepted
- **WHEN** the user sends a nonempty description of at most 3000 characters after trimming, in either elaboration or decomposition mode, with Research enabled, disabled, or omitted
- **THEN** the description is preserved in full in the Idea content and opening instruction; server-generated template text does not consume the description budget

#### Scenario: Description length enforced server-side
- **WHEN** the user's trimmed description is empty or exceeds the shared client/server limit of 3000 characters
- **THEN** the request is rejected with a validation error and nothing is persisted
- **AND** ordinary human instruction endpoints retain their separate 4000-character limit

### Requirement: The dispatched instruction SHALL direct the agent to edit the pre-created Idea and start elaboration in the same turn
The server-side instruction template SHALL direct the woken agent to (1) edit the pre-created Idea via chorus_edit_idea, deriving a concise title and polishing content while preserving the user's meaning; (2) assess relevant factual gaps and invoke the shared lightweight research skill when requested or useful, incorporating findings and real evidence citations; (3) start elaboration on the Idea in the same turn after optional research, post a summary of the questions and direct the user to the Idea's elaboration panel; and (4) end the turn. It SHALL NOT direct the Agent to create or claim the already assigned Idea. Research failure, unavailability or budget exhaustion SHALL NOT prevent proceeding to clarification with known limitations. Existing user-decision gates SHALL remain intact when focusing or decomposition requires human input.

#### Scenario: Straight-through to first elaboration round
- **WHEN** the woken agent follows the dispatched instruction and has a sufficiently focused goal
- **THEN** within the single wake turn the Idea carries an agent-authored title and content, an elaboration round exists with pending answers, and the conversation contains the question summary directing the user to the panel, whether research was useful or skipped

#### Scenario: Research runs before formal questions
- **WHEN** the request explicitly asks for research or a relevant factual gap is identified
- **THEN** a bounded research invocation precedes the first formal clarification questions and any useful findings are incorporated into the Idea's content with real evidence citations

#### Scenario: No research tools
- **WHEN** the Agent cannot perform external research
- **THEN** it reports the limitation, preserves unknowns and proceeds to the normal clarification workflow

#### Scenario: Template contains no create or claim directives
- **WHEN** the composed instruction is inspected
- **THEN** it references the pre-created ideaUuid and contains edit and start-elaboration directives, and contains no directive to call idea-creation or idea-claim tools

### Requirement: The pre-created conversation SHALL be the Idea's root session for all subsequent idea-anchored wakes
Because the session is created with `sessionId === directIdeaUuid === ideaUuid` and the Idea is instance-pinned to the origin connection at creation, all subsequent idea-anchored wakes for that Idea (elaboration answers, elaboration verification, proposal approval/rejection, task assignment) SHALL resolve to this same daemon session via the existing session-key derivation and pin/session-origin routing, without any modification to the wake chokepoint. The session's identity SHALL NOT re-bind: if the agent creates further Ideas inside this conversation, those Ideas follow the pre-existing routing paths and this session remains anchored to the original Idea.

#### Scenario: Elaboration answer wake continues the same conversation
- **WHEN** the user answers the elaboration round in the Idea panel after the dispatch
- **THEN** the resulting wake creates its turn on the same daemon session (same session uuid) and the daemon resumes the same on-disk transcript

#### Scenario: Later lifecycle wakes converge on the root session
- **WHEN** a proposal for this Idea is approved or a task derived from it is assigned to the same agent while the origin connection is online
- **THEN** the resulting wake turns are created on the same root session rather than a newly minted session

#### Scenario: Session never re-binds to a second idea
- **WHEN** the agent creates another Idea via MCP inside this conversation
- **THEN** the session's `directIdeaUuid` still references the original pre-created Idea

### Requirement: A failed or abandoned dispatch SHALL leave the placeholder Idea visible for user recovery
The pre-created Idea SHALL be a normal, immediately visible Idea (no hidden or draft state, no automatic cleanup). If the woken agent never edits it (daemon offline after dispatch, turn failure), the Idea SHALL remain in lists with its placeholder title and verbatim description content, editable and deletable by the user through existing Idea affordances.

#### Scenario: Wake failure preserves the user's description
- **WHEN** the dispatch succeeds but the daemon dies before the agent edits the Idea
- **THEN** the Idea remains visible with the placeholder title and the user's full description as content, and the user can edit or delete it manually

#### Scenario: No background cleanup
- **WHEN** a placeholder Idea is never edited by an agent
- **THEN** the system does not automatically delete or archive it

### Requirement: The conversational entry component SHALL accept a consumer-owned dispatch function
The reusable conversational entry component SHALL accept an optional dispatch function that replaces its default ad-hoc dispatch while the component retains ownership of online detection, agent and instance selection, input budgeting, error presentation, and the session handoff callback. When the dispatch function is omitted, the component SHALL behave exactly as before this change (ad-hoc endpoint dispatch). The create-idea modal SHALL supply the conversational-idea dispatch and remain the only production consumer in this change.

#### Scenario: Default dispatch unchanged
- **WHEN** a consumer renders the component without a dispatch function
- **THEN** sending posts to the ad-hoc daemon-session endpoint with unchanged request shape and error handling

#### Scenario: Create-idea modal uses the conversational-idea dispatch
- **WHEN** the user sends from the create-idea modal's conversational mode
- **THEN** the component invokes the supplied dispatch (hitting the conversational-idea endpoint) and hands the returned session to the existing chat handoff

#### Scenario: Dispatch errors map to the component's error surface
- **WHEN** the supplied dispatch rejects with a connection-offline conflict
- **THEN** the component shows the same retryable offline error and refreshes connections, identically to the default dispatch's 409 handling

### Requirement: Conversational creation SHALL accept an explicit research request
The conversational pane SHALL provide a default-unchecked, accessible Checkbox requesting lightweight research before clarification. Its hint SHALL explain that unchecked still allows automatic research when useful. The UI SHALL pass an optional boolean researchFirst through the existing POST /api/ideas/conversational validator, service and instruction composer. False and omission SHALL mean automatic judgment; true SHALL express a request subject to explicit user skip instructions and available tools. The field SHALL be orthogonal to elaborate/decompose mode and SHALL NOT introduce a persistent research setting.

#### Scenario: Checked explicit request
- **WHEN** the user checks the control and successfully submits
- **THEN** the initial turn's server-composed instruction includes the explicit research request while preserving the user's verbatim description and existing chat handoff

#### Scenario: Unchecked or older client
- **WHEN** researchFirst is false or omitted
- **THEN** creation remains compatible and the instruction allows the Agent to judge whether research is needed

#### Scenario: Invalid type
- **WHEN** researchFirst is supplied with a non-boolean value
- **THEN** the route rejects the request through its existing validation response without creating an Idea or session

#### Scenario: Combined with decompose
- **WHEN** the request includes decompose and researchFirst as true
- **THEN** the Idea remains a container and the instruction applies research before the existing decomposition workflow without bypassing its human confirmation gate

#### Scenario: UI modes and failure recovery
- **WHEN** the user switches between static and conversational modes or retries a failed submission
- **THEN** the Checkbox is shown only in conversational mode, retry preserves its selection, and a fresh dialog opening resets to unchecked

#### Scenario: Accessibility and locales
- **WHEN** the control renders in en, zh, ja or ko at desktop or narrow widths
- **THEN** it has a localized label and explanatory hint, keyboard operability and an accessible label association without new layout overflow in both light and dark themes

#### Scenario: Design artifact and theme acceptance
- **WHEN** the UI change is delivered
- **THEN** browser acceptance evidence for the creation dialog's Checkbox and hint covers both light and dark themes; Pencil synchronization is waived for this delivery by explicit user instruction in Idea comment 25a4d74c-3e9f-4aaf-a019-75344cc77a50
