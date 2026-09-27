# lightweight-research Specification

## Purpose
TBD - created by archiving change add-lightweight-research-skill. Update Purpose after archive.
## Requirements
### Requirement: Research SHALL be a reusable skill on all seven surfaces
The system SHALL provide a standalone research skill on standalone, Claude Code, Codex, Kiro, Pi, OpenClaw and dsh surfaces. Idea and Proposal skills SHALL reference it using each host's supported invocation conventions. Discovery and explicit installation manifests SHALL include the skill where required.

#### Scenario: Installed skill is discoverable
- **WHEN** a supported distribution is installed or packaged
- **THEN** its research skill and the Idea and Proposal routing instructions are included and resolve to the correct host-specific skill

#### Scenario: Shared rules have one conceptual owner
- **WHEN** an author reads the Idea or Proposal route
- **THEN** it delegates research procedure to the research skill and retains only its stage-specific trigger, inputs and consumption responsibilities

### Requirement: Research SHALL be optional and driven by a concrete question
The invoking workflow SHALL request research when explicitly requested by the user or when a verifiable knowledge gap could change its current description, clarification questions or proposal design. Explicit user instructions to skip SHALL take precedence. Research SHALL NOT invent user goals or preferences. The Tracker action SHALL provide an explicit invocation at any pre-development stage, independently of automatic initialization research.

#### Scenario: Sufficient information
- **WHEN** existing context and evidence already answer the relevant factual questions
- **THEN** the workflow continues without automatic research

#### Scenario: Unknown factual constraint
- **WHEN** a verifiable unknown could change a clarification question or design choice
- **THEN** the workflow supplies that focus and existing context to research

#### Scenario: Explicit skip conflicts with a request flag
- **WHEN** the user explicitly requests no research in the current instruction even though researchFirst is true
- **THEN** the workflow respects the explicit skip and continues its normal clarification path

### Requirement: Research SHALL remain bounded and return partial or empty findings honestly
Research SHALL conduct one focused investigation per stage preparation, with an Agent-enforced budget of approximately 2–5 minutes and at most five deeply reviewed relevant sources. It SHALL NOT require a minimum source count, recursively initiate researchers, or repeat merely because a wake or stage resumes. Tool unavailability, exhausted budget or no useful findings SHALL return limitations and any useful partial findings. The feature SHALL NOT promise a server-enforced five-minute cutoff.

#### Scenario: Search unavailable
- **WHEN** no usable search or retrieval tool is available
- **THEN** research returns the limitation without fabricating evidence or blocking the calling lifecycle

#### Scenario: No new evidence
- **WHEN** the bounded search reveals nothing that changes the current direction
- **THEN** research may report that no relevant new evidence was found and stops

#### Scenario: Resume or proposal preparation
- **WHEN** a workflow resumes or enters Proposal after Idea research
- **THEN** it reads existing findings before requesting research, does not automatically repeat the same investigation, and scopes any justified new invocation to the new question

### Requirement: Calling workflows SHALL persist findings with real evidence citations
Research SHALL return concise factual findings, implications for the current work, unknowns and source links. The caller SHALL reuse or attach actual ReferenceArtifacts, retrieve their real UUIDs, and cite them at relevant statements in its existing work product. Research SHALL NOT create an independent report entity or mutate elaboration, task or proposal lifecycle status.

#### Scenario: Idea consumes findings
- **WHEN** research returns useful information before formal Idea clarification
- **THEN** the caller preserves the user's meaning, incorporates the relevant findings into Idea content with real ref:UUID citations, and continues elaboration

#### Scenario: Proposal consumes findings in OpenSpec mode
- **WHEN** Proposal preparation obtains new findings
- **THEN** the caller attaches or reuses sources, updates the local authoritative design/specification and mirrors file bytes using the existing document workflow

#### Scenario: Proposal does not yet exist
- **WHEN** sources are found before creating the proposal container
- **THEN** the caller retains candidates, attaches them inline during container creation when possible, retrieves UUIDs and only then writes evidence citations

### Requirement: Stage boundaries and existing storage SHALL remain authoritative
Research SHALL be callable by Idea and Proposal without requiring a new database entity, schema field, MCP tool or Research status. Idea SHALL route it before its first formal clarification round, allowing prior focusing when necessary; Proposal SHALL route it for relevant new factual design questions. Brainstorm and yolo routes SHALL preserve their existing user-decision and lifecycle requirements while avoiding duplicate research.

#### Scenario: Form or MCP created Idea
- **WHEN** an Agent prepares an Idea created outside the conversational UI
- **THEN** the Idea skill independently applies the same optional research rules without requiring a Checkbox or daemon-specific flag

#### Scenario: Research needs a focused user goal
- **WHEN** no meaningful factual research question exists because the goal is unclear
- **THEN** the caller clarifies or focuses the goal through its existing workflow before attempting research and never substitutes web evidence for the user's decision

#### Scenario: Existing records do not imply success
- **WHEN** the Idea has references or an associated turn has ended
- **THEN** the feature does not infer or render a research-completed status from those records

### Requirement: Tracker SHALL offer Research until actual development starts
The Idea Tracker action menu SHALL include Research in both desktop and mobile representations. Eligibility SHALL include open Ideas, pending or completed clarification, proposal drafting/review, and approved proposals whose work has not begun. It SHALL NOT use the derived building badge alone as proof of development. Eligibility SHALL be checked authoritatively at dispatch against existing development-start and task-execution records across associated proposals and relevant theme descendants, without a new database field.

