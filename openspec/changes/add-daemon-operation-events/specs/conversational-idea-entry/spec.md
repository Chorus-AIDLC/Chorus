## MODIFIED Requirements

### Requirement: Successful dispatch SHALL hand the user off to the daemon chat view focused on the new session
Successful daemon-assisted Idea dispatch SHALL close the create-idea dialog, show localized submitted feedback, and keep the user on the current page without automatically opening or focusing the daemon chat. The session SHALL remain available through existing manual conversation controls and the Idea SHALL appear through existing list updates. The historical requirement title is retained for compatibility with the cumulative spec; its automatic-chat behavior is replaced by this requirement.

#### Scenario: Submission stays on the current page
- **WHEN** ordinary or decomposition dispatch succeeds
- **THEN** the create dialog closes and submitted feedback appears without a chat modal, automatic navigation or stored session-focus target

#### Scenario: Manual session access
- **WHEN** the user later opens the conversation manually
- **THEN** its session and transcript can be read normally with no stale submission focus applied

#### Scenario: Existing chat and static creation
- **WHEN** a conversation was already open or the static creation path is used
- **THEN** this change does not close or switch the existing conversation or alter static creation behavior

### Requirement: Sending SHALL pre-create the Idea and dispatch an idea-anchored daemon session in one transactional operation
On send, the client SHALL post the user's verbatim description together with the picked project, agent, and connection to a dedicated conversational-idea endpoint (`POST /api/ideas/conversational`). The server SHALL, atomically: (1) create the Idea with `createdBy` = the initiating user, a server-derived single-line placeholder title, and the verbatim description as content; (2) assign the Idea to the picked agent instance (`assigneeType = "agent_instance"`) and set its status to `elaborating`; (3) create the daemon session idea-anchored from birth (`sessionId = ideaUuid`, `directIdeaUuid = ideaUuid`, origin = the picked connection); and (4) create the first `idea_creation_requested` turn with versioned operationPayload containing the ideaUuid, projectUuid, elaborate/decompose mode, researchFirst and the verbatim description, plus a server-composed compatibility prompt snapshot. Clients without operationProtocol=1 receive a human_instruction projection of the same turn, without additional writes. If any of these steps fails, none of them SHALL persist. The frontend SHALL NOT create the Idea entity itself, and the pre-existing ad-hoc endpoint (`POST /api/daemon-sessions/ad-hoc`) SHALL remain unchanged.

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

#### Scenario: Long project name cannot inflate the generated instruction
- **WHEN** a project's name exceeds 200 characters
- **THEN** only its display label in the generated instruction is shortened to 200 characters, including an ellipsis
- **AND** the full project UUID and user description are preserved, without changing the stored project name

#### Scenario: Description length enforced server-side
- **WHEN** the user's trimmed description is empty or exceeds the shared client/server limit of 3000 characters
- **THEN** the request is rejected with a validation error and nothing is persisted
- **AND** ordinary human instruction endpoints retain their separate 4000-character limit

#### Scenario: Dedicated first turn on both modes
- **WHEN** elaborate or decompose dispatch commits
- **THEN** the canonical first turn uses idea_creation_requested with mode and researchFirst preserved, while old clients receive the same turn UUID through compatible instruction delivery

### Requirement: The conversational entry component SHALL accept a consumer-owned dispatch function
The reusable conversational entry component SHALL accept an optional dispatch function that replaces its default ad-hoc dispatch while the component retains ownership of online detection, agent and instance selection, input budgeting, error presentation, and the consumer-owned success callback. When the dispatch function is omitted, the component SHALL behave exactly as before this change (ad-hoc endpoint dispatch). The create-idea modal SHALL supply the conversational-idea dispatch and remain the only production consumer in this change.

#### Scenario: Default dispatch unchanged
- **WHEN** a consumer renders the component without a dispatch function
- **THEN** sending posts to the ad-hoc daemon-session endpoint with unchanged request shape and error handling

#### Scenario: Create-idea modal uses the conversational-idea dispatch
- **WHEN** the user sends from the create-idea modal's conversational mode
- **THEN** the component invokes the supplied dispatch (hitting the conversational-idea endpoint) and passes the returned session to its success callback, which closes the create dialog and shows submitted feedback without automatic chat opening

#### Scenario: Dispatch errors map to the component's error surface
- **WHEN** the supplied dispatch rejects with a connection-offline conflict
- **THEN** the component shows the same retryable offline error and refreshes connections, identically to the default dispatch's 409 handling

### Requirement: Conversational creation SHALL accept an explicit research request
The conversational pane SHALL provide a default-unchecked, accessible Checkbox requesting lightweight research before clarification. Its hint SHALL explain that unchecked still allows automatic research when useful. The UI SHALL pass an optional boolean researchFirst through the existing POST /api/ideas/conversational validator, service and instruction composer. False and omission SHALL mean automatic judgment; true SHALL express a request subject to explicit user skip instructions and available tools. The field SHALL be orthogonal to elaborate/decompose mode and SHALL NOT introduce a persistent research setting.

#### Scenario: Checked explicit request
- **WHEN** the user checks the control and successfully submits
- **THEN** the initial turn's server-composed instruction includes the explicit research request while preserving the user's verbatim description and showing submitted feedback without opening chat

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
- **THEN** browser acceptance evidence for the creation dialog's Checkbox and hint covers both light and dark themes; docs/design.pen reflects the dedicated-operation labels and no-auto-chat behavior; Idea comment 25a4d74c-3e9f-4aaf-a019-75344cc77a50 waived only the historical Checkbox delivery
