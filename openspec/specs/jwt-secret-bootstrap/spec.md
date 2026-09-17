# jwt-secret-bootstrap Specification

## Purpose
Guarantee that no Chorus deployment silently signs session JWTs with a publicly known default `NEXTAUTH_SECRET`: the Docker entrypoint generates and persists a random secret when none (or a known placeholder) is configured, and the application loudly warns when a known placeholder is still in effect (GitHub #559).
## Requirements
### Requirement: Docker entrypoint bootstraps a random JWT secret
The Docker entrypoint SHALL, when the container starts with `NEXTAUTH_SECRET` empty or
equal to a known public placeholder, obtain a random secret from
`/app/data/.secret` — reusing a persisted non-empty value, or generating a new one with
`openssl rand -hex 32` and persisting it with owner-only permissions — and SHALL export it
as `NEXTAUTH_SECRET` to the application process before database migrations run. The
entrypoint MUST NOT fall back to any publicly known value and MUST NOT print the secret.

#### Scenario: NEXTAUTH_SECRET is unset
- **WHEN** the container starts with `NEXTAUTH_SECRET` unset or empty and no `/app/data/.secret` exists
- **THEN** `/app/data` is created if missing, `/app/data/.secret` is created with mode `0600` containing a 64-hex-character value
- **AND** the application process receives that value as `NEXTAUTH_SECRET`
- **AND** the startup log states that a secret was generated and persisted, without printing the value

#### Scenario: NEXTAUTH_SECRET equals the legacy compose placeholder
- **WHEN** the container starts with `NEXTAUTH_SECRET=chorus-docker-secret-change-in-production` (or any other known placeholder)
- **THEN** the placeholder is ignored and the bootstrap proceeds exactly as if the variable were unset
- **AND** the exported `NEXTAUTH_SECRET` differs from every known placeholder
- **AND** the startup log states that a publicly known placeholder was detected and replaced

#### Scenario: Persisted secret is reused
- **WHEN** the container starts with `NEXTAUTH_SECRET` unset and `/app/data/.secret` contains a non-empty value
- **THEN** that value is exported unchanged and the file is not rewritten
- **AND** the startup log states that the persisted secret is being reused

#### Scenario: Empty persisted file is regenerated
- **WHEN** `/app/data/.secret` exists but is empty or contains only whitespace
- **THEN** the entrypoint treats it as missing and generates and persists a new secret

#### Scenario: Unusable secret file fails closed
- **WHEN** `/app/data/.secret` exists but is not a regular file, cannot be read, or cannot be written
- **THEN** the entrypoint exits non-zero with a descriptive error before running migrations
- **AND** no publicly known value is exported

#### Scenario: Partial or malformed generation fails closed
- **WHEN** the generator (`openssl rand -hex 32`) exits non-zero, or exits zero with output that is not exactly 64 lowercase hex characters
- **THEN** the entrypoint removes its temporary file, exits non-zero with a descriptive error, and exports nothing
- **AND** any pre-existing `/app/data/.secret` is left unchanged

#### Scenario: Concurrent first starts on one volume converge
- **WHEN** two starters sharing `/app/data` both find no usable secret and one installs a valid secret first
- **THEN** the install is exclusive (`ln tmp target`), so the second starter does not overwrite it and instead re-reads and exports the first starter's value
- **AND** an existing empty or whitespace-only `.secret` is removed only after being re-verified as empty (best-effort convergence; multi-replica deployments still MUST inject `NEXTAUTH_SECRET` explicitly)

#### Scenario: Explicit secure value is untouched
- **WHEN** the container starts with `NEXTAUTH_SECRET` set to a value that is not a known placeholder
- **THEN** the entrypoint does not create, read, or modify `/app/data/.secret`
- **AND** the exported value is exactly the configured value

#### Scenario: Shell state does not leak into the application
- **WHEN** the bootstrap generates a new secret
- **THEN** the parent shell's `umask` and noclobber state are unchanged after the bootstrap returns

### Requirement: Single source of truth for known insecure placeholders
The system SHALL treat exactly the following values as known public placeholders:
`chorus-docker-secret-change-in-production`, `chorus-local-secret`,
`your-secret-key-change-in-production`, `change-me-to-a-random-secret`. The list SHALL be
defined in the shell bootstrap library, in `src/lib/secret-check.ts`, and in the npm launcher
`chorus.mjs`, and an automated test SHALL fail if any of the three lists differ.

#### Scenario: Lists are identical
- **WHEN** the test suite runs
- **THEN** the placeholder values parsed from `docker/ensure-secret.sh` and from `chorus.mjs` each equal `KNOWN_INSECURE_SECRETS` from `src/lib/secret-check.ts` as sets

### Requirement: npm launcher ignores placeholder secrets
The `chorus` npm launcher (`chorus.mjs#ensureSecret`) SHALL treat a `NEXTAUTH_SECRET` equal to a known placeholder like unset: it SHALL print a one-line warning to stderr referencing #559 and fall through to the persisted or newly generated `~/.chorus/.secret`.

#### Scenario: Pasted placeholder is not used for signing
- **WHEN** the launcher starts with `NEXTAUTH_SECRET` equal to a known placeholder
- **THEN** the process signs JWTs with the value from `~/.chorus/.secret`, not the placeholder

### Requirement: Application warns at startup when a known placeholder is in effect
At Node.js process start, the application SHALL assess the effective `NEXTAUTH_SECRET`.
If it equals a known placeholder, the application SHALL log an `error`-level structured
message (module `security`, `reason: "default_secret"`) explaining that user and
super-admin session tokens can be forged, how to generate a random secret, that rotation
invalidates existing sessions, and that multi-replica deployments must share one value.
If the variable is unset, the application SHALL log a `warn`-level message
(`reason: "missing_secret"`) and otherwise keep existing behaviour. A secure custom value
SHALL produce no log output. The check MUST NOT throw or alter the value.

#### Scenario: Placeholder detected at startup
- **WHEN** the Node runtime starts with `NEXTAUTH_SECRET=chorus-local-secret`
- **THEN** exactly one `error`-level log entry with `module: "security"` and `reason: "default_secret"` is emitted during startup
- **AND** the application continues to start

#### Scenario: Secure value at startup
- **WHEN** the Node runtime starts with a `NEXTAUTH_SECRET` that is not a known placeholder
- **THEN** no `security` log entry is emitted for the secret

#### Scenario: Missing value at startup
- **WHEN** the Node runtime starts with `NEXTAUTH_SECRET` unset
- **THEN** one `warn`-level `security` log entry with `reason: "missing_secret"` is emitted
- **AND** token issuance continues to fail with `NEXTAUTH_SECRET is not set` as before

### Requirement: Compose files ship no public secret and persist the generated one
The shipped `docker-compose.yml` and `docker-compose.local.yml` SHALL NOT contain a
non-empty default for `NEXTAUTH_SECRET`; each SHALL pass through the operator's value with
`${NEXTAUTH_SECRET:-}` accompanied by a comment describing auto-generation, the
single-replica limit, how to generate a value, and that rotation logs users out. The app
service in `docker-compose.yml` SHALL mount a named volume at `/app/data`.

#### Scenario: Compose starts without an operator-provided secret
- **WHEN** an operator runs `docker compose up` with no `NEXTAUTH_SECRET` in the environment or `.env`
- **THEN** the container starts, generates a secret into the `chorus-app-data` volume, and login succeeds
- **AND** a subsequent `docker compose up --force-recreate` reuses the same secret

#### Scenario: Compose files contain no placeholder
- **WHEN** the repository's compose files are scanned
- **THEN** none of the known placeholder values appear as a `NEXTAUTH_SECRET` default

### Requirement: Documentation and release notes describe the change and migration
`docs/DOCKER.md` SHALL contain a "JWT secret security" section covering the risk, the
auto-generation behaviour and its single-replica limit, how to generate and set a strong
value, the persistence requirement, multi-replica sharing, and that rotation invalidates
sessions. `.env.example` and both ARCHITECTURE documents SHALL be updated to match the
compose contract. The `0.18.1` CHANGELOG entry SHALL separately describe the migration
impact for `docker-compose.local.yml` (one-time re-login) and for `docker-compose.yml`
users who have not updated their compose file (rotation on every recreate until a volume is
added or a secret is injected).

#### Scenario: Operator reads the Docker guide
- **WHEN** an operator opens `docs/DOCKER.md`
- **THEN** they find a section explaining auto-generation, the `openssl rand -base64 32` command, `.env` configuration, the volume requirement, and the multi-replica rule

#### Scenario: Release notes distinguish the two compose paths
- **WHEN** a reader opens the `[0.18.1]` CHANGELOG entry
- **THEN** it states the one-time re-login for `docker-compose.local.yml` and the per-recreate rotation for un-updated `docker-compose.yml` files as two separate items

