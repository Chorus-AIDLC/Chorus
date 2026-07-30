## MODIFIED Requirements

### Requirement: FAIL recovery via fix tasks

On a FAIL verdict, the orchestrating workflow SHALL invoke Quick Dev to create new fix tasks on the existing approved proposal targeting the reviewer's BLOCKERs, rather than reopening previously completed tasks or modifying code directly outside a task.

The orchestrator SHALL own task creation; the read-only code reviewer MUST NOT create tasks or modify code. The orchestrator SHALL link each fix task to the original proposal and include the relevant BLOCKER findings and review-round context.

The orchestrator SHALL choose practical task granularity: related small BLOCKERs from the same review round SHOULD be grouped into one cohesive fix task, while materially large or independently testable remediation MAY be split into multiple tasks.

Every fix task SHALL complete the normal Quick Dev acceptance-criteria verification and independent task-review workflow. The orchestrator SHALL re-run the independent code reviewer as a subsequent aggregate review round only after every fix task is successfully completed and admin-verified. If any fix task fails or is cancelled, the workflow SHALL stop the automatic re-review loop and escalate the unresolved remediation.

Re-review rounds SHALL be bounded by the `maxCodeReviewRounds` configuration option (default 3; 0 means unlimited), after which the workflow escalates to a human.

#### Scenario: FAIL starts orchestrator-owned Quick Dev remediation

- **WHEN** the code reviewer returns FAIL with one or more BLOCKERs
- **THEN** the orchestrator starts Quick Dev and creates fix tasks on the original approved proposal without reopening completed tasks or directly applying untracked fixes

#### Scenario: Related findings are grouped

- **WHEN** one review round reports multiple related small BLOCKERs
- **THEN** the orchestrator groups them into one cohesive fix task unless their size or independent testability justifies separate tasks

#### Scenario: Fix tasks preserve verification discipline

- **WHEN** a Quick Dev fix task is implemented
- **THEN** its acceptance criteria are self-verified and an independent task reviewer is run before the task reaches its terminal verified state

#### Scenario: Successfully verified fixes trigger aggregate re-review

- **WHEN** all fix tasks for a failed aggregate review are successfully completed and admin-verified
- **THEN** the orchestrator re-runs the independent code reviewer as the next review round

#### Scenario: Failed or cancelled fix stops the loop

- **WHEN** any fix task fails or is cancelled before successful admin verification
- **THEN** the workflow does not trigger aggregate re-review and escalates the unresolved remediation

#### Scenario: Round cap escalates to human

- **WHEN** the code reviewer keeps returning FAIL and the number of rounds reaches `maxCodeReviewRounds` (when non-zero)
- **THEN** the workflow stops the automatic loop and escalates the persisting BLOCKERs to a human
