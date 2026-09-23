# task-review-default-quality

## MODIFIED Requirements

### Requirement: The task gate names five BLOCKER-bearing default dimensions
Every task-reviewer definition SHALL name, as dimensions checked by default, at least: correctness where no criterion applies; reimplementation of functionality already available; security defects in the task's own code; tests that cannot fail; and silent failure. Each SHALL be BLOCKER-eligible.

The reimplementation dimension SHALL express a preference order — the platform's own feature, then the standard library or a dependency already present, then an existing utility in the repository, and only then new code — and SHALL require the already-available thing to be named when the finding is raised.

The security dimension SHALL cover defects a single task introduces on its own, and SHALL state that the reviewer does not defer them to the aggregate gate, whose security dimension is scoped to risk appearing only when tasks are combined.

The tests-that-cannot-fail dimension SHALL be defined by the test's **capability**, not by the mechanism it uses: the reviewer SHALL ask whether the test would fail if the behaviour under test were implemented wrongly, and SHALL raise a BLOCKER only when the answer is no. It SHALL NOT classify a test as unverifying merely because it asserts on a mock, a spy, or a call count — when the acceptance criterion is itself about invocation (a callback runs exactly once, a handler is not called on the error path), asserting the call is direct verification of that contract. The definition SHALL make the mutation question explicit rather than enumerating suspect mechanisms.

The silent-failure dimension SHALL apply only where a **required** operation's failure is masked, or where the masking violates a stated error contract. Deliberate, documented degradation SHALL be excluded: an operation explicitly optional or best-effort — telemetry, cache population, post-run reconstruction — whose failure is recorded and which is designed not to propagate is not a finding. The definition SHALL state that recording an error is itself the visibility that the no-silent-errors principle asks for, so "logged and not propagated" is not by itself a defect.

#### Scenario: New code duplicates an existing utility
- **WHEN** the diff adds a helper that duplicates one already present in the repository
- **THEN** the reviewer raises a BLOCKER and names the existing utility and where it lives

#### Scenario: A brevity opinion with nothing named
- **WHEN** the reviewer believes code could be shorter but cannot name an existing platform feature, library, or repository utility that replaces it
- **THEN** it does not raise a finding

#### Scenario: A single task introduces a security defect
- **WHEN** one task's own code omits an authorization check or omits tenant scoping on a query
- **THEN** the task reviewer raises a BLOCKER rather than leaving it to the aggregate code reviewer

#### Scenario: A call-count assertion that verifies the criterion
- **WHEN** the acceptance criterion is that a callback runs exactly once, and the only test asserts the mock was called exactly once
- **THEN** the reviewer does not raise a finding, because that assertion fails if the behaviour is implemented wrongly

#### Scenario: A test that passes under a wrong implementation
- **WHEN** a test offered as covering an acceptance criterion would still pass if the behaviour were implemented wrongly
- **THEN** the reviewer treats that criterion as unverified and raises a BLOCKER, whether or not a mock is involved

#### Scenario: A required operation's failure is masked
- **WHEN** the diff swallows a failure of an operation the feature depends on, or reports success on a path that failed
- **THEN** the reviewer raises a BLOCKER

#### Scenario: Documented best-effort degradation
- **WHEN** an operation is explicitly optional or best-effort, its failure is recorded, and it is designed not to propagate into the caller
- **THEN** the reviewer does not raise a finding
