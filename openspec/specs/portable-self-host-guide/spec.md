# portable-self-host-guide Specification

## Purpose
Provide a portable single-instance Linux/Docker deployment guide for Chorus with
PostgreSQL, optional Cloudflare Named Tunnel access, safe recovery operations and
honest isolated validation evidence independent of the author's machine.

## Requirements

### Requirement: Portable and isolated deployment example
The deployment example SHALL run a single Chorus instance with PostgreSQL 17 without Redis, SHALL persist application signing material and database data, SHALL require private credentials and explicit image selection, and SHALL not publish database ports or reuse existing named resources.

#### Scenario: Local HTTP deployment
- **WHEN** a reader supplies private environment values and selects local mode
- **THEN** the app is accessible only on a configurable loopback port, secure-cookie settings match HTTP, and database health gates app startup.

#### Scenario: Optional public HTTPS deployment
- **WHEN** a reader supplies a Named Tunnel token and routes their hostname to the app container
- **THEN** the Tunnel mode publishes no host ports, uses secure cookies and the reader's external HTTPS URL, and keeps the token out of tracked configuration and command-line values.

### Requirement: Reader-oriented operations
The guide SHALL describe prerequisites and support limits, reproducible setup, authentication including team OIDC limitations of the test login, cost and cache boundaries, health/login/API/MCP/SSE/daemon validation, persistence, backup, isolated restore, upgrade and schema-aware rollback. R2 SHALL be optional encrypted backup storage only.

#### Scenario: Different reader machine
- **WHEN** a reader follows the guide on a qualifying Linux Docker host
- **THEN** all host-specific values are replaceable, no access to the author's accounts or machine paths is needed, and local deployment is distinct from optional Cloudflare public access.

#### Scenario: Restore rehearsal
- **WHEN** the reader follows the backup/restore instructions
- **THEN** fresh isolated resources restore the logical database and needed signing material without modifying the source instance or treating an image downgrade as a database rollback.

#### Scenario: PostgreSQL 16 to 17 migration
- **WHEN** an operator upgrades an existing PostgreSQL 16 deployment to the PostgreSQL 17 default
- **THEN** the guide warns that PostgreSQL 17 cannot open PostgreSQL 16 data volumes and requires logical backup with `pg_dump` and restore with `pg_restore` into a fresh isolated volume before validation and controlled cutover.
- **AND** the original database volume, signing material and private configuration remain available for recovery; `docker compose down -v` SHALL NOT be used as an upgrade step.

### Requirement: Honest and sanitized validation evidence
The change SHALL include separate local evidence with tested versions, commands/results, resource isolation and outstanding checks; it SHALL not expose credentials or claim unexecuted public-path checks succeeded.

#### Scenario: User cloud prerequisites unavailable
- **WHEN** a domain or user-created Tunnel is unavailable
- **THEN** local guide validation proceeds independently and the evidence explicitly marks public HTTPS, edge SSE/MCP and external daemon reconnect as unverified with actionable verification steps.

#### Scenario: Existing host resources
- **WHEN** local validation runs
- **THEN** it uses fresh test data and project-scoped resources without stopping, deleting or reusing existing containers, volumes or databases.

### Requirement: Local installer with explicit image source
The installer SHALL route a local deployment target before AWS prerequisites or saved AWS-config reuse, SHALL preserve the existing AWS ALB/CloudFront modes, and SHALL offer pulling an explicit application tag/digest or building the current checkout's production Docker image. Local deployment SHALL reuse the loopback-only PostgreSQL Compose configuration, default to PostgreSQL 17, and wait for health. Local setup SHALL NOT execute or overwrite an existing AWS deployment script.

#### Scenario: Pull or build
- **WHEN** the operator selects local pull mode
- **THEN** the installer pulls the chosen app image and PostgreSQL before startup.
- **WHEN** the operator selects local build mode
- **THEN** it builds the repository Dockerfile production target under a local tag, pulls PostgreSQL but not that app tag, and starts without implicitly pulling the app.
- **AND** both fresh-install modes pull the official `httpd:2.4-alpine` helper image for admin bcrypt generation and start Compose with `up --pull never --wait`; no host Node.js or pnpm is required.

#### Scenario: Separate local deployment and test ports
- **WHEN** the operator installs locally without specifying a host port
- **THEN** the installer uses loopback host port 18637, distinct from test port 8637, while the container and Tunnel origin keep port 8637.
- **AND** an explicit `--port` overrides `CHORUS_PORT`, which overrides the installer default; manual Compose retains its existing fallback.

#### Scenario: Noninteractive and dry-run safety
- **WHEN** invoked without a terminal or with explicit noninteractive mode
- **THEN** missing/invalid required inputs fail rather than prompt; real installation requires both emails and passwords plus a valid image selection.
- **WHEN** the operator previews fresh local setup with `--dry-run`
- **THEN** both emails and a valid image selection remain required (build may use its default tag), but passwords are not required, no hash is computed, no Docker command runs, and no files are written.

