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

The tests-that-cannot-fail dimension SHALL treat a test offered as covering an acceptance criterion, which asserts only that a mock was called or asserts a tautology, as leaving that criterion unverified.

#### Scenario: New code duplicates an existing utility
- **WHEN** the diff adds a helper that duplicates one already present in the repository
- **THEN** the reviewer raises a BLOCKER and names the existing utility and where it lives

#### Scenario: A brevity opinion with nothing named
- **WHEN** the reviewer believes code could be shorter but cannot name an existing platform feature, library, or repository utility that replaces it
- **THEN** it does not raise a finding

#### Scenario: A single task introduces a security defect
- **WHEN** one task's own code omits an authorization check or omits tenant scoping on a query
- **THEN** the task reviewer raises a BLOCKER rather than leaving it to the aggregate code reviewer

#### Scenario: A test asserts only that a mock was called
- **WHEN** the only test offered for an acceptance criterion asserts that a mock was invoked
- **THEN** the reviewer treats that criterion as unverified and raises a BLOCKER

#### Scenario: An error is swallowed
- **WHEN** the diff contains an empty catch, an error that is logged and then discarded, or a failure path that returns success
- **THEN** the reviewer raises a BLOCKER

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

