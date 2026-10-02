## Context

`Project.groupUuid` exists but is not a Prisma relation. `ProjectMember` is the local grant layer. All entity APIs already delegate to `project-access.service.ts`; lists use `accessibleProjectWhere`, and recipients have additional member queries that must be extended. Group services currently company-scope group metadata and filter only their child project data.

## Decisions

### D1: Data model and upgrade

Add `ProjectGroup.visibility` default public, nullable `createdByUuid`, an `accessVersion` counter for confirmation freshness, and `ProjectGroupMember` (`companyUuid`, `groupUuid`, `userUuid`, role, timestamps, actor provenance; unique group/user). Add an indexed Project→ProjectGroup relation with Prisma-level deletion restricted, so deleting a group must explicitly handle its projects. Follow the repository's `relationMode = "prisma"` without adding database foreign keys. Historical orphan `Project.groupUuid` assignments must not prevent upgrade. Do not rewrite any Project or ProjectMember during migration.

An authorized project Admin can repair a historical missing/foreign-company group reference by confirming a move or detach. Preserve local grants and private visibility; only actual groups in the actor's company receive version updates and protected group audits. Destination authorization and locked confirmation remain unchanged.

New group creation records the user's identity (agent→owner) and an explicit group Admin atomically. Ownerless agents cannot create private groups. Human correction `482b8da8-27ed-47a3-b316-ba0690b38ab6` and its clarification `6a03cca7-ea88-4e8f-87ec-72ecd8421993` (2026-10-02) require lazy authorization rather than a data migration. Whenever a same-company group has no explicit Admin, `implicitGroupAdmin` computes its company's first user (createdAt ascending, then id ascending) as automatic Admin. This includes historical groups and ownerless Agent-created public groups, irrespective of createdByUuid. Reading does not alter groups, creators, accessVersion or membership rows. Existing Viewer/Editor grants remain stored unchanged even when the first user's effective role is Admin. Companies without users have no fallback. An explicit Admin suppresses the fallback; if the earliest user disappears, a fresh request selects the next user. First-user lookup is request-scoped, never cached across transaction lock rechecks. The undeployed backfill migration is removed; the applied group migration remains byte-identical. Manual claiming/initialization is unavailable; REST rejects retired initialization requests without mutation. Members distinguish automatic and explicit Admin. Explicit final Admin removal remains protected, and project final-Admin checks include the automatic inherited Admin. An authorized detach snapshots this effective grant locally as part of that explicit mutation.

Human follow-up `1cf0a767-5178-434c-907a-a26ed3ebba1f` also requests project lazy authorization. The already-applied `20261001053611_add_private_project_access` creates the project schema as well as historical data; preserve its exact bytes and existing explicit rows. Add no replacement data migration. `implicitProjectAdmin` applies the same company-first-user computation to projects without a local Admin or a live same-company group. A live group already supplies explicit or automatic Admin and suppresses separate project fallback. Missing/foreign group references are handled as ungrouped while staying tenant-scoped. Batched list filtering identifies unadministered projects and excludes live groups; direct queries, recipients, roster presentation and all previews use the identical rule. Confirmation includes computed project Admin identity. A newly added explicit project Admin revokes automatic project authority and refreshes affected subscribers. The last explicit local Admin remains protected on ungrouped projects; the fallback must not bypass that existing mutation guard.

### D2: Shared access contracts

Reuse `membershipPrincipal`, role ranks and typed 404/403 errors. Export transaction-capable project role resolution so project-member mutations re-check both grant sources inside their locks.

- Private project: max(explicit or automatic group role, local project role).
- Public project: max(editor baseline, explicit or automatic group role, local project role).
- Group management: use the actor's explicit or automatic group role; public groups preserve ordinary company editing, but changing group visibility/members always requires effective group Admin.
- Private group discovery: explicit or automatic group membership OR at least one readable child project. A project-only visitor receives `accessLevel: viewer` for group presentation and `canManage: false`, `canCreateProject: false`; those booleans are derived from the group role, never from project-only visibility.
- Public group discovery: company-scoped open access; private child projects use actual grants or the automatic Admin, never the public editor floor.

`getGroupAccess(auth, uuid)` and `requireGroupOperation(auth, uuid, operation)` separate discovery from authority. `accessibleProjectWhere` adds indexed inherited group membership without N+1 project checks. Add `accessibleGroupWhere` for search/list queries, including project-only discovery. Group count/activities are filtered by accessibleProjectWhere. Reference, UUID search and all group MCP/page routes must use the same contracts.

