## MODIFIED Requirements

### Requirement: Daemon backend agentType derived from the init selection, not re-prompted

The daemon-setup step SHALL derive each agent's `daemon.json` backend `agentType` from the agents already chosen in the `chorus agents add` selection step, and SHALL NOT render a separate "which agent backend?" selection prompt. The step-1 selection is the single point at which the agent set is chosen; the credential-seed and daemon-setup steps consume that same selection.

The mapping from an init selection id to a `daemon.json` `agentType` SHALL be explicit and total: the init id `claude` maps to `agentType: "claude-code"`; `codex` → `codex`; `kiro` → `kiro`; `pi` → `pi`; and any selected agent whose backend is not daemon-wakeable (`opencode`, `openclaw`, and `dsh` while its daemon backend is de-advertised) maps to `agentType: "offline"`. The mapping MUST NOT pass an init id through verbatim when it differs from the daemon backend name (notably `claude` ≠ `claude-code`).

#### Scenario: No second backend prompt
- **WHEN** `chorus agents add` proceeds from agent selection into the daemon-setup step on a TTY
- **THEN** the step derives each agent's `agentType` from the selection and does not display an agent-backend menu again

#### Scenario: claude selection maps to the claude-code agentType
- **WHEN** the init selection includes the `claude` adapter id
- **THEN** its `agents[]` entry records `agentType: "claude-code"` (not `claude`), matching the daemon's `KNOWN_AGENTS` vocabulary

#### Scenario: pi selection maps to the wakeable pi agentType
- **WHEN** the init selection includes the `pi` adapter id
- **THEN** its `agents[]` entry records `agentType: "pi"` — a wakeable backend, so `isWakeableAgentType("pi")` is true and the entry is eligible for daemon waking

#### Scenario: Non-wakeable selection maps to offline
- **WHEN** the init selection includes an agent with no daemon-wakeable backend (e.g. `opencode` or `openclaw`)
- **THEN** its `agents[]` entry records `agentType: "offline"`

### Requirement: Per-agent daemon-wake defaults off at init with explicit opt-in

`chorus agents add` SHALL record a per-agent `daemonWake` boolean (defaulting to `false`) on the `agents[]` entry of each selected agent that maps to a daemon-wakeable backend (claude-code / codex / kiro / pi) — the agent is added (its key available to `chorus mcp`) but not woken by the daemon until the operator opts in. A selected agent that maps to
`offline` (a backend that cannot be daemon-woken) SHALL NOT be given a `daemonWake` field
(it can never wake). The opt-in SHALL be explicit: on a TTY the command asks, per
daemon-wakeable selected agent, whether to enable daemon waking for that agent
(defaulting to No); in a non-interactive run the agent is left `daemonWake: false` unless
it is named by `--daemon-wake <ids>` or `--daemon-wake-all` is passed. init MUST write the
resolved `daemonWake` value explicitly (true or false) on each wakeable agent's entry.

#### Scenario: Wakeable agent added without opting in
- **WHEN** a user selects a daemon-wakeable agent (e.g. kiro) and does not enable daemon waking for it
- **THEN** its `agents[]` entry is written with `daemonWake: false` — the key is present for `chorus mcp`, but the daemon will not wake it

#### Scenario: Wakeable agent opted in
- **WHEN** the operator answers Yes to the daemon-waking prompt for a selected agent (or names it in `--daemon-wake` / passes `--daemon-wake-all`)
- **THEN** its `agents[]` entry is written with `daemonWake: true`

#### Scenario: Offline agent gets no daemonWake field
- **WHEN** a selected agent maps to `offline` (opencode / openclaw / dormant dsh)
- **THEN** its `agents[]` entry carries no `daemonWake` field, since it can never be woken

#### Scenario: Non-interactive default is off
- **WHEN** `chorus agents add --agents kiro --yes` runs with neither `--daemon-wake kiro` nor `--daemon-wake-all`
- **THEN** the kiro entry is written `daemonWake: false` without prompting
