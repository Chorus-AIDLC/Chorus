## MODIFIED Requirements

### Requirement: Scriptable non-interactive surface

The command SHALL support non-interactive use via `--agents <csv>`, `--all`, `--yes`, `--url`, and `--api-key`. When stdin or stdout is not a TTY, the command MUST require an explicit `--agents` or `--all` and abort with a clear message otherwise, rather than guessing which agents to configure. An unknown value in `--agents` MUST be a hard error that lists the valid agent ids. After agent selection, if at least one selected automated harness is already installed, an interactive run without `--yes` MUST ask once whether to update installed plugins to the latest available versions, defaulting to no. A run with `--yes`, or a non-TTY run with the required explicit selection, MUST accept that update confirmation without prompting.

#### Scenario: CI run with explicit agents
- **WHEN** `chorus agents add --agents claude,codex --url <u> --api-key <k> --yes` runs in a non-TTY environment
- **THEN** it configures exactly Claude Code and Codex without prompting and refreshes either selected plugin that is already installed

#### Scenario: Non-TTY without a selection aborts
- **WHEN** `chorus agents add` runs in a non-TTY environment with neither `--agents` nor `--all`
- **THEN** it aborts with a message instructing the caller to pass `--agents` or `--all`, and configures nothing

#### Scenario: Unknown agent id is rejected
- **WHEN** `--agents` contains an id not in the adapter registry
- **THEN** the command exits non-zero and lists the valid agent ids

#### Scenario: Interactive update confirmation is declined
- **WHEN** an interactive run selects at least one already-installed automated harness and the user declines the single update prompt
- **THEN** installed plugin payloads remain unchanged while the existing idempotent configuration-repair steps continue

#### Scenario: Interactive update confirmation is accepted
- **WHEN** an interactive run selects at least one already-installed automated harness and the user accepts the single update prompt
- **THEN** the plugin-install step refreshes installed selected harnesses to their latest available plugin payloads

#### Scenario: Yes accepts the update confirmation
- **WHEN** a run with `--yes` selects an already-installed automated harness
- **THEN** the command refreshes that plugin without prompting
