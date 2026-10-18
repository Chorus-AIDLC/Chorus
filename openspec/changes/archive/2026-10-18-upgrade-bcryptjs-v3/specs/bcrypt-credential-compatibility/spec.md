## ADDED Requirements

### Requirement: Workspace bcrypt dependency compatibility
The application and CDK SHALL use bcryptjs 3.x with the declared range `^3.0.3`, shipped TypeScript declarations and a synchronized pnpm lockfile. The upgrade MUST preserve pure-JavaScript distribution and existing supported runtime/platform policy.

#### Scenario: Application and deployment entrypoints
- **WHEN** the application imports bcryptjs and CDK consumes its CommonJS-compatible entrypoint
- **THEN** async hash/compare and synchronous hash operations work without the separate `@types/bcryptjs` package or a native bcrypt module

### Requirement: Existing bcrypt credentials remain valid
The application SHALL accept existing bcryptjs 2.4.3 hashes for the correct password and reject incorrect passwords, including local users and deployment-generated super-admin credentials, without resetting or rewriting stored hashes.

#### Scenario: Legacy local user login
- **WHEN** a synthetic fixed 2.4.3 cost-12 hash is used by an eligible local account
- **THEN** credential verification and workspace login accept its matching password and reject a wrong password

#### Scenario: Legacy deployment credential
- **WHEN** a synthetic fixed 2.4.3 cost-10 hash is configured as the super-admin credential
- **THEN** real super-admin comparison accepts the matching password and rejects a wrong password

### Requirement: Password policy and work factors remain unchanged
New local user hashes SHALL retain cost 12; CDK-generated super-admin hashes SHALL retain cost 10. Local password validation MUST retain its existing character and UTF-8 byte rules, including the 72-byte upper boundary.

#### Scenario: New hashes use existing work factors
- **WHEN** local password creation or CDK-style synchronous hashing runs with bcryptjs 3.x
- **THEN** the resulting hashes compare correctly and encode factors 12 and 10 respectively

#### Scenario: Multibyte password boundary
- **WHEN** local validation receives otherwise valid multibyte passwords at 72 UTF-8 bytes and above 72 bytes
- **THEN** the 72-byte password remains accepted and an over-limit password remains rejected
