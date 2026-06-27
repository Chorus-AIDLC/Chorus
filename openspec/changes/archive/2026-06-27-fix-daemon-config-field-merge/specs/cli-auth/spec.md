# cli-auth Spec Delta

## MODIFIED Requirements

### Requirement: Interactive login command

The CLI SHALL provide a `chorus login` subcommand that accepts a server URL and `cho_` API key (via flags or interactive prompt), validates the key against the server by fetching the authenticated agent identity, and on success persists `{ url, apiKey, agentUuid, agentName }` to `~/.chorus/daemon.json` with owner-only file permissions. The persist SHALL be a **field-level merge**: the command SHALL read any existing `~/.chorus/daemon.json`, overwrite only the credential/identity keys it sets (`url`, `apiKey`, `agentUuid`, `agentName`), and preserve every other pre-existing field (including `cwds`, `yoloAckAt`, and `sigintTimeoutMs`). A missing, unreadable, or malformed existing file SHALL be treated as an empty object so the merge still produces a valid file. On validation failure it SHALL NOT write the file. When the API key is entered interactively, the input SHALL be masked (not echoed to the terminal).

#### Scenario: Successful login persists credentials and echoes identity

- **WHEN** the user runs `chorus login` with a reachable URL and a valid `cho_` API key
- **THEN** the command fetches and displays the resolved agent identity (name + uuid) and writes the credentials to `~/.chorus/daemon.json` with owner-only permissions

#### Scenario: Login preserves pre-existing non-credential fields

- **WHEN** `~/.chorus/daemon.json` already contains `cwds` and/or `yoloAckAt` (and possibly `sigintTimeoutMs`) and the user runs a successful `chorus login`
- **THEN** the written file gains the four credential/identity fields AND retains the pre-existing `cwds`, `yoloAckAt`, and `sigintTimeoutMs` values unchanged

#### Scenario: Interactive key entry is masked

- **WHEN** the user is prompted interactively for the `cho_` API key
- **THEN** the typed key is not echoed to the terminal

#### Scenario: Invalid key is rejected without writing

- **WHEN** the user runs `chorus login` with an invalid or revoked API key
- **THEN** the command reports the authentication failure and does not create or overwrite `~/.chorus/daemon.json`

### Requirement: Interactive credential completion at daemon start (TTY only)

The daemon SHALL, when it cannot resolve a complete `url` + `cho_` API key pair
from the layered sources (flags → env → `~/.chorus/daemon.json` → plugin
fallback) **and** standard input is a TTY, NOT fail with the hard error.
Instead it SHALL run the same interactive completion flow as `chorus login` —
prompting for the server URL and a **masked** API key, validating them against
the server by fetching the authenticated agent identity, and on success
persisting `{ url, apiKey, agentUuid, agentName }` to `~/.chorus/daemon.json`
with owner-only permissions — and then SHALL continue daemon startup using the
just-completed credentials. The persist SHALL be the same **field-level merge**
as `chorus login`: it SHALL read any existing `~/.chorus/daemon.json`, overwrite
only the four credential/identity keys, and preserve every other pre-existing
field (including `cwds`, `yoloAckAt`, and `sigintTimeoutMs`). The completion flow
SHALL reuse the existing `chorus login` masked-prompt, validate, and persist
logic rather than reimplementing it. On validation failure during completion, the
daemon SHALL NOT write the file and SHALL exit non-zero.

When credentials cannot be resolved and standard input is **not** a TTY
(systemd / nohup / CI / background), the daemon SHALL preserve the existing
behavior: it SHALL NOT prompt or block, and SHALL emit the single
human-actionable multi-source error and exit non-zero.

#### Scenario: TTY start with no credentials completes interactively

- **WHEN** the user runs `chorus daemon` on a TTY with no resolvable credentials
- **THEN** the daemon prompts for URL and a masked API key, validates them, writes
  `~/.chorus/daemon.json` (owner-only) on success, and continues starting up
  without requiring a separate `chorus login` run

#### Scenario: Daemon completion preserves pre-existing non-credential fields

- **WHEN** the daemon completes credentials interactively at start and
  `~/.chorus/daemon.json` already contains `cwds` and/or `yoloAckAt`
- **THEN** the written file gains the four credential/identity fields AND retains the
  pre-existing `cwds`, `yoloAckAt`, and `sigintTimeoutMs` values unchanged

#### Scenario: Masked entry during daemon completion

- **WHEN** the daemon prompts interactively for the API key during start-time
  completion
- **THEN** the typed key is not echoed to the terminal

#### Scenario: Non-TTY start with no credentials errors without blocking

- **WHEN** `chorus daemon` starts with no resolvable credentials and stdin is not
  a TTY
- **THEN** the daemon does not prompt, emits the multi-source actionable error,
  and exits non-zero — it never blocks waiting on input no one can provide

#### Scenario: Failed validation during completion writes nothing

- **WHEN** the user completes credentials interactively at daemon start but the
  key fails server validation
- **THEN** the daemon reports the failure, does not create or overwrite
  `~/.chorus/daemon.json`, and exits non-zero
