## Why

Project access already supports Public/Private and Viewer/Editor/Admin, but groups only organize projects. People must maintain grants project by project, and a group cannot be private. The approved elaboration calls for live group membership inheritance, with project grants that can increase access without reducing inherited roles. The precedent is [PR #589](ref:2f65eb3d-99a6-40ba-832a-cc7364a33b41).

## What Changes

- Add group visibility and explicit user roles. Agents inherit their owners and still require their capability bits.
- Resolve a project's private role as `max(explicit group role, explicit project role)`. Group Admin is always Admin on every grouped project. Public-group implicit company access never propagates to private projects.
- Permit project-only members to discover the private group's basic information and only the projects, activities and aggregates they can access. They receive no group management authority.
- Enforce that private groups contain only private projects. Public→Private converts all public projects atomically after an access-impact preview and confirmation. Private→Public retains project visibility and both grant layers.
- Provide group member/visibility management, inherited membership provenance, group lock badges and creation/move restrictions in mobile and both themes.
- Preserve existing project visibility, grouping and membership rows. Existing groups remain public; legacy group administration is initialized explicitly, only by an actor authorized to administer every private project in that group.
- Preserve effective private memberships on ungrouping or deleting a group while retaining projects; check source/target administration and confirm access changes on boundary moves.

## Capabilities

### New Capabilities
- `project-group-access`: group roles, discovery, lifecycle, inheritance, transitions and isolation.

### Modified Capabilities
- `project-access-control`: effective grouped membership and inherited administration extend project access and membership UI.

## Impact

Prisma schema/migration; shared project/group access services; project/group/member services; REST and server actions; MCP permission gates and administration; search and lists; SSE, mention, notification and assignment recipient checks; group/project UI; all four locales. No new dependency, skill, or MCP service is needed. Existing MCP group tools are extended rather than replacing the collaboration workflow.

## Acceptance

All permission examples from the 13 human answers must pass as users and owner-backed agents. Hidden groups/projects return 404; visible-but-insufficient administration returns 403. Real PostgreSQL tests must cover concurrency, transitions, private-only groups, retained local grants after group revocation, filtered project-only group views and last-admin retention. Independent proposal, task and aggregate code review are required before completion. No PR push or merge is authorized.
