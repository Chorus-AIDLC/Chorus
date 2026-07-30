## ADDED Requirements

### Requirement: Quick Dev preserves normal verification discipline

Quick Dev SHALL require the executing agent to self-verify every acceptance criterion and invoke the required independent task reviewer before final task verification. Autonomous progression MUST NOT omit required reviewer sub-agents or verification evidence.

#### Scenario: Admin-capable agent still invokes independent review

- **WHEN** a Quick Dev agent has `task:admin` permission and finishes implementation
- **THEN** it self-verifies the acceptance criteria and obtains the required independent task-review verdict before performing admin verification

#### Scenario: Failed independent review blocks completion

- **WHEN** the independent task reviewer reports unresolved BLOCKERs
- **THEN** Quick Dev does not admin-verify the task and continues remediation through the task workflow

### Requirement: Quick Dev selects the terminal path from explicit permissions

Quick Dev SHALL inspect the active Chorus check-in permissions for `task:admin`. It MUST NOT infer verification authority from an agent name, persona, preset label, or task ownership.

#### Scenario: Explicit admin permission enables autonomous completion

- **WHEN** the active agent's check-in permissions include `task:admin` and all required verification has passed
- **THEN** Quick Dev performs admin verification and autonomously continues the remaining workflow

#### Scenario: Role label without permission does not enable autonomous completion

- **WHEN** an agent appears to be an administrator by name or persona but its check-in permissions do not include `task:admin`
- **THEN** Quick Dev uses the non-admin human handoff path

### Requirement: Non-admin Quick Dev hands verification to a human asynchronously

When the active agent lacks `task:admin`, Quick Dev SHALL submit the task for verification, post a Task comment summarizing acceptance-criteria results and independent-review evidence, @mention the responsible human with the required verification action, and end the current turn. It MUST NOT poll for a response or silently rely only on generic notifications.

#### Scenario: Non-admin posts an actionable handoff

- **WHEN** implementation and independent review pass but the active agent lacks `task:admin`
- **THEN** Quick Dev comments on the Task with verification evidence, @mentions the responsible human to perform admin verification, and ends the turn

#### Scenario: Headless execution does not block for input

- **WHEN** Quick Dev runs in a headless daemon session without `task:admin`
- **THEN** it routes the request through the Task comment and terminates the turn without invoking an interactive prompt or waiting synchronously
