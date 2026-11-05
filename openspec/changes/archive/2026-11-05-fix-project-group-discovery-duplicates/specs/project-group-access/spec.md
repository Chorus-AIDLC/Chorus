## ADDED Requirements

### Requirement: Visible exact-name creation conflicts
Project group creation SHALL reject an exact stored-name match within the caller's visible same-company groups with CONFLICT/409, without changing group, membership or audit data. Visibility SHALL include owner-backed roles, automatic administration and child-only discovery. Hidden same-name groups MUST NOT cause a name conflict or be disclosed.

#### Scenario: Visible private group outside first page
- **WHEN** an agent creates a group matching a private group visible to its owner on a later page
- **THEN** creation fails with CONFLICT and commits no group, member, audit or change event

#### Scenario: Hidden or foreign names
- **WHEN** a matching name exists only in an inaccessible private group or another company
- **THEN** that group does not cause a name conflict and its metadata is not disclosed

#### Scenario: Exact names and legacy data
- **WHEN** names differ in case, whitespace or Unicode stored form, or existing groups are renamed
- **THEN** this creation-only guard does not normalize names, constrain renaming or rewrite existing duplicate groups

### Requirement: Transactional visible-name creation guard
The visibility check, name check and group writes SHALL share a Serializable transaction. P2034 and verified DriverAdapterError/TransactionWriteConflict failures SHALL be retried at most three times after the initial attempt; other errors SHALL not be retried. Change events SHALL occur only once after successful commit.

#### Scenario: Concurrent same-owner creation
- **WHEN** two same-owner requests concurrently create the same group name
- **THEN** at most one commits and the other detects the visible duplicate after serialization retry

#### Scenario: Exhausted retries
- **WHEN** all four attempts fail serialization or a non-retryable failure occurs
- **THEN** the failure is surfaced and no successful-create event is emitted

### Requirement: Deterministic complete group discovery guidance
Group listing SHALL retain its access filters and collection contract and order by createdAt then uuid ascending. MCP guidance SHALL instruct callers to traverse all pages before assuming a group is absent; a bounded search miss MUST NOT be treated as proof of absence. No snapshot across concurrent changes is promised.

#### Scenario: Owner-visible private group on page two
- **WHEN** 24 groups are visible and a private group sorts after the first 20, including tied creation times
- **THEN** pages one and two return all 24 exactly once in deterministic order with correct visible totals

#### Scenario: No permission bypass
- **WHEN** an agent has project:admin but its owner has no effective access to a private group
- **THEN** list and duplicate checks do not disclose that group
