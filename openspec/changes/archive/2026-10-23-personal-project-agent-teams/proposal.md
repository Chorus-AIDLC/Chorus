# Personal Project Agent Teams

## Why
Private Team templates currently cannot express a user's working team within a project. Users need reusable role membership and a safe, explicit handoff of their own unfinished Ideas without affecting colleagues or granting access.

## What Changes
- Add one private Team configuration per project and user. Human owners configure; their agents read using their owner identity. Project administrators receive no privilege over another user's configuration.
- Inherit template memberships by role, allow complete per-role overrides and explicit empty lists, and restore inheritance. All roles can be empty; missing roles preserve the existing manual workflow.
- Validate newly applied memberships against ownership, current role permissions and project access. Display later eligibility drift without implicit reassignment.
- Provide explicit preview/confirmation handoff to one eligible lead, limited to unfinished Ideas currently assigned to the user or their agents/instances; preserve lifecycle and Tasks.
- Freeze the last effective membership on template deletion; unbinding never rolls back assignments.
- Add localized project UI, private checkin context and a read-only MCP tool, accompanying documentation/skills and light/dark design frames.

## Capabilities
### New Capabilities
- `personal-project-agent-teams`: private project configuration, role inheritance, lifecycle, safe handoff and agent context.
### Modified Capabilities
None. Existing template deletion and checkin requirements remain valid; this adds dependent snapshot handling and additive context.

## Impact
Prisma migration, Team services, project REST endpoints, project settings UI, checkin/MCP registration and contract manifests, tests, `docs/MCP_TOOLS.md`, plugin skill documentation, and `docs/design.pen`. No new package dependency. Public/shared teams, automatic routing, independent reviewer wakeups and automatic fallback assignment remain out of scope.

## Acceptance
Two users in one project cannot see or change each other's Team. A viewer can configure personal preferences but cannot hand off Ideas. All-empty teams work. Agent reads resolve their owner's configuration. Handoff is previewed, race-checked, scoped to owned assignees and leaves task execution unchanged. Inheritance, overrides, drift and deletion snapshots survive reloads.
