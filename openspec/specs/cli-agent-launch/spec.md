# cli-agent-launch Specification

## Purpose
TBD - created by archiving change add-cli-agent-launch. Update Purpose after archive.
## Requirements
### Requirement: Launch a configured agent via `chorus agents run`

The CLI SHALL provide a `chorus agents run` subcommand that launches a locally
installed coding-agent binary as a foreground child process, with the selected
Chorus agent's connection and identity environment injected into that child only.
The command form SHALL be
`chorus agents run --name <name|uuid> [--type <type>] [--] <agent args…>`.

#### Scenario: Launch the single configured agent

- **WHEN** `~/.chorus/daemon.json` has exactly one configured agent and the user
  runs `chorus agents run` with no `--name`
- **THEN** the launcher SHALL select that agent, resolve its binary from its
  `agentType`, and spawn it in the foreground with `CHORUS_URL`,
  `CHORUS_API_KEY`, and `CHORUS_AGENT_PROFILE` set in the child environment.

#### Scenario: Select an agent by name or UUID

- **WHEN** the user runs `chorus agents run --name <name|uuid>`
- **THEN** the launcher SHALL select the matching `agents[]` entry, and if the
  value matches more than one entry it SHALL exit non-zero with an ambiguity
  error listing the candidates, without spawning anything.

#### Scenario: No agent can be selected

- **WHEN** multiple agents are configured and no `--name` / `CHORUS_AGENT_PROFILE`
  is given, or no agents are configured at all
- **THEN** the launcher SHALL exit non-zero with a message telling the user how
  to specify or configure an agent, without spawning anything.

### Requirement: Resolve the agent binary by type

The launcher SHALL determine which binary to launch from the agent type, taking
an explicit `--type` flag over the selected agent's stored `agentType`, and SHALL
map the type to a binary name.

#### Scenario: Type maps to a known binary

- **WHEN** the resolved type is one of `claude-code`/`claude`, `codex`, `kiro`,
  `pi`, `opencode`, `openclaw`, or `dsh`
- **THEN** the launcher SHALL resolve, respectively, the `claude`, `codex`,
  `kiro-cli`, `pi`, `opencode`, `openclaw`, or `dsh-jsonrpc-agent` executable on
  `PATH` and launch it.

#### Scenario: `--type` overrides the stored type

- **WHEN** the user passes `--type codex` for an agent whose stored `agentType`
  is `claude-code`
- **THEN** the launcher SHALL launch the `codex` binary.

#### Scenario: Offline-classified agent without an explicit type

- **WHEN** the selected agent's stored `agentType` is `offline` and no `--type`
  is given
- **THEN** the launcher SHALL exit non-zero with a message instructing the user
  to pass an explicit `--type` (one of the supported types), because the concrete
  backend cannot be recovered from an `offline` classification.

#### Scenario: Agent binary not found on PATH

- **WHEN** the resolved binary does not exist on `PATH`
- **THEN** the launcher SHALL exit non-zero with an error naming the missing
  binary, without spawning anything.

### Requirement: Pass agent arguments through verbatim

The launcher SHALL pass every token after the `--` separator to the agent binary
unmodified and without validation, so the agent's full argument surface is
available.

#### Scenario: Passthrough after `--`

- **WHEN** the user runs `chorus agents run --name X -- --model opus --resume abc`
- **THEN** the launcher SHALL invoke the resolved binary with exactly
  `--model opus --resume abc` as its arguments, unaltered and unchecked.

#### Scenario: Launch with no passthrough args

- **WHEN** the user runs `chorus agents run --name X` with no `--` and no trailing
  args
- **THEN** the launcher SHALL launch the binary with no extra arguments.

### Requirement: Forward exit code and protect secrets

The command SHALL exit with the launched agent's exit code, and SHALL never
write the agent's API key to stdout, logs, or error messages.

#### Scenario: Exit code propagation

- **WHEN** the launched agent exits with code N
- **THEN** `chorus agents run` SHALL exit with code N.

#### Scenario: No secret in output

- **WHEN** the command runs (success or any error path)
- **THEN** the `cho_` API key SHALL NOT appear in any stdout, stderr, or log
  output; diagnostics SHALL identify the agent by name/UUID only.

