## ADDED Requirements

### Requirement: Wake failures are saved on their own terminal turn

The server SHALL accept an optional validated `wakeError` on daemon turn reports and persist it only on an interrupted crash/invalid-path turn. Existing clients MAY omit it. The error SHALL remain independent of transcript-relay failures and SHALL appear in ordinary and paginated transcript reads. Exact turn correlation, operation admission, ownership fencing and idempotent terminal retries SHALL continue to apply.

#### Scenario: A runtime failure follows a partial reply
- **WHEN** a daemon reports a failed turn with both a partial assistant reply and a wake diagnostic
- **THEN** the server SHALL retain both the reply and diagnostic on that same turn
- **AND** reads after refresh SHALL return the diagnostic

#### Scenario: An ordinary wake fails before a child is created
- **WHEN** an attempted ordinary wake fails at setup or spawn without invoking the child callback
- **THEN** the daemon SHALL record its attempt through the existing running edge and finalize that exact admitted turn as interrupted with its error
- **AND** no unrelated running or queued turn SHALL receive that error

#### Scenario: A dedicated operation fails before launch
- **WHEN** a dedicated operation fails before launch
- **THEN** its existing exact-turn admission/launch-abort mechanism SHALL carry the error
- **AND** rejected operations SHALL NOT bypass their eligibility or origin fences

#### Scenario: A terminal failure report is retried
- **WHEN** the same correlated terminal report is received again
- **THEN** the original persisted error SHALL remain and lifecycle/usage side effects SHALL NOT run twice

#### Scenario: A nonfailure report includes a stray diagnostic
- **WHEN** a running, ended, user-interrupted, shutdown or offline report includes a diagnostic
- **THEN** the diagnostic SHALL NOT be saved as a wake failure

#### Scenario: An error payload is malformed or oversized
- **WHEN** an HTTP diagnostic violates its field types, bounds, enumerations or allowed keys
- **THEN** the existing validation error response SHALL reject it without changing a turn

#### Scenario: A successful session-conflict fallback follows a failed attempt
- **WHEN** the daemon's existing deterministic Claude conflict fallback succeeds
- **THEN** the overall turn SHALL finish successfully without retaining the first attempt's wake error
