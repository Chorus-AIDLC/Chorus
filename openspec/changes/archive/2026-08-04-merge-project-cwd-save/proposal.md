## Why

Project creation already submits validated Agent cwd selections with the new
Project, but Project settings still saves each cwd replacement or clear
immediately through a separate action. Users must therefore save cwd and Project
metadata independently, and cwd failures are detached from the main save flow.

## What Changes

- Treat Agent cwd selection, replacement, and clearing as drafts in both create
  and edit forms.
- Persist Project metadata and all cwd draft changes from the single Create
  Project or Save Changes action.
- Validate every non-empty cwd before the Project mutation; keep the form open
  and show the error beside the affected Agent cwd editor when validation fails.
- Remove the independent cwd Save behavior from Project settings.
- Add transactional service and focused UI/service regression coverage for
  create and update flows.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `project-agent-cwd`: Project settings changes from independently persisted cwd
  controls to one validated Project save transaction.

## Impact

The change affects the shared Project Agent cwd settings component, Project
settings modal and server action, Project cwd service transaction boundary,
Project API/action contracts, translations, and focused Vitest coverage. It
does not change the database schema or daemon directory-validation protocol.
