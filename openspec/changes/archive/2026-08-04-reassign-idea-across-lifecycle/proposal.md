## Why

Idea Tracker currently disables its assignee control after an Idea reaches the
`elaborated` lifecycle state. The server actions and service layer enforce the
same restriction, so completed Ideas cannot be moved to a different owner for
maintenance, attribution, or follow-up work.

## What Changes

- Keep the assignee block interactive for every Idea lifecycle stage.
- Allow the existing self, agent, user, and release assignment paths to operate
  on elaborated Ideas.
- Reuse the current candidate lists, authorization checks, instance pin
  resolution, activity recording, and wake behavior.
- Preserve the Idea's lifecycle and derived status when its assignee changes.
- Do not cascade an Idea assignment change to linked Proposals or Tasks.
- Add focused UI, server-action, and service regression tests.

## Capabilities

### New Capabilities

- `idea-lifecycle-assignment`: Reassign or release an Idea at any lifecycle
  stage without changing its workflow state or linked work ownership.

### Modified Capabilities

- None.

## Impact

The change affects the dashboard Idea detail assignee control, Idea assignment
server actions, and the core Idea assignment/release service guards. It does
not change schemas, candidate discovery, role permissions, Proposal ownership,
Task ownership, or lifecycle transition rules.
