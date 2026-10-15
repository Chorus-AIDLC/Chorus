# workspace-local-users Specification

## Purpose
Provide workspace-isolated local username/password accounts, Superadmin bootstrap and human Workspace Admin user lifecycle management. Unify local and existing SSO login discovery while preserving tenant boundaries, project access and live session/owned-Agent revocation.

## Requirements

### Requirement: Explicit local workspace bootstrap
The system SHALL allow Superadmin to create an explicitly local-auth workspace atomically with its first invited Workspace Admin and an expiring credential link; legacy company creation SHALL remain compatible and SHALL NOT silently enable local credentials.

#### Scenario: Bootstrap succeeds
- **WHEN** Superadmin provides a valid name and initial administrator identity
- **THEN** one local workspace, one invited administrator and one hashed invitation token exist and a usable link is returned

#### Scenario: Bootstrap cannot partially succeed
- **WHEN** any bootstrap persistence operation fails
- **THEN** the transaction rolls back without an orphan local workspace

### Requirement: Tenant-local identities
Local usernames and emails SHALL be normalized and individually unique within their workspace. Across different workspaces they MAY repeat. Credentials SHALL always be scoped by company UUID. Legacy OIDC records SHALL NOT be made subject to new local email uniqueness or password elevation.

#### Scenario: Duplicate across tenants
- **WHEN** two different workspaces invite the same username and email
- **THEN** each owns an independent account and credential lifecycle

#### Scenario: Duplicate in one tenant
- **WHEN** an administrator creates or edits a local account to collide with another normalized local identity in that workspace
- **THEN** the operation rejects without altering either account

### Requirement: Human Workspace Admin authorization
Only an active human Workspace Admin in an explicitly local-auth workspace SHALL administer its users. The system SHALL revalidate current role/state and tenant for mutations and SHALL NOT give this privilege to Agent API keys or all Superadmin daily management flows. Ordinary users SHALL retain their existing business/project access.

#### Scenario: Direct API access is forbidden
- **WHEN** an ordinary user, Agent or another tenant's admin attempts to manage local users
- **THEN** access is denied without exposing or modifying the target tenant

### Requirement: Complete local user lifecycle
Admins SHALL list, invite, edit, enable/disable, reset credentials, grant/revoke Workspace Admin and remove local users. Removal SHALL retain UUID/history ownership as a tombstone while removing authentication eligibility and atomically releasing the normalized username and login email. Reusing those identifiers SHALL create a fresh UUID through the normal invitation flow and SHALL NOT transfer history, administrator privileges, project/group memberships, Agent ownership or keys. Active, invited and disabled accounts SHALL continue reserving their identifiers. Invited users SHALL NOT activate without establishing a password through their valid invitation.

#### Scenario: User removal retains history
- **WHEN** an authorized admin removes a user
- **THEN** the user can no longer authenticate and historical activities and assignments keep their original user UUID

#### Scenario: Deleted identity reused without inheritance
- **WHEN** an admin removes a local account and invites the same normalized username or email in the same workspace
- **THEN** a new account UUID and invitation are created without inheriting the old account's rights or history, and the old UUID's sessions, credential links and owned-Agent keys remain invalid even after the new account activates

#### Scenario: Disabled user re-enabled
- **WHEN** an admin enables a previously established local account
- **THEN** that account may log in again but its old revoked session generation does not become valid

### Requirement: Last administrator protection
The system SHALL prevent disabling, removing or demoting the last effective Workspace Admin, including concurrent mutations. Initial bootstrap's sole invited admin SHALL not be discarded before an effective replacement exists.

#### Scenario: Concurrent admin removal
- **WHEN** two admins are concurrently removed or demoted such that both operations would leave no effective admin
- **THEN** at least one operation is rejected and an effective administrator remains

### Requirement: Secure invitation and reset links
The system SHALL store only hashes of cryptographically random tokens bound to account/workspace, purpose, generation and expiry. Tokens SHALL be consumed atomically once and previous links SHALL become unusable after reissue or incompatible account changes. Admin issuance SHALL expose a usable copy/share link and expiry without logging secrets.

#### Scenario: Invitation accepted once
- **WHEN** an invited user submits a valid token and acceptable password
- **THEN** the password is securely hashed, the account activates and token replay fails

#### Scenario: Stale link cannot resurrect user
- **WHEN** a disabled/removed user or an outdated-generation/expired token is submitted
- **THEN** acceptance fails without reactivating that user or changing their password

#### Scenario: Link handoff
- **WHEN** an administrator issues an invite or reset
- **THEN** the UI presents its usable link and expiry for explicit delivery through a trusted channel without depending on unconfigured email transport

### Requirement: Safe password credentials
The system SHALL hash passwords with the existing cross-platform bcryptjs dependency, enforce a minimum password length and reject inputs beyond bcrypt's safe UTF-8 byte limit. Login SHALL use generic credential errors and bounded throttling.

#### Scenario: Invalid password length
- **WHEN** token acceptance submits an undersized password or one exceeding the safe byte length
- **THEN** it fails without consuming the credential token

