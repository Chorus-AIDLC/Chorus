## ADDED Requirements

### Requirement: One active creation attempt
The project creation dialog SHALL allow at most one active attempt across validation, POST and success feedback, shared by click and Enter submission.

#### Scenario: Repeated events during validation or request
- **WHEN** the user clicks or presses Enter again while validation or POST is pending
- **THEN** the dialog performs only one validation sequence and sends at most one project POST for that attempt
- **AND** the creating state is visible from validation start

#### Scenario: Success feedback remains protected
- **WHEN** creation succeeds and success feedback is displayed before the dialog closes
- **THEN** additional submission events do not create another project

### Requirement: Recoverable creation and safe lifecycle
The dialog SHALL preserve drafts and allow retry after validation or request failure, protect active attempts from dismissal, and allow new creation after successful closure.

#### Scenario: Failure and retry
- **WHEN** validation fails or rejects, the API reports an error, or the request rejects
- **THEN** the dialog retains the input and releases the busy guard for a deliberate retry
- **AND** the applicable existing error presentation is used

#### Scenario: Dismissal during an attempt
- **WHEN** the user attempts cancel, Escape or outside dismissal during an active attempt or success feedback
- **THEN** the dialog remains open until the attempt fails or completes

#### Scenario: New creation after completion
- **WHEN** a successful attempt closes and the user opens the dialog again
- **THEN** a new deliberate submission can create one project in the newly selected group
- **AND** stale asynchronous completion or an unmounted timer does not close a later dialog

### Requirement: Preserve creation semantics
The dialog SHALL preserve group and cwd payloads, title validation and IME behavior.

#### Scenario: Ordinary creation in a project group
- **WHEN** a valid project is submitted once from a group header
- **THEN** one POST contains the selected group and validated cwd references

#### Scenario: Blank title or composing text
- **WHEN** the title is blank or Enter is used to confirm an IME composition
- **THEN** no project creation request is sent