#### Scenario: Private state and collision protection
- **WHEN** a new local installation is requested
- **THEN** chosen and generated credentials stay in a mode-0600 env file in a mode-0700 private directory outside the checkout, are absent from logs and command arguments, and inherited Compose variables cannot replace the saved values.
- **AND** existing private config, saved deployment script/config, or project resources cause refusal instead of overwrite, secret rotation or database reuse; exact generated volume/network/container names are checked regardless of labels, and inventory errors fail closed before image preparation.
- **AND** startup failure preserves the new configuration for diagnosis.

### Requirement: Separate local bootstrap and administrator credentials
Fresh local setup SHALL request ordinary login email/password and separate super admin email/password. The existing `DEFAULT_USER` development/demo login SHALL NOT be represented as full team SSO; `/admin` SHALL remain a separate account, with team OIDC configured separately.

#### Scenario: Interactive account setup
- **WHEN** credentials are not already supplied and setup runs interactively
- **THEN** both account emails are requested, both passwords and their confirmation are hidden, and mismatched confirmation fails.
- **AND** both passwords must be single-line and at least 8 bytes; the administrator password must not exceed bcrypt's 72-byte limit.

#### Scenario: Noninteractive secret input
- **WHEN** the operator supplies credentials noninteractively
- **THEN** `--email` and `--admin-email` select the account emails, with `DEFAULT_USER` and `SUPER_ADMIN_EMAIL` environment fallbacks.
- **AND** passwords come from `--password-file` and `--admin-password-file` or the `DEFAULT_PASSWORD` and `SUPER_ADMIN_PASSWORD` environment variables, with file inputs taking precedence; raw-password argv options SHALL NOT be accepted.
- **AND** bilingual Bash examples use placeholder password-file paths, not actual secrets in arguments, and instruct operators to protect local files outside the checkout.
- **AND** before reading password files, the installer requires readable regular non-symlink files outside the source checkout to prevent inclusion in the Docker build context.

#### Scenario: Hashing and credential persistence
- **WHEN** real setup prepares credentials
- **THEN** it passes the admin password through stdin to `htpasswd` in an ephemeral official `httpd:2.4-alpine` Docker container with `--network none`, generates a cost-12 bcrypt hash, and removes the helper container on exit.
- **AND** it saves only the single-quoted admin bcrypt hash, never plaintext `SUPER_ADMIN_PASSWORD`; the ordinary `DEFAULT_PASSWORD` remains plaintext encoded as a double-quoted Compose env value with backslashes and double quotes escaped and literal `$` encoded as `$$`, preserving trailing backslashes rather than using unsafe single-quoted dotenv encoding for ordinary passwords.
- **AND** the database password is randomly generated, and existing signing-key behavior remains unchanged, including persistent automatic signing material when `NEXTAUTH_SECRET` is empty.

### Requirement: Saved local redeployment wrapper
Fresh local setup SHALL generate a secret-free mode-0700 `default_deploy.sh`, or the path selected by `CHORUS_DEPLOY_CONFIG`, that invokes `deploy/self-host/deploy-local.sh` with saved project, private-directory and image-source metadata. Existing installations SHALL use their saved wrapper rather than rerunning setup; an older instance may receive a wrapper pointing to its existing private path without executing a deployment or regenerating configuration.

#### Scenario: Repeat build or pull deployment
- **WHEN** the operator runs the saved wrapper
- **THEN** build mode builds the current checkout's production Docker image, while pull mode pulls the application image saved in the existing private env.
- **AND** the helper reads the database image from that env and pulls it only if missing locally, rather than replacing it with a new default or upgrading its major version.
- **AND** image selection reads only explicit unquoted saved `CHORUS_IMAGE` and `POSTGRES_IMAGE` tag/digest values; the helper SHALL NOT source the env file as shell code, while Compose continues to consume it for service configuration.
- **AND** Compose applies `up --pull never --wait` idempotently without credential rotation, `down`, or volume removal.
- **AND** idempotence means reuse of the same project, resources and credentials, not migration rollback or zero database writes; the guide SHALL warn that app startup can apply Prisma migrations and require database/signing-state backups before deploying new code.

#### Scenario: Preserve private deployment overrides
- **WHEN** the saved private directory contains `https.yml` or `pg17.yml`
- **THEN** on every run the helper automatically appends each present file after the base/local Compose files, preserving both when both exist rather than reverting the existing HTTPS or PostgreSQL configuration.

#### Scenario: Preview saved deployment
- **WHEN** the operator runs the saved wrapper with `--dry-run`
- **THEN** it reads and validates saved metadata and image references and reports the selected Compose files without invoking Docker, writing files, or regenerating credentials.
- **AND** creating a wrapper and checking only its dry-run SHALL NOT be represented as rebuilding the existing runtime or executing a deployment.
