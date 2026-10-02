## Context

`Project.groupUuid` exists but is not a Prisma relation. `ProjectMember` is the local grant layer. All entity APIs already delegate to `project-access.service.ts`; lists use `accessibleProjectWhere`, and recipients have additional member queries that must be extended. Group services currently company-scope group metadata and filter only their child project data.

## Decisions

### D1: Data model and upgrade

Add `ProjectGroup.visibility` default public, nullable `createdByUuid`, an `accessVersion` counter for confirmation freshness, and `ProjectGroupMember` (`companyUuid`, `groupUuid`, `userUuid`, role, timestamps, actor provenance; unique group/user). Add an indexed Project→ProjectGroup relation with Prisma-level deletion restricted, so deleting a group must explicitly handle its projects. Follow the repository's `relationMode = "prisma"` without adding database foreign keys. Historical orphan `Project.groupUuid` assignments must not prevent upgrade. Do not rewrite any Project or ProjectMember during migration.

An authorized project Admin can repair a historical missing/foreign-company group reference by confirming a move or detach. Preserve local grants and private visibility; only actual groups in the actor's company receive version updates and protected group audits. Destination authorization and locked confirmation remain unchanged.

New group creation records the user's identity (agent→owner) and a group Admin atomically. Ownerless agents cannot create private groups or bootstrap access administration. Existing groups have no automatically assigned membership: this avoids granting access to existing private projects. A `initializeAccess` action on an existing public group requires management authorization on every contained project and creates the acting principal as first group Admin in a locked transaction. If no single actor has that authority, project admins must first arrange a suitable common administrator using existing member management. Initialized groups cannot lose their last Admin.

### D2: Shared access contracts

Reuse `membershipPrincipal`, role ranks and typed 404/403 errors. Export transaction-capable project role resolution so project-member mutations re-check both grant sources inside their locks.

- Private project: max(explicit group role, local project role).
- Public project: max(editor baseline, explicit group role, local project role).
- Group management: use the actor's explicit group role; public groups preserve ordinary company editing, but changing group visibility/members always requires explicit Admin.
- Private group discovery: explicit group membership OR at least one readable child project. A project-only visitor receives `accessLevel: viewer` for group presentation and `canManage: false`, `canCreateProject: false`; those booleans are derived from the group role, never from project-only visibility.
- Public group discovery: company-scoped open access; private child projects still use explicit grant sources only.

`getGroupAccess(auth, uuid)` and `requireGroupOperation(auth, uuid, operation)` separate discovery from authority. `accessibleProjectWhere` adds indexed inherited group membership without N+1 project checks. Add `accessibleGroupWhere` for search/list queries, including project-only discovery. Group count/activities are filtered by accessibleProjectWhere. Reference, UUID search and all group MCP/page routes must use the same contracts.

Project members responses include direct/inherited/effective roles and source, without pretending the inherited grant is a removable ProjectMember row. Local grant removal succeeds only if its effective impact is accurately reported; a lower local role cannot reduce the group minimum. A grouped project's final local Admin can be removed when a live group Admin remains, while an ungrouped project must retain its local Admin. A private group prevents project visibility changes to public at service level.

### D3: Locked mutations and confirmations

Group member changes and visibility changes acquire the group row lock, re-read actor authority, validate same-company users, protect last Admin and write audit records within the same transaction. Project membership mutations lock their containing group before the project to serialize inherited admin changes; all group/project lifecycle writes use a consistent group UUID order, then project UUID order.

Detailed member/role and movement audit records stay in the protected group comment stream. Only group basic changes and deletion are copied into child-project activity; a project-only visitor must not infer the group roster or an inaccessible source group from activity.

Preview is a side-effect-free authenticated computation for group visibility, individual project visibility and project movement. Return affected project identities, access changes (added/removed principals, changed roles, public company-access changes) and an opaque version-bound confirmation token. Use a cryptographic digest of operation, company, actor principal, source/target, group versions, relevant project visibility and membership rows. Recompute under locks; reject missing/stale/mismatched tokens for a change in access. A group's visibility update and all public→private project changes commit atomically. A grouped project's visibility update must serialize with group visibility changes.

Individual project Private→Public is an access expansion, including in a Public group or when ungrouped. Only effective project Admin may preview/confirm it. Core task ① owns a shared `project-access-preview.service.ts`, `getProjectVisibilityPreview(auth, projectUuid, visibility)`, `setVisibility(..., confirmationToken?)`, the project's PATCH route and GET `/api/projects/:uuid/access-preview?visibility=...`; it rejects missing/stale/mismatched confirmation without mutation. Task ④ must use this preview before publishing. Existing memberships and group inheritance remain unchanged. Public→Private also uses the preview UI and locked transition.

REST contracts:

