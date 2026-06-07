# task-edit-ui Specification

## Purpose
TBD - created by archiving change align-task-edit-ui-with-draft. Update Purpose after archive.
## Requirements
### Requirement: Structured acceptance-criteria editing in the Task panel

The real-Task edit form SHALL edit acceptance criteria as structured items — each with a
text description and a `required` flag — using the same controls as the Task Draft panel
(a description input, a required toggle, and per-row delete plus an add control). The form
SHALL NOT present acceptance criteria as a single free-text / Markdown field.

#### Scenario: Editor seeded from existing structured criteria

- **WHEN** a user opens the edit form for a task that has structured acceptance criteria
- **THEN** the editor shows one editable row per existing criterion, each pre-filled with
  its description and its required/optional state

#### Scenario: Add, reword, and remove criteria

- **WHEN** the user adds a row, edits a description, toggles `required`, or deletes a row
  and saves
- **THEN** the task's structured acceptance criteria reflect exactly the edited set

#### Scenario: Same editor component as the draft panel

- **WHEN** acceptance criteria are edited in the Task panel and in the Task Draft panel
- **THEN** both surfaces render the same editor component, so their controls and behavior
  are identical

### Requirement: Acceptance-criteria edits persist via the existing replace path

Saving structured acceptance-criteria edits from the Task panel SHALL persist them by
replacing the task's acceptance-criteria set through the existing service path
(`replaceAcceptanceCriteria`), reached by extending the existing task-fields update action
with an optional structured-criteria field. No new persistence service, REST endpoint, or
database schema change SHALL be introduced.

#### Scenario: Saving edited criteria replaces the set

- **WHEN** the user changes the acceptance criteria and saves
- **THEN** the task's stored acceptance-criteria items are replaced with the edited set
  and the panel reflects the new items

#### Scenario: Empty criteria set is rejected in the UI

- **WHEN** the user removes all acceptance criteria (or leaves only blank rows) and the set
  has changed, then attempts to save
- **THEN** the form blocks the save and shows the existing "acceptance criteria required"
  validation message instead of failing on the server

### Requirement: Verification marks preserved when criteria are unchanged

Editing the Task panel SHALL only trigger an acceptance-criteria replacement when the
criteria set actually changed (by description, required flag, or order). Editing other
fields SHALL NOT disturb existing dev or admin verification marks on the criteria.

#### Scenario: Editing only the title preserves verification marks

- **WHEN** a task has criteria with existing dev/admin pass-or-fail marks, and the user
  edits only the title (or another non-AC field) and saves
- **THEN** the acceptance-criteria replacement is not invoked and all existing verification
  marks remain intact

#### Scenario: Changing criteria resets verification marks

- **WHEN** the user adds, removes, reorders, or modifies a criterion and saves
- **THEN** the acceptance-criteria set is replaced and prior verification marks are reset,
  reflecting that the definition of done changed

