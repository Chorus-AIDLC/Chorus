# login-role-resolution Specification

## ADDED Requirements

### Requirement: identify SHALL resolve all matching auth paths for an email

`POST /api/auth/identify` MUST evaluate every authentication path an email maps to — superadmin (`isSuperAdminEmail`), default-auth (`isDefaultAuthEnabled` and `email === getDefaultUserEmail()`), and company OIDC candidates (`getCandidateCompaniesForEmail`) — rather than returning on the first match. The response MUST then be selected by the number and kind of matching paths, and MUST remain backward compatible for every case that the pre-existing contract already covered.

#### Scenario: A single matching path returns its existing single-match shape

- **GIVEN** an email for which exactly one auth path matches
- **WHEN** the client calls `POST /api/auth/identify`
- **THEN** for superadmin-only the response MUST be `{ type: "super_admin" }`
- **AND** for default-auth-only the response MUST be `{ type: "default_auth" }`
- **AND** for exactly one OIDC company the response MUST be `{ type: "oidc", company: { uuid, name, oidcIssuer, oidcClientId } }`

#### Scenario: No matching path returns not_found

- **GIVEN** an email that matches no superadmin, no default-auth, and zero OIDC companies
- **WHEN** the client calls `POST /api/auth/identify`
- **THEN** the response `type` MUST be `not_found`
- **AND** the response MUST include a human-readable `message` string

#### Scenario: Multiple OIDC companies with no superadmin or default-auth stays oidc_multi_match

- **GIVEN** an email that matches two or more OIDC companies and matches neither superadmin nor default-auth
- **WHEN** the client calls `POST /api/auth/identify`
- **THEN** the response `type` MUST be `oidc_multi_match`
- **AND** each candidate MUST expose `uuid`, `name`, and `oidcIssuerHost` (via `parseHost`)
- **AND** no candidate MUST expose `oidcClientId` or the raw `oidcIssuer`

### Requirement: identify SHALL return multi_role when superadmin or default-auth collides with another path

When the set of matching auth paths includes superadmin and/or default-auth **alongside at least one other distinct path**, `POST /api/auth/identify` MUST return `type: "multi_role"` with a `roles` array containing one entry per matching path. Each entry MUST carry a `kind` of `super_admin`, `default_auth`, or `oidc`. Entries of kind `oidc` MUST carry the `company` payload (`uuid`, `name`, `oidcIssuer`, `oidcClientId`) required to start an OIDC redirect; entries of kind `super_admin` and `default_auth` MUST NOT carry any secret material.

#### Scenario: Superadmin email that is also the default-auth user returns multi_role

- **GIVEN** `SUPER_ADMIN_EMAIL` and `DEFAULT_USER` are configured to the same email, and default auth is enabled
- **WHEN** the client calls `POST /api/auth/identify` with that email
- **THEN** the response `type` MUST be `multi_role`
- **AND** `roles` MUST contain an entry with `kind: "super_admin"` and an entry with `kind: "default_auth"`
- **AND** neither of those entries MUST contain a password, hash, or token

#### Scenario: Superadmin email that also matches a company OIDC domain returns multi_role

- **GIVEN** an email that is the superadmin and also matches exactly one OIDC company
- **WHEN** the client calls `POST /api/auth/identify`
- **THEN** the response `type` MUST be `multi_role`
- **AND** `roles` MUST contain an entry with `kind: "super_admin"` and an entry with `kind: "oidc"`
- **AND** the `oidc` entry MUST include `company.uuid`, `company.name`, `company.oidcIssuer`, and `company.oidcClientId`

### Requirement: check-default SHALL report a superadmin collision flag

`GET /api/auth/check-default` MUST return a `superAdminCollision` boolean in addition to the existing `enabled` field. `superAdminCollision` MUST be `true` if and only if default auth is enabled AND the configured `DEFAULT_USER` equals `SUPER_ADMIN_EMAIL` (case-insensitive). The endpoint MUST NOT echo back the configured email address.

#### Scenario: Collision flag is true when both env vars point at the same email

- **GIVEN** default auth is enabled and `DEFAULT_USER` case-insensitively equals `SUPER_ADMIN_EMAIL`
- **WHEN** the client calls `GET /api/auth/check-default`
- **THEN** the response MUST include `enabled: true` and `superAdminCollision: true`
- **AND** the response MUST NOT contain the configured email string

#### Scenario: Collision flag is false when there is no overlap

- **GIVEN** default auth is enabled and `DEFAULT_USER` differs from `SUPER_ADMIN_EMAIL` (or no superadmin is configured)
- **WHEN** the client calls `GET /api/auth/check-default`
- **THEN** the response MUST include `superAdminCollision: false`

#### Scenario: Collision flag is false when default auth is disabled

- **GIVEN** default auth is not enabled
- **WHEN** the client calls `GET /api/auth/check-default`
- **THEN** the response MUST include `enabled: false` and `superAdminCollision: false`

### Requirement: The login page SHALL present a role picker on collision and route each choice to its existing flow

When the login page detects a multi-role situation — either `check-default` reports `superAdminCollision: true` at page load, or `POST /api/auth/identify` returns `type: "multi_role"` — it MUST render a role-picker built from existing shadcn/ui components, with one selectable option per available role and all visible strings sourced from i18n (`en` and `zh`). Selecting a role MUST route to that role's existing authentication flow without altering how that flow authenticates.

#### Scenario: Picker shown up front when default-auth user collides with superadmin

- **GIVEN** `GET /api/auth/check-default` returns `superAdminCollision: true`
- **WHEN** the login page finishes its initial load
- **THEN** the page MUST render a role picker offering a superadmin option and a regular-user option
- **AND** the page MUST NOT drop the user directly into the default-auth password form without offering the superadmin choice

#### Scenario: Selecting superadmin routes to the admin login

- **GIVEN** the role picker is visible with a superadmin option and the email is known
- **WHEN** the user selects the superadmin option
- **THEN** the page MUST navigate to `/login/admin` with the email passed as a query parameter
- **AND** it MUST NOT submit the email or any password to `/api/auth/default-login`

#### Scenario: Selecting the regular-user option routes to its existing flow

- **GIVEN** the role picker is visible after a collision
- **WHEN** the user selects the regular-user (default-auth) option
- **THEN** the page MUST present the existing default-auth password form that submits to `/api/auth/default-login`
- **AND** the superadmin path MUST NOT be invoked for that submission

#### Scenario: Selecting an OIDC option starts the OIDC redirect

- **GIVEN** a `multi_role` response whose `roles` includes an `oidc` entry with a company payload
- **WHEN** the user selects that company option
- **THEN** the page MUST start the OIDC sign-in redirect for that company using the company payload, with the email passed as `login_hint`

### Requirement: Authentication endpoints SHALL remain unchanged by role resolution

This change MUST NOT modify how `/api/admin/login` or `/api/auth/default-login` authenticate a request. Each endpoint MUST continue to validate its own credential against its own configured secret and set its own session cookie. Only role detection (`identify`, `check-default`) and frontend routing change.

#### Scenario: Superadmin login still uses the admin endpoint and admin cookie

- **GIVEN** the user picked the superadmin option and submitted the superadmin password on `/login/admin`
- **WHEN** the credential is valid
- **THEN** authentication MUST proceed via `/api/admin/login` and set the `admin_session` cookie exactly as before this change

#### Scenario: Regular-user login still uses the default-login endpoint and user cookie

- **GIVEN** the user picked the regular-user option and submitted the default-auth password
- **WHEN** the credential is valid
- **THEN** authentication MUST proceed via `/api/auth/default-login` and set the `user_session` cookie exactly as before this change