- POST `/api/project-groups`: existing fields plus visibility; creator Admin.
- GET `/api/project-groups/:uuid`: discovery-filtered data plus visibility/accessLevel/canManage/canCreateProject/accessInitialized.
- PATCH same: existing settings; initializeAccess; visibility with confirmationToken.
- GET `/api/project-groups/:uuid/access-preview?visibility=...`: preview.
- GET/POST `/api/project-groups/:uuid/members`; PATCH/DELETE `/members/:userUuid`: explicit group roles and Admin-gated mutations. Member list requires explicit membership; project-only discovery does not expose the group roster.
- GET `/api/projects/:uuid/group/preview?groupUuid=...` and PATCH `/group`: protected move and matching confirmationToken.
- DELETE group: Admin and per-project management checks; retaining private projects materializes max-role memberships before ungrouping atomically; deleting projects uses existing cascade semantics.

Existing MCP group create/update/delete/move tools gain the necessary visibility/initializeAccess/preview/confirmation parameters or preview mode. They invoke the same services and require existing capability bits. Extend MCP group-get/list/dashboard/search gates; no hand-coded alternate permission resolver.

Public collaboration tools preserve participation by developer agents: comments require the target resource's read capability and project Editor access, and elaboration answers require idea:read and project Editor. They do not require the target's write capability. Hidden resources and Viewer writes remain denied before handler execution or presence.

### D4: Creation, moves and grant preservation

Explicit group Editor/Admin may create in private groups. Omitted visibility defaults to the group's visibility; explicit public in private groups is rejected, including indirect create-then-move paths. Project creator retains the existing local Admin rule and never becomes group Admin.

When any side of a move involves a private project or group, require source group Admin (or ungrouped project Admin) and target group Admin. Pure-public moves retain ordinary editing only when no effective role/access expands. If a Public→Public move gives any principal a higher effective role (including inherited Admin), the confirming actor must additionally have effective Admin on the source project; a baseline Editor cannot self-confirm the expansion. This extra requirement is computed from the actual before/after grant diff and rechecked under locks. Private-boundary dual-Admin rules still apply. A public project moving into a private group becomes private only as a previewed, confirmed atomic transition. Keep its local memberships and inherit the new group immediately. Do not leave a public project in a private group.

Detaching from an initialized group must not strand project administration. For private projects, materialize every max-role effective grant as a local ProjectMember before detaching. Deleting a group while keeping projects does the same. In public groups, private projects use the same retention rule. Snapshotting only rows with direct grants is insufficient.

### D5: Events and recipient checks

After commit, group member changes emit project-access-changed for every affected child, invalidating the caller's request caches and refreshing existing SSE subscribers. Group metadata change events need a group discovery check even though legacy project_group events have empty projectUuid; never broadcast private names/identities indiscriminately. Refresh before fan-out, including concurrent events after revocation. Project-only visitors get only group metadata and accessible project events.

Previously visible groups receive UUID-only invalidation after deletion or access revocation, while subscribers that could never discover the group receive nothing. Access refreshes coalesce bursts of child changes without installing a stale snapshot. Cross-group movement refreshes both source and destination. Historical notification list/count/backfill reads also apply current access, so revoked users cannot recover private project/entity titles from old notifications.

Replace project-only membership enumerations in notifications, mentions, assignment and daemon recipient routing with effective inherited/local membership unions; compute max role for writes. Group metadata search and exact UUID lookup are filtered too. Both live daemon delivery and reconnect backfill resolve standalone task/comment session entity provenance when no Idea ancestor exists, and recheck current project access. Unresolved autonomous origins fail closed; human continuations retain project provenance from existing notifications/session history, while genuinely projectless conversations remain available.

### D6: UI and validation

Group create/manage UI uses existing shadcn dialogs and controls. Add access/member controls and preview/confirmation, with read-only treatment of basic-only visitors. Authorized impact previews display same-company user names/emails with a UUID fallback. Inherited member rows have source labels and no remove/downgrade controls; project local grants can only add effective privileges. Group and private project lock badges wrap without overflow at 320/390px, and every locale receives matching strings. Creation and move dialogs derive permitted choices from server data.

Unit/service/API/MCP coverage accompanies each owning task. Final real-DB integration tests run with PostgreSQL, exercise actual service queries and route/tool behavior, and include competing last-admin changes, membership versus movement/conversion, stale previews, group-only inherited roles, project-only grants, Public→Private rollback and retained configurations. Run TypeScript, lint, appropriate package contracts, and the full relevant test suite. Browser acceptance covers Admin/Editor/Viewer/project-only/outsider in light and dark at mobile and desktop.

## Risks and scope

The main risks are implicit Public editor access being inherited into private projects, private group metadata leaked by projectless events/search, and stale authorization during concurrent mutations. Explicit grant-only inheritance, shared queries and locked confirmations address these. Upgrade preserves raw existing project configuration; legacy group access initialization is explicit. This feature does not add a company-admin role, invite workflow, per-agent memberships, or arbitrary project deny overrides.

## Approved implementation exception

Human comment `53430cba-74d9-4691-a8f1-9710e874d92e` on the originating Idea, at 2026-10-01T17:42:12.789Z, instructs “先不用管pencil，继续yolo”. Accordingly `docs/design.pen` synchronization is deferred for this run. The implemented screens, responsive behavior and permission controls still require independent functional and browser verification; the completion report records the deferred design artifact.
