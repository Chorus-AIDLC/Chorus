## MODIFIED Requirements


### Requirement: Project visibility
Every Project SHALL have a `visibility` of `public` or `private`. New ungrouped projects SHALL default to `public` unless the creator selects `private`. Grouped projects SHALL default to group visibility; Private groups MUST reject explicit Public children. Existing projects SHALL be migrated as `public`. A public project SHALL grant every user in its Company (and every agent of that Company) at least the `editor` level, preserving pre-change content read/write behaviour. On a public project every company actor SHALL also keep the ability to edit project settings, move it between groups and delete it, as before. Switching a project's visibility and managing its members SHALL require an effective `admin` role from explicit group or project membership on public and private projects alike.

#### Scenario: Existing projects remain public
- **WHEN** the original project-access migration (not this group upgrade) runs on a database with existing projects
- **THEN** every existing project has `visibility = "public"` and every company user can still read and modify its ideas, proposals, tasks and documents

#### Scenario: Legacy project creator backfill
- **WHEN** the original project-access migration (not this group upgrade) runs for an existing project in a company whose earliest-created user is F
- **THEN** the project's `createdByUuid = F` and F is an `admin` member of it

#### Scenario: Non-admin can still manage a public project's settings
- **WHEN** a company user who is not an `admin` member edits the name of a public project
- **THEN** the change succeeds as before

#### Scenario: Non-admin cannot make a public project private
- **WHEN** a company user who is not an `admin` member switches a public project to private, or adds a member to it
- **THEN** the request is rejected with 403 and the project and its members are unchanged

#### Scenario: Create a private project
- **WHEN** a user creates a project with `visibility = "private"`
- **THEN** the project is stored as private and the creator is recorded as `createdByUuid` and as an `admin` member

### Requirement: Project membership levels
A private project SHALL control access through the maximum of its explicit same-company `ProjectMember` and `ProjectGroupMember` roles (`viewer`, `editor`, `admin`). Group inheritance is live and is a role floor; project grants may add or raise access, never reduce inherited access. Public group implicit company access MUST NOT be inherited into a private project. `viewer` MUST permit read-only access to the project and all its entities. `editor` MUST additionally permit creating, updating, deleting, claiming, commenting on, referencing, elaborating, proposing, approving and verifying entities within the project. `admin` MUST additionally permit editing project settings, changing visibility, managing members, moving the project between groups and deleting the project; on a private project these operations MUST be rejected for `viewer` and `editor`.

#### Scenario: Viewer cannot write
- **WHEN** a viewer of a private project attempts to create a task in it
- **THEN** the request is rejected with 403 and no task is created

#### Scenario: Editor can approve and verify
- **WHEN** an editor of a private project approves a pending proposal or verifies a task in it
- **THEN** the action succeeds

#### Scenario: Editor cannot manage members
- **WHEN** an editor of a private project attempts to add a member
- **THEN** the request is rejected with 403

#### Scenario: Member must belong to the same company
- **WHEN** an admin attempts to add a user from a different company as a member
- **THEN** the request is rejected and no membership is created

### Requirement: Last admin guard
A private project MUST always retain at least one effective `admin`, including a live group Admin. Removing or demoting the final effective Admin SHALL be rejected. Grouped projects may remove their last local Admin when an inherited group Admin remains; detaching SHALL materialize effective grants before removing the group reference.

#### Scenario: Remove last admin
- **WHEN** the only admin of a private project tries to remove themselves or change their role to editor
- **THEN** the request is rejected with 400 and the membership is unchanged

### Requirement: Visibility switching
Only an actor with `admin` level on the project SHALL change its visibility. Switching `public` → `private` MUST, in the same transaction, retain an effective Admin; all users without effective inherited or local membership SHALL lose access. Switching a project to Public inside a Private group MUST be rejected. Switching `private` → `public` SHALL retain existing membership rows. An agent without an owner MUST NOT switch a project to private. Every visibility or membership change SHALL be recorded in the Activity stream. Individual project Private→Public publication MUST require an effective Admin to confirm a fresh access-impact preview; missing, stale or mismatched confirmations MUST fail without mutation, through REST and any MCP exposure alike.

#### Scenario: Switch to private
- **WHEN** user U, the only admin member of a public project, switches it to private
- **THEN** U remains its only member (admin) and other company users receive 404 on the project

#### Scenario: Switch back to public keeps members
- **WHEN** an effective admin confirms a current publication preview and switches a private project with members A (admin) and B (viewer) back to public
- **THEN** every company user has full access and the A/B rows are preserved for a later switch to private

#### Scenario: Unconfirmed individual publication
- **WHEN** a project Admin tries to publish a private project without a matching current access-impact confirmation
- **THEN** the request is rejected and visibility and both membership layers are unchanged

### Requirement: Agent access inherits from owner
An agent SHALL NOT be a project member itself. On a private project an agent's level SHALL equal its owner's effective maximum inherited/local membership level, or `none` if it has no owner or the owner has no effective grant. The agent's company-wide permission bits SHALL continue to apply, so an operation succeeds only if both the bit and the project level allow it.

#### Scenario: Agent of a viewer
- **WHEN** an agent with `task:write` whose owner is a viewer of a private project calls a tool that updates a task in that project
- **THEN** the call is rejected as forbidden

#### Scenario: Agent of a non-member
- **WHEN** an agent whose owner is not a member calls `chorus_get_task` for a task in a private project
- **THEN** the call returns the same not-found error as for a nonexistent task

### Requirement: Access management UI
The Project Settings modal SHALL provide an Access section where admins change visibility (with current access-impact previews and confirmation for both directions) and list, add, change the role of, and remove members; non-admins SHALL see it read-only. The member table SHALL show inherited and local grant provenance and effective roles; inherited grants MUST NOT be presented as removable or downgradable project memberships. The Create Project dialog SHALL offer the visibility choice. Private projects SHALL show a lock indicator wherever projects are listed. Viewers SHALL NOT be offered primary create/edit actions on project pages. All strings SHALL be localized (en, zh) and render correctly in light and dark themes.

#### Scenario: Admin adds a member
- **WHEN** an admin opens Project Settings → Access, picks a company user and the Editor role, and confirms
- **THEN** the user appears in the member table as Editor and can now open the project

#### Scenario: Viewer sees read-only project
- **WHEN** a viewer opens the private project's tasks page
- **THEN** the tasks are listed and the create-task action is not offered
