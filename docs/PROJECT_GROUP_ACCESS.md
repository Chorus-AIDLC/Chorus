# Project group access

Groups and projects have `public` or `private` visibility. A Private group can
contain only Private projects. A Public group can contain either kind.

## Effective roles

Group membership contains explicit `viewer`, `editor`, or `admin` grants.
Projects reference these grants live; changing a group member changes their
access to every child immediately. A project's local membership can add access
or raise the effective role:

```text
Private project: max(explicit group role, local project role)
Public project:  max(Editor baseline, explicit group role, local project role)
```

The Public group's implicit company access does not propagate into Private
children. Explicit group Admins are Admins of every child, including Public
children. Project member operations cannot change the referenced group grant.

| Effective project role | Read | Write content, approve proposals, verify tasks | Manage private settings, members, visibility |
|---|---|---|---|
| Viewer | Yes | No | No |
| Editor | Yes | Yes | No |
| Admin | Yes | Yes | Yes |

Public projects keep their ordinary company editing behavior. Visibility and
membership changes always require effective project Admin. Public group settings
keep ordinary company editing; group access administration always requires
explicit group Admin.

Agents resolve group and project grants through their owner and must also carry
the operation's capability bit. Ownerless agents have only Public access.

A user with only a local membership in a Private child may see the group's name,
description and grouping context. Group project lists, counts, dashboard and
activity contain only projects that user can access. This discovery does not
grant group creation, administration or roster access.

## Creation and existing groups

Creating a group gives its human creator, or the Agent's owner, explicit group
Admin. Creating a project inside a group defaults to that group's visibility.
An explicit Public project request in a Private group is rejected. Explicit
group Editors and Admins can create Private children; the project creator keeps
the existing local project Admin grant and does not become group Admin.

The migration adds group access fields and membership storage without rewriting
existing project visibility, local memberships or grouping. Existing groups
remain Public and have no automatically selected group Admin. Initialize access
explicitly with `initializeAccess: true`; the acting principal must already be
Admin of every contained project. If necessary, existing project Admins can first
grant a common principal local Admin. Initialized groups retain at least one
explicit Admin.

## Preview and confirmation

Group visibility transitions, project visibility transitions and access-changing
moves return an access preview before execution. The preview reports company
access changes and user role changes, with a `confirmationToken`.

The token is bound to the actor, operation, source and target, visibility,
membership configuration and versions. It does not grant authority. Execution
locks and rechecks authority and recomputes the preview; missing, stale or
mismatched confirmation returns `409` without applying the requested changes.
Fetch a new preview and ask the administrator to confirm its current impact.

Changing a group from Public to Private atomically converts every Public child
to Private. Local grants remain and explicit group grants continue live.
Changing a group from Private to Public preserves every child's visibility and
both membership layers.

A move involving a Private project or group requires source group Admin, or
ungrouped project Admin, and target group Admin. A Public move that raises any
effective role additionally requires source-project Admin confirmation.
Ordinary Public editing permits a Public move whose effective access does not
expand. A Public project moving into a Private group becomes Private atomically.

Detaching a Private project or deleting its group while keeping projects
materializes every maximum effective grant as a local project membership. This
preserves Private visibility and project administration.

## REST contracts

Every endpoint is company scoped and authenticated. Hidden resources return
`404`; visible resources with insufficient authority return `403`.

| Endpoint | Operation |
|---|---|
| `POST /api/project-groups` | Create with `name`, optional `description`, optional `visibility` |
| `GET /api/project-groups` | Discoverable groups and accessible project counts |
| `GET /api/project-groups/:uuid` | Basic metadata, accessible children and access presentation |
| `GET /api/project-groups/:uuid/dashboard` | Accessible projects, counts and activity |
| `PATCH /api/project-groups/:uuid` | Settings, `initializeAccess`, or `visibility` plus `confirmationToken` |
| `GET /api/project-groups/:uuid/access-preview?visibility=private` | Group transition preview |
| `GET /api/project-groups/:uuid/members` | `{ members: [...] }` containing explicit grants; explicit membership required |
| `POST /api/project-groups/:uuid/members` | Add `{ userUuid, role }`; explicit Admin required |
| `PATCH /api/project-groups/:uuid/members/:userUuid` | Change `{ role }`; explicit Admin required |
| `DELETE /api/project-groups/:uuid/members/:userUuid` | Remove explicit grant; protect last Admin |
| `DELETE /api/project-groups/:uuid` | Keep and detach projects; `?deleteProjects=true` selects deletion |
| `GET /api/projects/:uuid/access-preview?visibility=public` | Individual project transition preview |
| `PATCH /api/projects/:uuid` | Visibility with `confirmationToken`; accompanying settings commit together |
| `GET /api/projects/:uuid/group/preview?groupUuid=:target` | Move preview; empty or `null` target detaches |
| `PATCH /api/projects/:uuid/group` | `{ groupUuid, confirmationToken }` |

Group presentation includes `visibility`, `accessLevel`, `explicitRole`,
`canManage`, `canCreateProject` and `accessInitialized`. `canManage` covers
ordinary group settings; access administration uses explicit Admin.
Project member responses expose `source`, `directRole`, `inheritedRole` and
`effectiveRole` for grouped projects. An inherited-only row is informational and
cannot be removed as a local grant.

## MCP and live delivery

The existing group create, update, delete and move tools invoke the same guarded
services. Update and move accept `preview: true`; execute with the returned
`confirmationToken`. Group update also supports explicit member operations.
Capability gates remain separate from group and project roles.

Search, exact UUID lookup, group headers and MCP discovery filter hidden groups
and projects. Projectless group metadata events are discovery filtered. Group
member changes refresh access on every child before subsequent SSE delivery.
Notification and mention recipients include explicit group and local members;
Agent recipients resolve through their owner. Task assignment requires effective
Editor, so a Viewer cannot become an editing assignee.

Live daemon delivery and pending-turn backfill recheck current project access.
Standalone tasks and comments resolve their project from the session's entity
identifier even when they have no Idea ancestor. Deleted or unresolved autonomous
origins fail closed; genuinely projectless human conversations remain available.

## Verification

Run database acceptance only against an isolated migrated PostgreSQL database:

```sh
PROJECT_GROUP_DATABASE_URL=postgresql://localhost/isolated_test \
  pnpm test src/__tests__/integration/project-group-access.database.integration.test.ts

PRIVATE_PROJECT_DATABASE_URL=postgresql://localhost/isolated_test \
  pnpm test src/__tests__/integration/private-project-access.database.integration.test.ts
```

Without the opt-in variables these suites are skipped. Each suite creates a
separate test company and removes its own rows. Group acceptance exercises real
REST, services, MCP and PostgreSQL locks, with authentication, framework/session
and event transport adapters substituted. Browser acceptance uses the running application
with separate Admin, Editor, Viewer, project-only and outsider sessions.