### Requirement: Unified identity discovery
The login entry SHALL accept username or email, combine matching local accounts with existing SSO email-suffix/identity discovery, and preserve Superadmin/default-auth/OIDC variants. Multiple matching workspaces SHALL require explicit selection before authentication. Discovery SHALL NOT authorize access or expose account profile/role/status details.

#### Scenario: Shared identifier selects workspace
- **WHEN** the input matches local accounts in two workspaces and an SSO suffix
- **THEN** applicable distinct candidates appear and the selected workspace determines the subsequent authentication method

#### Scenario: New SSO user
- **WHEN** an email has no Chorus user record but matches existing SSO workspace suffix configuration
- **THEN** the existing SSO flow remains discoverable without user preprovisioning

### Requirement: Scoped local password login
Local login SHALL independently verify company local-auth mode, identity, active state and password, then mint a bounded secure HttpOnly session. It SHALL reject invited/disabled/deleted accounts, wrong-workspace credentials and attempts to use local login on SSO companies.

#### Scenario: Wrong workspace login
- **WHEN** a user supplies their valid password with a different selected workspace
- **THEN** login fails with a generic credential error

### Requirement: Per-request session revocation
Local sessions SHALL include and validate a generation against current tenant-bound account state on every auth resolution. Reset/state/privilege changes SHALL invalidate old sessions. Current administrative identity SHALL be read from the database, not trusted from a stale token. Existing OIDC/default flows SHALL remain compatible without granting local admin privilege or bypassing managed account state.

#### Scenario: Stale admin session
- **WHEN** a local administrator is demoted or disabled after their session is minted
- **THEN** that session cannot continue authorizing management requests

### Requirement: Low-cost bounded live stream revocation
Event and notification SSE connections SHALL register account-change listeners before an initial authoritative state check. Committed user/session/Agent/key changes SHALL broadcast tenant- and UUID-scoped invalidation; rollback SHALL NOT broadcast. Related changes SHALL revalidate the connection's established credential and suspend queued deliveries during validation. Ordinary deliveries SHALL NOT repeat full authentication or API-key usage writes. A monotonic authorization lease SHALL expire at most 30 seconds from the start of its authoritative check, enforced at final enqueue independently of timer scheduling or query completion. Known credential expiry SHALL also be enforced locally. Lightweight checks SHALL normally renew ahead of the existing 30-second heartbeat; failure or deadline expiry SHALL close and clean up the connection. Redis propagation is best-effort and missed broadcasts MAY leave a bounded 30-second revocation window. Existing resource authorization SHALL remain separate.

#### Scenario: Ordinary burst
- **WHEN** an eligible established connection receives a burst of events within its lease
- **THEN** deliveries use local validity/deadline checks without per-message authentication reads or API-key usage writes

#### Scenario: Related committed change
- **WHEN** a committed disable, removal, session change or key revocation concerns the connection or its owner
- **THEN** pending messages wait for authoritative validation and invalid credentials close without further delivery; unrelated tenants and fresh valid sessions are not closed

#### Scenario: Missed relay or stalled validation
- **WHEN** a remote account-change broadcast is missed or a renewal query hangs
- **THEN** final enqueue rejects delivery at the existing 30-second lease deadline even if timers are delayed

#### Scenario: Password-only reset preserves owner keys
- **WHEN** an active owner's password is reset without changing their eligibility
- **THEN** old human sessions fail while otherwise-valid owned-Agent keys and newly minted human sessions remain eligible

### Requirement: Owned agent authentication ceiling
REST and MCP Agent API-key authentication SHALL reject missing, cross-tenant or ineligible owners. Owner project/resource access SHALL remain the ceiling on Agent access; ordinary-user business permissions SHALL NOT be zeroed because they lack Workspace Admin. Unowned Agent behavior SHALL remain unchanged.

#### Scenario: Owner disabled
- **WHEN** an Agent's owner is disabled or removed
- **THEN** existing Agent API keys cannot authenticate in REST or MCP

#### Scenario: Ordinary active owner
- **WHEN** an active ordinary user owns an Agent
- **THEN** the Agent keeps eligible preset/custom operations within the owner's project-access boundary and cannot administer workspace users

### Requirement: Bilingual theme-aware management UI
The system SHALL provide username/email login and selection, local password step, credential acceptance, Superadmin local bootstrap and Workspace Admin user settings using shadcn components and localized en/zh strings with light/dark semantic colors. Required-operation failures SHALL remain visible and no UI-only gate SHALL replace API authorization.

#### Scenario: Complete administration in either theme
- **WHEN** an eligible admin uses either supported theme/locale
- **THEN** they can perform each user lifecycle action and copy issued credential links with visible result/error feedback

### Requirement: Regression and isolated integration evidence
The implementation SHALL include independently runnable tests of tenant isolation, token replay/expiry, lifecycle revocation, last-admin concurrency and backward-compatible discovery. Integrated verification SHALL use an isolated database and exercise real browser flows without changing production data; unavailable tooling SHALL be reported faithfully.

#### Scenario: End-to-end local lifecycle
- **WHEN** isolated verification runs bootstrap, acceptance, login, management, reset and owner disable/remove
- **THEN** expected success and rejection paths are observed and tests do not merely assert mocks of the system under test
