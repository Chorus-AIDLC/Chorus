## ADDED Requirements

### Requirement: Project Deletion Detaches Idea Lineage

Deleting a project — directly, or by deleting a project group with `deleteProjects=true` — SHALL succeed even when the project contains ideas linked by lineage (`parentUuid`) at any depth. Within the same transaction, after permission checks and before the project rows are deleted, the system MUST set `parentUuid` to null on every idea in the same company whose parent idea belongs to a project being deleted, regardless of which project the child idea belongs to. Ideas outside the deleted projects SHALL survive as top-level ideas. Deleting a project group with `deleteProjects=false` SHALL NOT modify any idea or lineage. The `IdeaLineage` relation SHALL remain non-cascading.

#### Scenario: Deleting a project with a multi-level idea tree

- **WHEN** a project containing ideas A → B → C (C child of B, B child of A) is deleted by an authorized user
- **THEN** the deletion succeeds without a `P2014` error and A, B and C are removed with the project

#### Scenario: Deleting a project group together with its projects

- **WHEN** a project group whose projects contain idea parent/child trees is deleted with `deleteProjects=true`
- **THEN** the group and all of its projects, including their ideas, are deleted successfully

#### Scenario: Deleting a project group but keeping its projects

- **WHEN** a project group is deleted with `deleteProjects=false`
- **THEN** its projects remain with `groupUuid` null, and all their ideas and `parentUuid` links are unchanged

#### Scenario: Child idea outside the deleted project survives

- **WHEN** a project is deleted and an idea in another project of the same company has its `parentUuid` pointing to an idea in the deleted project
- **THEN** that idea still exists afterwards with `parentUuid` null

#### Scenario: Unauthorized or failed delete leaves lineage intact

- **WHEN** a project delete is rejected by the permission check, or the delete fails inside the transaction
- **THEN** no idea's `parentUuid` is changed

#### Scenario: Other tenants are unaffected

- **WHEN** a project in company X is deleted
- **THEN** no idea belonging to any other company is read or modified