Project members responses include direct/inherited/effective roles and source, without pretending the inherited grant is a removable ProjectMember row. Local grant removal succeeds only if its effective impact is accurately reported; a lower local role cannot reduce the group minimum. A grouped project's final local Admin can be removed when a live group Admin remains, while an ungrouped project must retain its local Admin. A private group prevents project visibility changes to public at service level.

### D3: Locked mutations and confirmations

Group member changes and visibility changes acquire the group row lock, re-read actor authority, validate same-company users, protect last Admin and write audit records within the same transaction. Project membership mutations lock their containing group before the project to serialize inherited admin changes; all group/project lifecycle writes use a consistent group UUID order, then project UUID order.

Detailed member/role and movement audit records stay in the protected group comment stream. Only group basic changes and deletion are copied into child-project activity; a project-only visitor must not infer the group roster or an inaccessible source group from activity.

Preview is a side-effect-free authenticated computation for group visibility, individual project visibility and project movement. Return affected project identities, access changes (added/removed principals, changed roles, public company-access changes) and an opaque version-bound confirmation token. Use a cryptographic digest of operation, company, actor principal, source/target, group versions, relevant project visibility and membership rows, including the computed automatic Admin UUID for each involved group. Recompute under locks; reject missing/stale/mismatched tokens for a change in access. A group's visibility update and all public→private project changes commit atomically. A grouped project's visibility update must serialize with group visibility changes.

Individual project Private→Public is an access expansion, including in a Public group or when ungrouped. Only effective project Admin may preview/confirm it. Core task ① owns a shared `project-access-preview.service.ts`, `getProjectVisibilityPreview(auth, projectUuid, visibility)`, `setVisibility(..., confirmationToken?)`, the project's PATCH route and GET `/api/projects/:uuid/access-preview?visibility=...`; it rejects missing/stale/mismatched confirmation without mutation. Task ④ must use this preview before publishing. Existing memberships and group inheritance remain unchanged. Public→Private also uses the preview UI and locked transition.

REST contracts:

- POST `/api/project-groups`: existing fields plus visibility; creator Admin.
- GET `/api/project-groups/:uuid`: discovery-filtered data plus visibility/accessLevel/canManage/canCreateProject/accessInitialized.
- PATCH same: existing settings; visibility with confirmationToken; retired initializeAccess requests return validation errors without writes.
- GET `/api/project-groups/:uuid/access-preview?visibility=...`: preview.
- GET/POST `/api/project-groups/:uuid/members`; PATCH/DELETE `/members/:userUuid`: explicit group roles and Admin-gated mutations. Member list requires explicit or automatic membership; project-only discovery does not expose the group roster.
- GET `/api/projects/:uuid/group/preview?groupUuid=...` and PATCH `/group`: protected move and matching confirmationToken.
- DELETE group: Admin and per-project management checks; retaining private projects materializes max-role memberships before ungrouping atomically; deleting projects uses existing cascade semantics.

Existing MCP group create/update/delete/move tools gain the necessary visibility/preview/confirmation parameters or preview mode. They invoke the same services and require existing capability bits. Extend MCP group-get/list/dashboard/search gates; no hand-coded alternate permission resolver.

Public collaboration tools preserve participation by developer agents: comments require the target resource's read capability and project Editor access, and elaboration answers require idea:read and project Editor. They do not require the target's write capability. Hidden resources and Viewer writes remain denied before handler execution or presence.

### D4: Creation, moves and grant preservation

Explicit group Editor/Admin may create in private groups. Omitted visibility defaults to the group's visibility; explicit public in private groups is rejected, including indirect create-then-move paths. Project creator retains the existing local Admin rule and never becomes group Admin.

When any side of a move involves a private project or group, require source group Admin (or ungrouped project Admin) and target group Admin. Pure-public moves retain ordinary editing only when no effective role/access expands. If a Public→Public move gives any principal a higher effective role (including inherited Admin), the confirming actor must additionally have effective Admin on the source project; a baseline Editor cannot self-confirm the expansion. This extra requirement is computed from the actual before/after grant diff and rechecked under locks. Private-boundary dual-Admin rules still apply. A public project moving into a private group becomes private only as a previewed, confirmed atomic transition. Keep its local memberships and inherit the new group immediately. Do not leave a public project in a private group.

