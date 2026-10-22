## ADDED Requirements

### Requirement: Persistent independent user avatar seed
The system SHALL persist a mutable UUID avatarSeed separately from each human user's identity UUID, initialize it for existing and new users, and preserve it across login and profile-name changes.

#### Scenario: Existing and new accounts
- **WHEN** the migration upgrades existing users or a supported login path creates a user
- **THEN** each user has a persisted UUID avatarSeed
- **AND** the user's identity UUID and authentication data remain unchanged

#### Scenario: Login after customization
- **WHEN** a user saves a new seed and later signs in through their supported authentication flow or changes their name
- **THEN** the saved seed remains unchanged

#### Scenario: Old writers during rollout and rollback
- **WHEN** an old application or generated Prisma Client creates a user without an avatarSeed on the migrated database, including after an application rollback
- **THEN** the database default generates a valid UUID seed and creation succeeds
- **AND** this behavior is verified on supported PostgreSQL and PGlite databases

### Requirement: Local Personas rendering
The system SHALL render human avatars with the installed DiceBear Personas style locally using the persisted seed and fixed static options, without external avatar requests, while leaving Agent rendering unchanged.

#### Scenario: Stable rendering
- **WHEN** the same seed is rendered on multiple surfaces using the same style version and options
- **THEN** the generated image is identical regardless of the user's display name
- **AND** no request is made to an external avatar service

#### Scenario: Missing identity or render failure
- **WHEN** a user cannot be resolved or local avatar generation fails
- **THEN** a safe initials or user-icon fallback appears without crashing
- **AND** no user record is created by rendering

### Requirement: Self-only validated avatar persistence
The system SHALL accept a validated UUID seed for the authenticated human's own tenant-scoped account only, reject unrelated input fields and unauthorized callers, and never mutate account identity or credentials.

#### Scenario: Save exactly the preview
- **WHEN** a valid human submits a valid preview seed
- **THEN** that exact seed is persisted and returned in the success envelope
- **AND** retrying the same seed has the same resulting state

#### Scenario: Invalid or unauthorized write
- **WHEN** a caller is unauthenticated, is an Agent, submits invalid seed or target-user fields, or makes a disallowed cross-origin cookie request
- **THEN** the request fails with an appropriate client error and no user is modified

#### Scenario: Invalid Bearer cannot bypass cookie origin checks
- **WHEN** an invalid Bearer header falls back to a valid cookie and Origin is missing or untrusted
- **THEN** the avatar write is rejected without changing the saved seed
- **AND** merely having an Authorization header does not grant an Origin-check exemption

### Requirement: Settings preview save and cancel
The settings page SHALL allow users to generate random UUID previews repeatedly, explicitly save a preview, and cancel without persisting a preview.

#### Scenario: Preview and discard
- **WHEN** the user generates previews and cancels or leaves without saving
- **THEN** the persisted seed and official avatar elsewhere remain unchanged
- **AND** cancel restores the saved preview

#### Scenario: Save succeeds
- **WHEN** saving completes successfully
- **THEN** the preview becomes the persisted avatar and all mounted current-user avatar surfaces use the new seed
- **AND** page refresh and later login retain the avatar

#### Scenario: Saving fails or is pending
- **WHEN** saving is pending
- **THEN** duplicate or conflicting editor actions are disabled
- **WHEN** saving fails
- **THEN** the old official avatar remains, the draft can be retried, and an accessible error is shown

### Requirement: Complete existing user-avatar coverage
The system SHALL use the shared human-avatar component at every existing human-avatar surface and propagate the current persisted seed through authorized identity responses, without adding avatars to text-only surfaces or replacing semantic icons.

#### Scenario: Identity surfaces
- **WHEN** an existing human-avatar slot appears in navigation, comments, mentions, assignees, member lists, proposal creators, activity or presence
- **THEN** it displays the same user's current persisted Personas avatar once its identity data is loaded
- **AND** fetching seed data does not expand resource visibility or issue a query per rendered avatar

#### Scenario: Historical content and another session
- **WHEN** a historical comment or other identity-bearing resource is fetched after an avatar change
- **THEN** it resolves the author's current saved seed instead of a historical seed snapshot
- **AND** another browser session sees the change on its next normal data fetch or refresh

#### Scenario: Coverage audit
- **WHEN** integration is reviewed
- **THEN** every searched avatar/icon identity hit is classified as migrated human avatar, unchanged Agent avatar, or intentionally retained semantic icon/text
- **AND** no existing resolvable human-avatar slot is left as initials or a generic icon

### Requirement: Accessible presentation and attribution
The system SHALL render avatars and controls accessibly in light/dark themes and small sizes, provide Chinese/English UI text, and visibly credit Personas with source, author and CC BY 4.0 license links in the settings avatar section.

#### Scenario: Accessible editor
- **WHEN** a keyboard or assistive-technology user changes an avatar
- **THEN** controls have accessible names, focus remains usable and save/error feedback is announced
- **AND** adjacent named avatars avoid redundant screen-reader labeling

#### Scenario: License credit
- **WHEN** the settings avatar section is displayed
- **THEN** Personas/Draftbit attribution, source and CC BY 4.0 links are visible
- **AND** the repository retains a third-party notice describing the style's use
