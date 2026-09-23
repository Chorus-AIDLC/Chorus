# task-review-default-quality Specification

## Purpose
TBD - created by archiving change task-gate-default-quality-review. Update Purpose after archive.
## Requirements
### Requirement: The task gate checks correctness and quality without requiring an acceptance criterion
Every task-reviewer definition SHALL state that the acceptance criteria are a floor and not a ceiling: because the criteria are authored before the code exists, they describe what to build and never how well it was built, so a defect that depends on the code as written cannot be expressed as a criterion. A reviewer SHALL NOT withhold a finding on the grounds that no acceptance criterion covers it.

#### Scenario: A bug no criterion mentions
- **WHEN** the task reviewer finds behaviour in this task's diff that is simply wrong, and no acceptance criterion speaks to it
- **THEN** it raises a BLOCKER, without requiring an acceptance criterion to justify the finding

#### Scenario: Every acceptance criterion passes
- **WHEN** every acceptance criterion is met but the diff contains a defect in one of the default dimensions
- **THEN** the verdict is not PASS on the strength of the criteria alone

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

### Requirement: Quality findings are bounded by a nameable-defect severity rule
Every task-reviewer definition SHALL state that a quality finding is a NOTE by default and becomes a BLOCKER only when the reviewer can name the concrete defect — the duplicated utility and its location, the missing check, the assertion that cannot fail. Taste SHALL NOT block: a finding the reviewer cannot point at is a NOTE or is not reported. The definition SHALL require the cheapest concrete change to be proposed rather than a redesign.

Maintainability, leftover code, diff hygiene, loose contracts on the interface the task owns, and obvious performance defects SHALL be NOTE-level, escalating only when they make an acceptance criterion unverifiable or change behaviour outside the task's scope.

No task-reviewer definition SHALL retain a rule restricting BLOCKER severity to functional or behavioural issues alone, because that contradicts the reimplementation, verification-integrity, and security dimensions above.

#### Scenario: Deep nesting with no other consequence
- **WHEN** the reviewer finds a deeply nested function that is nonetheless correct and does not affect any criterion
- **THEN** it raises a NOTE, not a BLOCKER

#### Scenario: Loose typing makes a criterion unverifiable
- **WHEN** an untyped escape hatch on the interface the task owns makes an acceptance criterion impossible to verify
- **THEN** the NOTE-level default escalates to a BLOCKER

#### Scenario: The superseded severity restriction
- **WHEN** a task-reviewer definition's classification rules are read
- **THEN** they do not state that only functional or behavioural issues may be BLOCKERs
- **AND** they state that a quality finding blocks only when the concrete defect can be named

