# chorus-init Specification Delta

## REMOVED Requirements

### Requirement: Interactive `chorus init` command

**Reason**: Renamed to `chorus agents add`, unifying agent configuration under the `chorus agents` CRUD group (list / add / remove). `0.17.0` is unreleased, so no back-compat alias is kept — `chorus init` is removed outright. Replaced by the ADDED "Interactive `chorus agents add` command" requirement below.

## ADDED Requirements

### Requirement: Interactive `chorus agents add` command

Chorus SHALL provide a client-mode `chorus agents add` subcommand (dispatched under the `chorus agents` group, alongside `daemon` / `login` / `mcp`) that detects the machine's coding agents, lets the user choose which to configure, and runs the ordered configuration steps against the chosen agents. It SHALL carry exactly the prior `chorus init` behavior and flags (`--agents <csv>` / `--all` / `--yes` / `--url` / `--api-key` / `--dsh-profile` / `--daemon-wake[-all]`). Running `chorus agents add --help` (and `chorus agents --help`) MUST print usage without starting the server or any configuration side effect. The bare `chorus init` command MUST NOT exist.

#### Scenario: Interactive run configures selected agents
- **WHEN** a user runs `chorus agents add` in a TTY
- **THEN** the command detects agents, presents a selection with detected agents pre-checked, and after confirmation runs the configuration steps only for the selected agents, ending with a per-agent status summary

#### Scenario: Scriptable non-interactive run
- **WHEN** `chorus agents add --agents claude,codex --url <u> --api-key <k> --yes` runs in a non-TTY environment
- **THEN** it configures exactly Claude Code and Codex without prompting, and a non-TTY run with neither `--agents` nor `--all` aborts with a message to pass one of them

#### Scenario: Help does nothing else
- **WHEN** a user runs `chorus agents add --help`
- **THEN** usage text is printed and the process exits 0 without detecting, prompting, writing files, or launching the server

### Requirement: Agent removal via `chorus agents remove`

Chorus SHALL provide a `chorus agents remove <name|uuid>` subcommand that removes the matching entry from `~/.chorus/daemon.json` `agents[]` with a merge-safe write that preserves every other agent and all top-level fields. The target MUST be matched against an entry's `agentUuid` or `agentName`; an ambiguous name MUST error and instruct the user to use the UUID, and a value matching no configured agent MUST exit non-zero and list the configured agents. The API key MUST NOT be printed. `$DSH_HOME/.env` (a single shared credential file, not per-agent) MUST be left untouched, with a one-line note that the operator may clear it manually.

#### Scenario: Remove by uuid
- **WHEN** `chorus agents remove <uuid>` names a configured agent
- **THEN** that entry is dropped from `agents[]`, the file is rewritten preserving the other agents, and success is reported without printing any key

#### Scenario: No match is a loud error
- **WHEN** `chorus agents remove <value>` matches no `agents[]` entry
- **THEN** the command exits non-zero and lists the configured agent names/UUIDs

#### Scenario: Ambiguous name requires the uuid
- **WHEN** the given name matches more than one agent
- **THEN** the command errors and instructs the user to disambiguate with the agent UUID

### Requirement: `chorus agents` groups list / add / remove

The `chorus agents` command SHALL act as an agent-management group: with no sub-verb (or `list`) it lists the configured agents (unchanged), `add` runs the configuration flow, and `remove` deletes an entry. An unknown sub-verb MUST print the `chorus agents` usage and exit non-zero. Every `--help` path under `chorus agents` MUST NOT start the embedded server.

#### Scenario: Bare command lists agents
- **WHEN** a user runs `chorus agents`
- **THEN** the configured agents are listed and no server is started

#### Scenario: Unknown sub-verb shows usage
- **WHEN** a user runs `chorus agents bogus`
- **THEN** the command prints the `chorus agents` usage and exits non-zero