Detaching from an initialized group must not strand project administration. For private projects, materialize every max-role effective grant as a local ProjectMember before detaching. Deleting a group while keeping projects does the same. In public groups, private projects use the same retention rule. Snapshotting only rows with direct grants is insufficient.

### D5: Events and recipient checks

After commit, group member changes emit project-access-changed for every affected child, invalidating the caller's request caches and refreshing existing SSE subscribers. Group metadata change events need a group discovery check even though legacy project_group events have empty projectUuid; never broadcast private names/identities indiscriminately. Refresh before fan-out, including concurrent events after revocation. Project-only visitors get only group metadata and accessible project events.

Previously visible groups receive UUID-only invalidation after deletion or access revocation, while subscribers that could never discover the group receive nothing. Access refreshes coalesce bursts of child changes without installing a stale snapshot. Cross-group movement refreshes both source and destination. Adding the first explicit Admin invalidates automatic Admin access for every child. SSE refreshes invalidate request-scoped first-user caches; the 30-second heartbeat detects a changed first user (including external deletion) and refreshes only the current connection’s project gate and UUID-only invalidations for previously or newly visible groups. Heartbeats never broadcast company-wide/Redis events; lookup or refresh failures clear the project gate and retry on the next heartbeat, including when the first-user UUID is unchanged. Historical notification list/count/backfill reads also apply current access, so revoked users cannot recover private project/entity titles from old notifications.

Replace project-only membership enumerations in notifications, mentions, assignment and daemon recipient routing with effective inherited/local membership unions; compute max role for writes. Group metadata search and exact UUID lookup are filtered too. Both live daemon delivery and reconnect backfill resolve standalone task/comment session entity provenance when no Idea ancestor exists, and recheck current project access. Unresolved autonomous origins fail closed; human continuations retain project provenance from existing notifications/session history, while genuinely projectless conversations remain available.

### D6: UI and validation

Group create/manage UI uses existing shadcn dialogs and controls. Add access/member controls and preview/confirmation, with read-only treatment of basic-only visitors. Per the same human correction, impact previews display concise counts: distinct affected people, gained/lost access, increased/decreased permissions and affected projects. Each person is deduplicated per effect across group and child resources; categories can overlap and their counts are not additive. Project summaries count management-permission changes even when Editor remains Editor: public manage_project allows Editor while private requires Admin. This applies to standalone visibility, child closure and movement. Group summaries include basic group discovery/editing changes, including empty groups and retained project-only discovery. No individual name, email, UUID, or per-child list is rendered. Existing authorized API diffs remain for compatibility; the new summary is presentation-only and does not weaken locked permission or confirmation checks. Inherited member rows have source labels and no remove/downgrade controls; project local grants can only add effective privileges. Group and private project lock badges wrap without overflow at 320/390px, and every locale receives matching strings. Creation and move dialogs derive permitted choices from server data.

Unit/service/API/MCP coverage accompanies each owning task. Final real-DB integration tests run with PostgreSQL, exercise actual service queries and route/tool behavior, and include competing last-admin changes, membership versus movement/conversion, stale previews, group-only inherited roles, project-only grants, Public→Private rollback and retained configurations. Run TypeScript, lint, appropriate package contracts, and the full relevant test suite. Browser acceptance covers Admin/Editor/Viewer/project-only/outsider in light and dark at mobile and desktop.

## Risks and scope

The main risks are implicit Public editor access being inherited into private projects, private group metadata leaked by projectless events/search, and stale authorization during concurrent mutations. Grant-based inheritance with the no-Admin fallback, shared queries and locked confirmations address these. Upgrade preserves raw existing project configuration; legacy group Admin assignment is automatic using the authorized first-user rule. This feature does not add a company-admin role, invite workflow, per-agent memberships, or arbitrary project deny overrides.

## Approved implementation exception

Human comment `53430cba-74d9-4691-a8f1-9710e874d92e` on the originating Idea, at 2026-10-01T17:42:12.789Z, instructs “先不用管pencil，继续yolo”. Accordingly `docs/design.pen` synchronization is deferred for this run. The implemented screens, responsive behavior and permission controls still require independent functional and browser verification; the completion report records the deferred design artifact.
