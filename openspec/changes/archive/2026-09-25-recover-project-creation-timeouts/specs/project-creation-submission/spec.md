## MODIFIED Requirements

### Requirement: Recoverable creation and safe lifecycle
The dialog SHALL preserve drafts, permit cancellation before POST, and distinguish a definitive rejection from an unconfirmed creation outcome.

#### Scenario: Validation cancellation
- **WHEN** the user chooses Cancel, Escape or outside dismissal during directory validation
- **THEN** the actual validation request is aborted and drafts are retained for reopening
- **AND** a late validation resolution or rejection cannot POST or alter a subsequent attempt

#### Scenario: Definitive failure and retry
- **WHEN** validation fails or a recognized API 4xx response definitively rejects creation
- **THEN** the dialog retains input and releases the busy guard for a deliberate retry
- **AND** applicable validation or creation errors are presented in the current undismissed attempt

#### Scenario: Unconfirmed outcome
- **WHEN** POST or response-body reading has not completed within 20 seconds, or transport, parse, server or malformed-response errors prevent confirmation
- **THEN** the dialog states the creation result is unconfirmed and permits dismissal with drafts retained
- **AND** it does not automatically retry or enable ordinary submission

#### Scenario: Reopening and informed new operation
- **WHEN** an unconfirmed attempt is closed and the mounted dialog is reopened
- **THEN** the unconfirmed warning and submission guard persist
- **AND** a clear warning states that the earlier request may still succeed even if the project is absent from the list
- **AND** only explicit confirmation that the user checked the list and still wants to create again permits a new operation

#### Scenario: Pending POST and success feedback
- **WHEN** POST remains within the bounded wait or current success feedback is displayed
- **THEN** Cancel, Escape and outside dismissal do not dismiss that attempt

#### Scenario: New creation after completion
- **WHEN** a successful attempt closes and the user opens the dialog again
- **THEN** a new deliberate submission can create one project in the newly selected group
- **AND** stale asynchronous completion or an unmounted timer does not close a later dialog

#### Scenario: Late response isolation
- **WHEN** a dismissed or superseded attempt completes after another dialog operation begins
- **THEN** its errors and timers do not mutate the new attempt's state or release its lock
- **AND** a late successful creation can refresh data without closing the new dialog
- **AND** no callbacks run after unmount
