## ADDED Requirements

### Requirement: Company Deletion Detaches Idea Lineage

Deleting a company SHALL succeed even when the company holds ideas linked by lineage (`parentUuid`) at any depth. Within the same transaction, before the company's ideas are deleted, the system MUST set `parentUuid` to null on every idea of that company that has a parent. The system SHALL NOT read or modify ideas belonging to any other company. The `IdeaLineage` relation SHALL remain non-cascading.

#### Scenario: Deleting a company with a multi-level idea tree

- **WHEN** a company whose project contains ideas A → B → C (C child of B, B child of A) is deleted
- **THEN** the deletion succeeds without a `P2014` error and the company, its projects and all of its ideas are removed

#### Scenario: Other tenants are unaffected

- **WHEN** company X is deleted while company Y holds its own idea parent/child tree
- **THEN** company Y's ideas still exist with their `parentUuid` links unchanged

#### Scenario: Missing company performs no writes

- **WHEN** `deleteCompany` is called for a company id that does not exist
- **THEN** it fails with "Company not found" and no idea is modified
