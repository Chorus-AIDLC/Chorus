## ADDED Requirements

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
- **THEN** the creation dialog's Checkbox and hint are reflected in docs/design.pen using Pencil MCP, and browser acceptance evidence covers both light and dark themes

## MODIFIED Requirements

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
