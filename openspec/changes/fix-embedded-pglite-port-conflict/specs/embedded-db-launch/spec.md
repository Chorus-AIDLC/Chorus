## ADDED Requirements

### Requirement: Embedded PGlite launch detects child-process exit
The standalone `chorus` server SHALL treat the embedded PGlite child process exiting before its port is confirmed ready as a fatal launch failure, regardless of the child's exit code. Detecting that a TCP port is listening SHALL NOT by itself be accepted as evidence that the embedded PGlite is running.

#### Scenario: PGlite child exits with code 0 after EADDRINUSE
- **WHEN** the embedded PGlite child process is forked on a port already bound by another process and the child exits (observed exit code 0 after catching `EADDRINUSE`) before readiness is confirmed
- **THEN** the launch is treated as failed and the server does not proceed to run migrations against whatever is listening on that port

#### Scenario: PGlite child exits with a non-zero code
- **WHEN** the embedded PGlite child process exits with any non-zero code before readiness is confirmed
- **THEN** the launch is treated as failed and a fatal error is reported

#### Scenario: Healthy embedded PGlite start
- **WHEN** no other process occupies the port and the forked PGlite child is still alive at the moment the port reports ready
- **THEN** the launch succeeds and the server proceeds to migrations, unchanged from the prior happy-path behavior

### Requirement: Port-conflict failure is actionable and never a silent mis-connect
When the embedded PGlite launch fails because its port is occupied, the standalone `chorus` server SHALL exit with a non-zero status and print an actionable message naming the port and offering `--pglite-port` as the remedy. It SHALL NOT print a success line (e.g. "PGlite ready") when its own PGlite child did not start, and it SHALL NOT silently connect to a foreign database listening on that port.

#### Scenario: Default port occupied by a foreign PostgreSQL
- **WHEN** a real PostgreSQL is listening on the default embedded port and the user runs `chorus` with no `DATABASE_URL` set
- **THEN** the server prints a message identifying the occupied port and instructing the user to free it or pass `chorus --pglite-port <port>`, and exits non-zero without attempting migrations against the foreign PostgreSQL

#### Scenario: No misleading readiness line on conflict
- **WHEN** the embedded PGlite child fails to bind its port
- **THEN** the console output does not contain a "PGlite ready" confirmation for that port

### Requirement: Database authentication failure is rewritten into a Chorus diagnostic
When a database connection used for migrations fails authentication (Prisma P1000), the standalone `chorus` server SHALL present a Chorus-authored diagnostic as the final output. The diagnostic SHALL name the connected host and port (with credentials masked), state that the server rejected the credentials, and give a remedy appropriate to why that database was chosen. Migration failures that are NOT authentication failures SHALL retain the existing generic error path.

#### Scenario: P1000 on the embedded-PGlite path
- **WHEN** migrations fail with an authentication error and no external `DATABASE_URL` was set (embedded PGlite path)
- **THEN** the diagnostic explains the port is likely occupied by another PostgreSQL and instructs the user to retry with `chorus --pglite-port <free port>`

#### Scenario: P1000 on the external DATABASE_URL path
- **WHEN** migrations fail with an authentication error and `DATABASE_URL` was set in the environment
- **THEN** the diagnostic names the external host:port from `DATABASE_URL` and instructs the user to `unset DATABASE_URL` if that target was unintended

#### Scenario: Non-authentication migration failure
- **WHEN** migrations fail for a reason other than authentication (e.g. a schema or connectivity error unrelated to credentials)
- **THEN** the server reports the failure via the existing generic migration-failure path without falsely attributing it to credentials

### Requirement: DATABASE_URL provenance is visible when embedded PGlite is skipped
When the standalone `chorus` server skips launching embedded PGlite because `DATABASE_URL` is set, it SHALL make that provenance visible in the startup banner and in any subsequent connection-failure diagnostic, naming the external host and port (credentials masked). The precedence semantics (a set `DATABASE_URL` takes priority over embedded PGlite) SHALL remain unchanged.

#### Scenario: Banner shows external DATABASE_URL source
- **WHEN** `chorus` starts with `DATABASE_URL` set in the environment
- **THEN** the startup banner's database line indicates the database comes from `DATABASE_URL` and names its host:port with credentials masked

#### Scenario: Residual DATABASE_URL is not silently honored
- **WHEN** `DATABASE_URL` is set and the resulting connection fails
- **THEN** the failure diagnostic points out that `DATABASE_URL` selected the target database, so a residual/unintended export is visible rather than hidden
