## ADDED Requirements

### Requirement: Home-wide Chorus MCP connection

The installer SHALL add exactly one home-wide dsh MCP client row with server name `chorus`, Streamable HTTP transport, a URL ending in `/api/mcp`, and non-blocking initial failure behavior. The effective dsh tool namespace SHALL expose synchronized server tools as `mcp__chorus__*`. A failed initial connection MUST emit a server-qualified failure and retry diagnostic rather than remaining silent.

#### Scenario: Tools are available across profiles
- **WHEN** installation succeeds and Chorus MCP is reachable
- **THEN** dsh headless and interactive profile compositions contain the Chorus MCP row and a Chorus tool is visible and callable

#### Scenario: Chorus is temporarily unavailable
- **WHEN** a dsh profile starts while the Chorus MCP endpoint is unavailable
- **THEN** dsh startup completes, the MCP client retries according to its reconnect policy, and output identifies `mcp-client(chorus)` with the connection failure and pending retry

### Requirement: Protected credential persistence

The installer MUST persist `CHORUS_URL` and `CHORUS_API_KEY` in owner-only `$DSH_HOME/.env`. The generated patch MUST derive its URL and Authorization header from Loader environment expressions and MUST NOT contain the literal API key. The installer MUST NOT place or print the API key in process arguments or logs.

#### Scenario: First credential installation
- **WHEN** valid Chorus connection values are supplied
- **THEN** the installer writes the two environment keys, sets `.env` mode to `0600`, and writes a key-free MCP patch

#### Scenario: Credential rotation
- **WHEN** the installer is rerun with a new valid API key
- **THEN** the old key is replaced exactly once without changing unrelated `.env` entries or exposing either key in output

### Requirement: Idempotent configuration mutation

The installer SHALL preserve unrelated dsh environment and patch content, replace only its marked patch region, and produce one canonical Chorus MCP row after every successful run. It MUST reject malformed managed markers without modifying the affected patch.

#### Scenario: Repeated installation
- **WHEN** the installer runs multiple times against an existing valid installation
- **THEN** the effective configuration contains one Chorus row and one copy of each Chorus environment key

#### Scenario: Existing user configuration
- **WHEN** `$DSH_HOME/.env` and `$DSH_HOME/cordis.patch.yml` contain unrelated user entries
- **THEN** those entries remain intact after installation

#### Scenario: Damaged managed region
- **WHEN** the patch contains an unmatched Chorus begin or end marker
- **THEN** the installer exits non-zero and leaves the patch unchanged

### Requirement: Portable and verifiable installation

The public installer SHALL run under Bash 3.2, support non-interactive `curl | bash` use when environment values are supplied, verify that `dsh` is available, and validate the resulting composition before reporting success.

#### Scenario: Non-interactive install
- **WHEN** stdin is a pipe and both Chorus environment values are present
- **THEN** installation completes without reading from a terminal

#### Scenario: Missing dsh CLI
- **WHEN** `dsh` cannot be found on `PATH`
- **THEN** installation fails with an actionable installation prerequisite and does not report success

#### Scenario: Invalid effective composition
- **WHEN** dsh rejects the generated patch or cannot resolve the MCP client package
- **THEN** installation exits non-zero with the dsh validation error
