## RENAMED Requirements

- FROM: `### Requirement: Research delivery SHALL require an explicitly supported daemon protocol`
- TO: `### Requirement: Research execution SHALL progressively enhance legacy instruction delivery`

## MODIFIED Requirements

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
