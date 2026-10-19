# self-service-display-name Specification

## Purpose
Allow ordinary users to choose their displayed name independently of login identifiers, with consistent Unicode code-point validation, persistent OIDC customization and accessible settings-page feedback.

## Requirements

### Requirement: Authenticated users can update their own display name
The system SHALL allow active ordinary users, including local and OIDC users, to update only their own display name through an authenticated same-origin self-service endpoint. The system MUST derive tenant and actor from authentication and reject agent/superadmin callers, invalid origins and extra payload fields.

#### Scenario: Valid self-save
- **WHEN** an active user submits a valid name
- **THEN** only that user's name and customization marker are updated and the response contains its UUID and persisted name
- **AND** login identifiers and privileges remain unchanged

#### Scenario: Unauthorized or cross-user request
- **WHEN** an unauthenticated or non-user principal calls the endpoint, or a payload supplies another actor/tenant
- **THEN** the request is rejected without changing any name

### Requirement: Consistent trimmed Unicode code-point validation
The browser and server SHALL validate self-service display names as 1–32 Unicode code points after trimming leading/trailing whitespace, preserve internal spaces, reject invalid payloads and avoid silent truncation. Names MUST NOT be required to be unique.

#### Scenario: Unicode boundary
- **WHEN** a user submits 32 single-code-point emoji
- **THEN** the name is accepted despite occupying 64 UTF-16 code units
- **AND** 33 such emoji are rejected

#### Scenario: Empty and composite inputs
- **WHEN** a name is whitespace-only or exceeds 32 code points including combining marks or multi-code-point emoji
- **THEN** the save is rejected with validation feedback and the existing name is unchanged

### Requirement: Custom names survive OIDC synchronization
The system SHALL persist explicit customization and MUST NOT overwrite it during later or concurrent OIDC synchronization, including account linking by email. Users who have never customized SHALL retain existing identity-provider synchronization behavior.

#### Scenario: OIDC sync overlaps a self-save
- **WHEN** OIDC has read the old user and the user saves a custom name before OIDC writes
- **THEN** OIDC name synchronization skips the customized row and returns its current persisted name

#### Scenario: Existing data compatibility
- **WHEN** the migration runs or an uncustomized user signs in
- **THEN** existing names are not truncated or blanked and uncustomized OIDC names continue to synchronize

### Requirement: Settings editing reflects successful saves
The system SHALL provide a localized accessible name editor beside avatar settings with a code-point count, validation and save feedback. A successful save SHALL immediately update current authenticated UI; failure SHALL retain the draft and persisted UI identity. Old in-flight session probes MUST NOT undo a just-saved name.

#### Scenario: Success and stale refresh
- **WHEN** a valid save succeeds while a pre-save session probe is in flight
- **THEN** current UI displays the saved name and the delayed probe cannot replace it with the old name

#### Scenario: Invalid or failed save
- **WHEN** the input is invalid or the server/network fails
- **THEN** the user receives localized feedback, keeps the draft, and can retry without changing the current persisted identity

#### Scenario: Legacy long name
- **WHEN** an existing name exceeds 32 code points
- **THEN** it remains visible without automatic truncation and a self-service save requires a valid replacement
