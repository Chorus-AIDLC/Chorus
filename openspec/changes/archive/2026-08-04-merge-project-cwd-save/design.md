## Context

`CreateProjectDialog` already collects validated cwd drafts and sends their
validation request UUIDs to `POST /api/projects`, where
`createProjectWithAgentCwds` resolves them before creating the Project and
preferences in one transaction. In edit mode, `ProjectAgentCwdSettings` instead
calls the Agent cwd `PUT` and `DELETE` endpoints immediately, while
`ProjectSettingsModal` separately calls `updateProjectAction`.

Validation request UUIDs are short-lived proof that a daemon accepted and
normalized a path. Existing saved preferences do not need revalidation unless
the user replaces them; unchanged preferences remain authoritative.

## Goals / Non-Goals

**Goals:**

- Make Create Project and Save Changes the only commit actions for Project cwd
  configuration.
- Apply metadata, cwd upserts, and cwd clears atomically.
- Associate validation failures with the affected Agent editor without
  discarding drafts.
- Preserve unchanged preferences and existing create behavior.

**Non-Goals:**

- Change daemon path validation, preference ownership, or runtime cwd routing.
- Revalidate every unchanged saved preference on every metadata edit.
- Add a database migration or a new public API endpoint.

## Decisions

### Use an explicit cwd mutation set

The shared settings component emits a complete edit intent with validated
upserts and explicit Agent UUID clears. This distinguishes an untouched
preference from one the user deliberately removed.

Alternative: submit a full desired-state list and infer deletions. Rejected
because offline configured Agents and partially loaded state make omission
ambiguous.

### Resolve validations before one database transaction

The service resolves every submitted validation request first, then updates the
Project, upserts selected preferences, and deletes cleared preferences in one
transaction. No Project fields change if any validation is stale or invalid.

Alternative: reuse sequential metadata and cwd endpoint calls. Rejected because
partial success recreates the two-save inconsistency.

### Return structured Agent-scoped errors

The action maps cwd service failures to an optional Agent UUID and message. The
modal keeps drafts mounted and passes that error to the shared settings
component for inline rendering.

Alternative: display only a modal-level error. Rejected because users cannot
identify which cwd failed when several Agents are configured.

### Keep directory confirmation as selection, not persistence

The Directory Browser confirmation still validates and normalizes the path, but
in a Project form it only updates local draft state. Its label describes
selection rather than saving; the outer Project action performs persistence.

## Risks / Trade-offs

- [Validation expires before Save] -> Keep the form and affected draft visible,
  show the stale validation inline, and let the user reselect the directory.
- [Multiple cwd edits make error attribution unclear] -> Carry Agent UUID on
  each draft and on mapped service errors.
- [Removing immediate clear surprises users] -> Reflect clears immediately in
  local form state and commit them with the clearly labeled outer Save action.

## Migration Plan

No data migration is required. Deploy the service/action contract and UI
together. Rollback restores immediate cwd endpoints; persisted preferences
remain compatible.

## Open Questions

None.
