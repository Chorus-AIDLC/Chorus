# container-decompose-ui Specification

## ADDED Requirements

### Requirement: The create-idea dialog SHALL allow creating an empty container in one step

The create-idea dialog (`NewIdeaDialog`) SHALL expose an `isContainer` control. When it is checked, submitting with only a non-empty title (no content) MUST create an idea with `isContainer = true`. Content MUST remain optional on this path (no client- or server-side content-required validation is introduced). The dialog SHALL reuse the existing create endpoint, which already accepts `isContainer`.

#### Scenario: Create a bare container with title only

- **GIVEN** the create-idea dialog is open with the container control checked
- **WHEN** the user enters only a title and submits
- **THEN** a new idea MUST be created with `isContainer = true`
- **AND** the empty content MUST NOT block creation

#### Scenario: Container control unchecked creates a normal idea

- **GIVEN** the create-idea dialog with the container control unchecked
- **WHEN** the user submits with a title
- **THEN** the created idea MUST have `isContainer = false`

### Requirement: A container idea SHALL be visually distinct beyond the badge in panel and card

A container idea SHALL render a whole-element visual distinction (e.g. a header tint/border on the detail panel and a border/tint on the tracker card) in addition to the existing "Container" badge, so a container is recognizable at a glance. The distinction SHALL be gated on the already-available `isContainer` flag and MUST NOT alter a non-container idea's appearance. All user-facing strings SHALL be internationalized in both `en` and `zh`.

#### Scenario: Container panel is visually distinct

- **GIVEN** a container idea open in the detail panel
- **THEN** the panel MUST show a container-specific visual treatment beyond the badge
- **AND** a non-container idea's panel MUST be unchanged

#### Scenario: Container card is visually distinct

- **GIVEN** a container idea shown as a tracker card
- **THEN** the card MUST show a container-specific visual treatment beyond the badge
- **AND** a non-container idea's card MUST be unchanged

### Requirement: A container-decompose intent SHALL wake a daemon agent via the existing conversational entry

The create-idea flow SHALL offer, when an online daemon connection exists, a "help me decompose into child ideas" intent. Selecting it SHALL pre-create the idea as a container (`isContainer = true`) and dispatch an idea-anchored daemon session carrying a decompose instruction, reusing the existing conversational-idea-entry transactional pre-create + assign + wake. No new wake/notification action type SHALL be introduced for this flow; it rides the existing `human_instruction` conversational wake.

#### Scenario: Decompose intent pre-creates a container and wakes the agent

- **GIVEN** an online daemon connection and the decompose intent selected in the create dialog
- **WHEN** the user dispatches with a description
- **THEN** a container idea (`isContainer = true`) MUST be pre-created and assigned to the daemon instance
- **AND** an idea-anchored daemon session MUST be dispatched with the decompose instruction in one transactional operation

#### Scenario: Decompose intent is unavailable when no daemon is online

- **GIVEN** no online daemon connection
- **THEN** the decompose intent MUST NOT be offered
- **AND** the static create path MUST still create a (optionally container) idea with no decomposition

### Requirement: The decompose instruction SHALL direct the agent to propose child ideas as a reviewable round before creating them

The dispatched decompose instruction SHALL direct the woken agent to (1) edit the container's title/content from the user's description, (2) clarify decomposition scope via a lightweight elaboration, (3) propose the candidate child ideas as a structured elaboration round for the user to review/edit/confirm — using **one elaboration question per proposed child** (elaboration questions are single-select and a round is capped at 15 questions, so a multi-select round MUST NOT be used and a single round proposes at most 15 candidates), and (4) create the confirmed children only after confirmation, each via `chorus_pm_create_idea` with `parentUuid` set to the container. Children MUST be created in the `open` state and MUST NOT be auto-elaborated on creation. The container's own status MUST remain `elaborated` (creating children MUST NOT advance or alter the container's status). The re-wake that triggers child creation MUST reuse the existing `elaboration_answered` action (which maps to the elaboration trigger and re-wakes the container's idea-anchored session); no new wake/notification action type SHALL be introduced. This agent behavior SHALL be documented in the idea skill across all present skill surfaces.

#### Scenario: Agent proposes children as a round, not immediate creation

- **GIVEN** a daemon agent woken with the container-decompose instruction
- **WHEN** it has clarified the decomposition scope
- **THEN** it MUST present the candidate child ideas as a structured elaboration round for user confirmation, one question per proposed child
- **AND** it MUST NOT use a single multi-select question, and MUST NOT exceed the 15-question-per-round cap
- **AND** it MUST NOT create the child ideas before the user confirms

#### Scenario: Container status is unchanged by decomposition

- **GIVEN** a container idea whose elaboration has resolved (status `elaborated`)
- **WHEN** the agent creates the confirmed child ideas under it
- **THEN** the container's own status MUST remain `elaborated`
- **AND** the container's progress MUST surface only via the existing read-only child-completion rollup

#### Scenario: Confirm re-wake reuses the existing elaboration action

- **GIVEN** the agent has proposed the child ideas as an elaboration round on the container
- **WHEN** the user answers/confirms that round
- **THEN** the re-wake MUST occur via the existing `elaboration_answered` action re-waking the container's idea-anchored daemon session
- **AND** no new wake/notification action type is introduced

#### Scenario: Confirmed children are created under the container in open state

- **GIVEN** the user has confirmed a set of proposed child ideas
- **WHEN** the agent proceeds
- **THEN** each confirmed child MUST be created via `chorus_pm_create_idea` with `parentUuid` set to the container idea
- **AND** each child MUST start in the `open` state
- **AND** no child MUST be auto-advanced into elaboration on creation

#### Scenario: The idea skill documents the decompose contract

- **GIVEN** the idea skill documentation surfaces
- **THEN** each present surface MUST describe the container-decompose contract (clarify scope, propose children as a round, create with `parentUuid` on confirmation, children start `open`)
