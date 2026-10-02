## ADDED Requirements

### Requirement: Explicit group memberships
Groups SHALL have Public/Private visibility and same-company user roles Viewer/Editor/Admin. Agents SHALL inherit their owner's effective role and remain constrained by capability bits. New groups SHALL have their creator as Admin and initialized groups MUST retain an Admin. Existing projects, local memberships and group assignments MUST NOT be rewritten during upgrade; legacy groups without creator records SHALL automatically receive their company's first user as Admin (earliest createdAt, then lowest id), matching the legacy project rule. Existing grants SHALL be preserved, and companies without users SHALL be skipped. Manual claiming or initialization MUST NOT be required or offered.

#### Scenario: Automatic legacy Admin
- **WHEN** a company has historical groups without creator records and multiple registered users
- **THEN** the earliest user becomes Admin of every such group without interacting with the UI; existing group and project grants are retained

#### Scenario: No claim by the current visitor
- **WHEN** another company user edits or views an existing group
- **THEN** that action does not assign them group Admin and no manual initialization control is offered

#### Scenario: Final group Admin
- **WHEN** concurrent operations attempt to remove the remaining group Admins
- **THEN** at least one Admin remains and rejected operations commit no membership or audit mutation

### Requirement: Live inherited role floor
Private projects SHALL resolve effective role as the greater of explicit group membership and local project membership. Public groups' implicit company-wide editor baseline MUST NOT grant access to private child projects. Group Admin SHALL always be Admin in every child project, independent of group visibility; project mutations MUST NOT reduce this inherited layer.

#### Scenario: Project grant raises a group role
- **WHEN** a group Viewer has a local project Editor grant
- **THEN** they can edit that project while remaining Viewer elsewhere

#### Scenario: Local lower role cannot downgrade inheritance
- **WHEN** a group Editor has a local project Viewer row
- **THEN** their effective project role is Editor

#### Scenario: Revocation preserves another grant
- **WHEN** a member's group grant is removed while a local project Viewer grant remains
- **THEN** inherited access is removed immediately and that project's independent Viewer access remains

#### Scenario: Public group does not expose private children
- **WHEN** a company user has no explicit group or private-project membership
- **THEN** the public group is visible but its private projects are not

### Requirement: Project-only group discovery
A user with access to a child project but no explicit private-group membership SHALL discover group basic information and grouping. Group project lists, counts, dashboards, search and activity SHALL expose only accessible children. Such discovery MUST NOT permit group creation of projects, roster reading or group administration.

#### Scenario: Project-only visitor
- **WHEN** a project-only Viewer opens a private group with two projects but access to only one
- **THEN** basic group metadata is shown, counts include only the one project and settings/roster/other project content are unavailable

#### Scenario: Hidden group
- **WHEN** an actor has neither group membership nor any child-project access
- **THEN** a private group's direct URLs and MCP reads return not-found and lists/search omit it

### Requirement: Private groups contain only private projects
Private groups MUST NOT contain Public projects through creation, individual visibility changes, movement, or group conversion. Public→Private group conversion SHALL atomically make all Public children Private, default to live configured group membership, preserve existing local grants and require a fresh impact confirmation. Private→Public conversion SHALL retain all child project visibility and both grant layers.

#### Scenario: Convert group to private
- **WHEN** an Admin confirms a current preview for a group containing public and private projects
- **THEN** the group and every public project become Private atomically, without replacing existing private-project local membership

#### Scenario: Convert group to public
- **WHEN** a group Admin changes a Private group to Public
- **THEN** private projects remain private and group Admin and other configured group memberships still inherit

#### Scenario: Stale confirmation
- **WHEN** membership or relevant project configuration changes after a preview
- **THEN** executing with that token fails without mutation and requires a new preview

### Requirement: Authorized movements and retention
Movements involving private access SHALL require source group Admin or ungrouped project Admin and target group Admin. Access changes MUST be previewed and confirmed. Detaching private projects or deleting their group while keeping them SHALL materialize all effective roles as local memberships, retaining privacy and an Admin atomically.

#### Scenario: Project-only Admin cannot move from private group
- **WHEN** a local project Admin who is not source group Admin attempts a boundary move
- **THEN** the move is forbidden even though project content administration is allowed

#### Scenario: Public move expands roles
- **WHEN** a baseline Editor tries to move a Public project between Public groups and a target group member would thereby gain project Admin
- **THEN** the move is forbidden even with that Editor's fresh preview token; effective source-project Admin confirmation is required

#### Scenario: Ungrouping preserves inheritance
- **WHEN** an authorized Admin detaches a private project whose only Admin is inherited
- **THEN** the inherited Admin and other effective grants become local memberships and the project remains Private

### Requirement: Isolation across delivery surfaces
REST, MCP, pages, actions, text/exact-UUID search, lists, aggregates, SSE, notifications, mentions, task/idea assignment and daemon delivery SHALL use the same effective role resolver. Private group metadata events without a project UUID MUST still be discovery-filtered. Group mutations SHALL refresh access for all affected projects after commit.

#### Scenario: Live group revocation
- **WHEN** a user's final effective grant is removed while SSE is connected
- **THEN** subsequent group/project events and notifications are withheld and direct reads return not-found

### Requirement: Group access presentation
Group creation/settings SHALL provide visibility and member controls gated by explicit authority, private badges and previews. Project access UI SHALL distinguish inherited and additional roles and MUST NOT present inherited grants as removable. Visibility impact confirmation SHALL display distinct affected-user counts by gained/lost access and increased/decreased permissions, plus affected-project counts, instead of individual identities or per-child change lists. Counts SHALL include group discovery changes for empty groups, deduplicate each person per effect across children, and retain fresh server confirmation. Controls SHALL be localized and usable at mobile widths in light and dark themes.

#### Scenario: Inherited member row
- **WHEN** project Admin reviews a group-inherited Admin
- **THEN** the source is labeled and no project control can downgrade or remove the inherited role

#### Scenario: Compact visibility impact
- **WHEN** the same user loses access to several children during group privatization
- **THEN** the preview counts that user once for lost access, summarizes the affected projects, and does not render their name, email or UUID

#### Scenario: Empty group privacy impact
- **WHEN** an Admin previews privatizing a public group with no child projects
- **THEN** company users without explicit group membership are included in the lost-access count
