# Delta: conversational-idea-entry — pre-created idea + root session

## REMOVED Requirements

### Requirement: Sending SHALL dispatch a template-composed human instruction as a new ad-hoc daemon session

### Requirement: The conversational entry SHALL be a reusable component with the instruction template owned by the consumer

## ADDED Requirements

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

#### Scenario: Composed instruction length enforced server-side
- **WHEN** the composed instruction (template + description) would exceed the server instruction length limit
- **THEN** the request is rejected with a validation error and nothing is persisted

### Requirement: The dispatched instruction SHALL direct the agent to edit the pre-created Idea and start elaboration in the same turn
The server-side instruction template SHALL direct the woken agent to (1) edit the pre-created Idea via `chorus_edit_idea` — deriving a concise title and polishing the content while preserving the user's meaning; (2) immediately start elaboration on the Idea in the same turn, posting a summary of the elaboration questions into the conversation and directing the user to answer in the Idea's elaboration panel; and (3) end the turn. The template SHALL NOT instruct the agent to create or claim the Idea (it is already created and assigned).

#### Scenario: Straight-through to first elaboration round
- **WHEN** the woken agent follows the dispatched instruction
- **THEN** within the single wake turn the Idea carries an agent-authored title and content, an elaboration round exists with pending answers, and the conversation contains the agent's question summary directing the user to the panel

#### Scenario: Template contains no create or claim directives
- **WHEN** the composed instruction is inspected
- **THEN** it references the pre-created ideaUuid and contains edit and start-elaboration directives, and contains no directive to call idea-creation or idea-claim tools

## ADDED Requirements

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
