## MODIFIED Requirements

### Requirement: `--agent` selection with single implemented backend

The daemon SHALL accept an `--agent <type>` flag and a `CHORUS_AGENT` environment variable selecting which local agent backend to wake, defaulting to `claude-code`. The daemon SHALL validate the resolved value against the set of known agent types — which SHALL include both `claude-code` and `codex` — and SHALL reject an unknown value with a clear, non-zero error naming the accepted values (it SHALL NOT silently fall back). The resolved agent type SHALL be displayed in the startup banner. The daemon SHALL select which spawner backend to inject based on the resolved agent type. Selecting `claude-code` (explicitly or by default) SHALL behave exactly as the current daemon spawn. Selecting `codex` SHALL wake a local headless Codex subprocess (see the `daemon-codex-backend` capability).

#### Scenario: Default agent type is claude-code

- **WHEN** the user runs `chorus daemon` with no `--agent` flag and no `CHORUS_AGENT` env
- **THEN** the resolved agent type is `claude-code`, shown in the banner, and the daemon wakes a local Claude Code subprocess as before

#### Scenario: Explicit claude-code is accepted

- **WHEN** the user runs `chorus daemon --agent claude-code` (or sets `CHORUS_AGENT=claude-code`)
- **THEN** the daemon accepts it, displays it in the banner, and wakes Claude Code normally

#### Scenario: codex is an accepted backend

- **WHEN** the user runs `chorus daemon --agent codex` (or sets `CHORUS_AGENT=codex`)
- **THEN** the daemon accepts it, displays `codex` in the startup banner, and on a wake spawns a local headless Codex subprocess instead of Claude Code

#### Scenario: Unknown agent type is rejected visibly

- **WHEN** the user passes `--agent <unknown>` (or sets `CHORUS_AGENT` to an unknown value)
- **THEN** the daemon exits non-zero with a clear error naming the accepted agent types and does not start, rather than silently falling back to a default
