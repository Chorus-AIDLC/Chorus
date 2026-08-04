## Context

Idea assignment is gated independently in three places:

1. `AssigneeSection` is passed `editable={idea.status !== "elaborated"}` by the
   dashboard Idea detail panel.
2. The Idea assignment server actions return an error before calling the
   service when `status === "elaborated"`.
3. `assignIdea` rejects elaborated Ideas except for the narrow same-agent
   instance-repin path, while `releaseIdea` only accepts open or elaborating
   Ideas.

The stored lifecycle is separate from assignment fields, so no data migration
is required.

## Goals And Non-Goals

### Goals

- Make the dashboard assignee block open the existing assignment modal for all
  lifecycle stages.
- Permit existing assignment and release operations for elaborated Ideas.
- Keep assignment audit activities and existing permission checks intact.
- Leave Idea status and linked Proposal/Task assignees unchanged.

### Non-Goals

- Adding new assignable users or agents.
- Changing who is authorized to assign an Idea.
- Cascading ownership to linked entities.
- Reopening a completed Idea.
- Introducing additional assignment notifications.

## Design

### UI

The dashboard Idea detail panel always passes `editable` to `AssigneeSection`
when an `onReassign` handler is present. The component keeps its existing
accessible button, tooltip, and assigned/unassigned labels. No new modal or
control is introduced.

The legacy `/ideas` detail panel retains its existing assignment entry point;
the shared modal behavior changes through the server actions.

### Server Actions

Remove the elaborated-status short circuits from:

- self assignment,
- agent assignment,
- user assignment, and
- release.

All existing authentication, company scoping, fixed-CWD resolution,
revalidation, and activity creation remain unchanged.

### Service Layer

`assignIdea` continues to validate the target Idea and optional AgentInstance,
then updates only assignment fields. The elaborated-status rejection is
removed. The existing instance-repin option remains accepted for compatibility
but is no longer needed to bypass a lifecycle guard.

`releaseIdea` clears assignment fields without transitioning lifecycle state.
It accepts elaborated Ideas in addition to open and elaborating Ideas.

### State And Side Effects

Assignment writes do not update `Idea.status`, `elaborationStatus`, Proposal
rows, or Task rows. Existing `assigned` activities continue to provide the
audit trail for assignment actions. Release keeps its current side effects.

## Risks And Mitigations

- **Unexpected workflow restart:** tests assert that assignment updates do not
  write lifecycle fields.
- **Ownership cascade:** focused service tests assert only the Idea assignment
  fields are updated.
- **Regression in instance pinning:** existing agent-instance tests continue to
  cover fixed-CWD and company validation paths.
- **Hidden UI gate remains:** the dashboard panel and `AssigneeSection` tests
  cover elaborated Ideas explicitly.

## Verification

Run focused Vitest suites for the assignee section, dashboard detail panel,
Idea actions, and Idea service. Then run TypeScript checks through the existing
test/build tooling as practical.
