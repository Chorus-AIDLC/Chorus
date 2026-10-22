# host-skill-workflow-parity Specification

## Purpose
TBD - created by archiving change align-host-skill-workflows. Update Purpose after archive.

## Requirements

### Requirement: Safe completion reporting across hosts
All eight host skill surfaces SHALL teach completion reporting without status mutation followed by acceptance self-check and `chorus_submit_for_verify`. Relevant develop, quick-dev and yolo examples SHALL NOT prematurely report `to_verify`.

#### Scenario: Normal task completion
- **WHEN** an agent follows completion instructions on any supported host
- **THEN** the completion report omits status and submission performs the transition from in_progress to to_verify

#### Scenario: Recovering a premature transition
- **WHEN** the assignee confirms a task was prematurely moved rather than legitimately submitted
- **THEN** guidance permits an assignee/dependency-checked return to in_progress, explains that both developer and admin acceptance marks and evidence are cleared, and requires repeating self-check before submission

#### Scenario: Legitimate pending verification
- **WHEN** a task was correctly submitted and awaits verification
- **THEN** recovery guidance SHALL NOT instruct a mechanical rollback

### Requirement: Explicit task-draft classification and dependency guidance
Every existing proposal, yolo, openspec-aware and spec-lite authoring skill on each host SHALL provide task-draft kind examples and actionable validation guidance. Standalone `public/skill` has proposal/yolo but no independent openspec-aware/spec-lite skills; parity covers its existing authoring paths without adding new spec modes. Supported kinds are implementation, verification, docs and other. Omitting kind on update preserves the existing value; kind is not copied to materialized tasks.

#### Scenario: Alternate authoring path
- **WHEN** an agent creates task drafts through yolo, OpenSpec or spec-lite
- **THEN** it has a concrete add-task-draft example containing kind and guidance for updates without adding kind to non-draft Task APIs

#### Scenario: Dependency validation fails
- **WHEN** validation reports E-DEP-UNKNOWN, E-DEP-SELF or E-DEP-CYCLE
- **THEN** the guidance repairs foreign/unknown draft UUIDs, self edges or cycles respectively and revalidates before submission

### Requirement: Contextual proposal review
All host proposal reviewers SHALL inspect dependency integrity and actual implementation coverage. E-DEP errors block submission, while I-KIND and W-IMPL retain advisory semantics.

#### Scenario: Implementation work missing
- **WHEN** proposal scope requires implementation but task coverage omits it
- **THEN** the reviewer reports a blocker and requests real implementation coverage

#### Scenario: Justified non-implementation scope
- **WHEN** a docs-only or verification-only proposal justifies not needing implementation
- **THEN** the reviewer allows that scope without inventing an implementation task to silence W-IMPL

### Requirement: Regression coverage and release boundary
Static regression tests SHALL cover all eight surfaces and preserve native host syntax. Version bumps and publication SHALL remain in a separately tracked release follow-up pending version selection.

#### Scenario: Reintroduced workflow drift
- **WHEN** a completion-report call prematurely changes status or an authoring/reviewer surface loses required guidance
- **THEN** a focused static regression check fails for the affected surface

#### Scenario: Implementation delivery
- **WHEN** the implementation is verified
- **THEN** the report distinguishes verified local changes from the still-unpublished release follow-up, without claiming publication or bumping versions
