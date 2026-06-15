# cli-auth Specification

## Purpose
TBD - created by archiving change add-chorus-cli-daemon. Update Purpose after archive.
## Requirements
### Requirement: Layered credential and address resolution

The CLI SHALL resolve the Chorus server URL and `cho_` API key from multiple sources in a fixed precedence order, using the first source that yields a complete pair. The precedence SHALL be: (1) explicit command-line flags (`--url`, `--api-key`), (2) environment variables (`CHORUS_URL`, `CHORUS_API_KEY`), (3) the login file at `~/.chorus/daemon.json`, (4) a best-effort fallback to credentials already stored by the Claude Code chorus plugin. The resolver SHALL report which source supplied the credentials and, on failure, SHALL emit a single human-actionable error naming the sources it tried.

#### Scenario: Flags win over all other sources

- **WHEN** the user runs the daemon with both `--url`/`--api-key` flags set and `CHORUS_URL`/`CHORUS_API_KEY` also present in the environment
- **THEN** the resolver uses the flag values and reports the source as the flags

#### Scenario: Environment used when no flags

- **WHEN** no credential flags are passed but `CHORUS_URL` and `CHORUS_API_KEY` are set in the environment
- **THEN** the resolver uses the environment values

#### Scenario: Login file used when no flags or env

- **WHEN** no credential flags or environment variables are present and `~/.chorus/daemon.json` contains a valid url + apiKey
- **THEN** the resolver loads and uses the values from that file

#### Scenario: Plugin config used as last resort

- **WHEN** no flags, no environment variables, and no login file are available, but the Claude Code chorus plugin has previously stored a url + key
- **THEN** the resolver falls back to the plugin-stored credentials and reports the source as the plugin fallback

#### Scenario: Actionable error when nothing resolves

- **WHEN** none of the four sources yields a complete url + apiKey pair
- **THEN** the CLI exits non-zero with one error message that lists every source that was tried and how to supply credentials

### Requirement: Interactive login command

The CLI SHALL provide a `chorus login` subcommand that accepts a server URL and `cho_` API key (via flags or interactive prompt), validates the key against the server by fetching the authenticated agent identity, and on success persists `{ url, apiKey, agentUuid, agentName }` to `~/.chorus/daemon.json` with owner-only file permissions. On validation failure it SHALL NOT write the file. When the API key is entered interactively, the input SHALL be masked (not echoed to the terminal).

#### Scenario: Successful login persists credentials and echoes identity

- **WHEN** the user runs `chorus login` with a reachable URL and a valid `cho_` API key
- **THEN** the command fetches and displays the resolved agent identity (name + uuid) and writes the credentials to `~/.chorus/daemon.json` with owner-only permissions

#### Scenario: Interactive key entry is masked

- **WHEN** the user is prompted interactively for the `cho_` API key
- **THEN** the typed key is not echoed to the terminal

#### Scenario: Invalid key is rejected without writing

- **WHEN** the user runs `chorus login` with an invalid or revoked API key
- **THEN** the command reports the authentication failure and does not create or overwrite `~/.chorus/daemon.json`