#### Scenario: Approved but not started
- **WHEN** a proposal is approved but its tasks are only open or assigned and no development start or prior execution is recorded
- **THEN** Research remains available despite a derived building badge

#### Scenario: Questions or proposal awaiting answers
- **WHEN** an Idea has pending elaboration answers or a pending proposal and development has not started
- **THEN** the user can invoke Research without resolving that existing gate first

#### Scenario: Development dispatch accepted
- **WHEN** Start Development was accepted but tasks have not yet changed to in_progress
- **THEN** a later Research request is rejected with a stage explanation

#### Scenario: Existing execution or history
- **WHEN** an associated task has entered execution, verification or completion, including execution under an older associated proposal or relevant theme descendant
- **THEN** Research is disabled and server-side requests are rejected even if tasks were later reopened

#### Scenario: Yolo still planning
- **WHEN** yolo has only performed clarification or planning and no development start or task execution exists
- **THEN** the yolo request alone does not permanently mark development as started; an explicit Research request may queue on the same conversation

### Requirement: Tracker Research SHALL dispatch without changing lifecycle
The server SHALL authorize and dispatch a focused Research instruction through the existing idea-root session and human_instruction path, preserving instance and cwd routing. It SHALL use current eligibility at dispatch and check again before execution if the stage changed. Each explicit submission SHALL create a distinct bounded Research turn, even when earlier Research turns are pending or running. The client SHALL prevent repeat clicks only while its submission is in flight. Accepted requests SHALL be described as queued, not running or completed; the existing conversation turn records SHALL show their execution states. Clients declaring `researchProtocol=1` SHALL execute Research turns separately and serially on the existing root conversation, without coalescing; legacy clients retain ordinary instruction batching. Stage changes SHALL be ordered consistently with dispatch; stale UI SHALL NOT bypass server checks.

#### Scenario: Existing answers preserved
- **WHEN** Research finishes on an Idea with answered or pending elaboration rounds
- **THEN** it saves relevant findings and real citations in Idea content and reports completion without recreating questions, changing their answers, resetting resolution or starting development

#### Scenario: Approved proposal affected by finding
- **WHEN** Research discovers a fact affecting an approved proposal
- **THEN** it records the impact and required follow-up in the Idea without silently changing approved scope or lifecycle

#### Scenario: Routing and availability
- **WHEN** Research is requested without an Agent assignment or with an offline target
- **THEN** the UI uses an explicit existing Agent selection flow or provides the appropriate actionable availability error, rather than silently dispatching to a different instance or creating an unrelated Idea

#### Scenario: Repeat while Research is outstanding
- **WHEN** the user submits another Research request while an earlier one is queued or running
- **THEN** the service creates another distinct turn on the same root conversation and the button remains available after submission
- **AND** a client declaring `researchProtocol=1` runs these turns separately in sequence, retaining each turn's pending, running and terminal state

#### Scenario: Concurrent development start
- **WHEN** Research submission races with a development start
- **THEN** the service rejects research whose development boundary has already been crossed, and retires pending research before execution if development starts after submission

#### Scenario: Menu acceptance and design artifact
- **WHEN** the Tracker action is delivered
- **THEN** localized desktop and mobile menu, eligible and disabled states are verified in light and dark themes; Pencil design synchronization is waived for this delivery by the explicit user instruction recorded in Idea comment 25a4d74c-3e9f-4aaf-a019-75344cc77a50

### Requirement: Research execution SHALL progressively enhance legacy instruction delivery
The pending-turns HTTP endpoint SHALL deliver eligible Research instructions to both legacy and upgraded clients. The current CLI SHALL declare `researchProtocol=1` on pending reads and turn-advance requests, execute each Research queue item independently on the existing serial session lane, and retain exact turn UUID admission and terminal reporting. The turn-advance HTTP boundary SHALL enable isolated mode only when `researchProtocol=1`; missing or other values SHALL preserve legacy FIFO and coalesced settlement, including Research turns for their origin connection. Neither mode SHALL bypass company, agent, session-origin or development-boundary checks. Research-only pending cancellation SHALL continue requiring exact turn identity.

#### Scenario: Legacy client completes queued instructions
- **WHEN** a legacy CLI reads pending turns and reports execution without `researchProtocol=1`
- **THEN** Research instructions are delivered and can follow ordinary FIFO start, coalesced settlement and terminal acknowledgement
- **AND** ended or merged turns are absent from subsequent pending reads, without requiring a CLI upgrade

#### Scenario: Upgraded client isolates Research
- **WHEN** the CLI declares `researchProtocol=1`
- **THEN** each Research instruction executes separately on the existing serial conversation queue and requires exact turn admission before launch
- **AND** uncorrelated ordinary reports and ordinary coalesced settlement do not consume Research turns

#### Scenario: Legacy execution guarantees
- **WHEN** a legacy CLI uses its original batching and subprocess-start behavior
- **THEN** the system does not promise isolated Research batches or pre-launch admission for that client, while retaining the bounded research prompt, dispatch/read stage checks and origin-scoped acknowledgement

