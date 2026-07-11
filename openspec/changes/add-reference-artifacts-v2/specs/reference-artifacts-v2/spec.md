## ADDED Requirements

### Requirement: Reference artifacts SHALL be linkable to ideas

The system SHALL accept `idea` as a `ReferenceArtifact.targetType` in addition to `proposal` and `task`. Creating a reference against an idea SHALL verify the idea exists within the caller's company and MUST reject the creation with a not-found error otherwise. Idea-linked references SHALL be gated by the same `document:write`/`document:read` permissions as proposal- and task-linked references (no new permission bit). No database migration SHALL be required.

#### Scenario: Reference is attached to an idea

- **WHEN** a reference artifact is created with `targetType` `idea` and a `targetUuid` of an existing idea in the same company
- **THEN** the artifact MUST be persisted linked to that idea and appear when references for that idea are listed

#### Scenario: Attaching to a non-existent idea is rejected

- **WHEN** a reference is created with `targetType` `idea` and a `targetUuid` that does not resolve to an idea in the caller's company
- **THEN** the creation MUST be rejected with a not-found error and no artifact MUST be persisted

#### Scenario: Idea references surface inline and on the idea detail view

- **GIVEN** an idea with linked reference artifacts
- **WHEN** `chorus_get_idea` is called for it, or a user opens the idea detail panel
- **THEN** the `chorus_get_idea` response MUST include the artifacts in a `references` array, and the detail panel MUST render them (with the same add/edit/delete affordances used for proposals/tasks)

### Requirement: The idea tracker SHALL surface a per-idea reference count and a collapsible reference panel

The system SHALL expose a `referenceCount` for each idea in the idea-tracker payload, and the tracker UI SHALL present references as a collapsible panel whose collapsed state shows the count and whose expanded state shows a read-only list of that idea's references. The tracker panel SHALL NOT provide add/edit/delete controls; reference mutation remains on the idea detail view.

#### Scenario: Collapsed tracker panel shows the count

- **GIVEN** an idea with 3 linked references
- **WHEN** its row renders in the idea tracker
- **THEN** the collapsed reference panel MUST show the count (3), and an idea with 0 references MUST NOT show a misleading non-zero indicator

#### Scenario: Expanding reveals a read-only list

- **WHEN** the user expands an idea's reference panel in the tracker
- **THEN** the idea's references MUST be listed (type, title/link, notes) read-only, with no add/edit/delete controls in the panel

### Requirement: Creation tools SHALL accept an inline references array

The system SHALL allow `chorus_pm_create_idea`, `chorus_pm_create_proposal`, and `chorus_create_tasks` to accept an optional inline `references` array so that references can be attached at creation time without a separate call. Each supplied reference SHALL be materialized and linked to the newly created entity after it is persisted. The standalone `chorus_add_reference`, `chorus_update_reference`, and `chorus_remove_reference` tools SHALL be retained for post-hoc attach/edit/remove. A reference that fails validation SHALL NOT abort creation of the host entity; the entity SHALL still be created and the failed reference SHALL be reported.

#### Scenario: Idea created with inline references

- **WHEN** `chorus_pm_create_idea` is called with a `references` array of valid items
- **THEN** the idea MUST be created and each reference MUST be linked to it, retrievable via the idea's `references`

#### Scenario: Tasks created with inline references

- **WHEN** `chorus_create_tasks` is called with per-task `references`
- **THEN** each created task MUST have its references linked to its real task UUID

#### Scenario: A bad inline reference does not lose the entity

- **WHEN** a creation call includes one invalid reference (e.g. a non-web URL) among valid ones
- **THEN** the host entity MUST still be created, the valid references MUST be linked, and the invalid one MUST be reported rather than aborting the whole call

#### Scenario: Post-hoc attach still works

- **WHEN** an agent later calls `chorus_add_reference` for an already-created idea, proposal, or task
- **THEN** the reference MUST be attached — the inline-at-creation path does not remove the standalone write tools
