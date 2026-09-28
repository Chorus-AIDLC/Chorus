## MODIFIED Requirements

### Requirement: A container-decompose intent SHALL wake a daemon agent via the existing conversational entry

The create-idea flow SHALL offer, when an online daemon connection exists, a "help me decompose into child ideas" intent. Selecting it SHALL pre-create the idea as a container (`isContainer = true`) and dispatch an idea-anchored daemon session carrying a decompose instruction, reusing the existing conversational-idea-entry transactional pre-create + assign + wake. The initial dispatch SHALL persist an `idea_creation_requested` turn whose versioned payload selects decompose mode; clients without operationProtocol=1 SHALL receive the same turn through the human_instruction compatibility projection. This change applies only to initialization; later child-review confirmation SHALL retain the existing elaboration_answered action and all child-creation human gates.

#### Scenario: Decompose intent pre-creates a container and wakes the agent

- **GIVEN** an online daemon connection and the decompose intent selected in the create dialog
- **WHEN** the user dispatches with a description
- **THEN** a container idea (`isContainer = true`) MUST be pre-created and assigned to the daemon instance
- **AND** an idea-anchored daemon session MUST be dispatched with the decompose instruction in one transactional operation

#### Scenario: Decompose intent is unavailable when no daemon is online

- **GIVEN** no online daemon connection
- **THEN** the decompose intent MUST NOT be offered
- **AND** the static create path MUST still create a (optionally container) idea with no decomposition
