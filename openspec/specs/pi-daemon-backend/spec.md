# pi-daemon-backend Specification

## Purpose
TBD - created by archiving change optimize-pi-plugin-npm-parity. Update Purpose after archive.
## Requirements
### Requirement: pi is a recognized wakeable daemon backend
The daemon SHALL recognize `pi` as a first-class agent backend. `KNOWN_AGENTS` in `cli/daemon-agent.mjs` SHALL include `pi`; `resolveAgentType` SHALL accept `--agent pi` / `CHORUS_AGENT=pi` / `daemon.json "agent": "pi"` without error. `backendCli("pi")` SHALL return the pi executable descriptor (`{ name: "pi", envVar: "CHORUS_PI_PATH" }`), and `backendClientType("pi")` SHALL return `"pi"`.

#### Scenario: --agent pi resolves
- **WHEN** the daemon starts with `--agent pi`
- **THEN** `resolveAgentType` returns `{ ok: true, agent: "pi" }` and the startup banner names the `pi` CLI

#### Scenario: unknown agent still errors
- **WHEN** `--agent bogus` is passed
- **THEN** resolution fails with a message listing the accepted types including `pi`

### Requirement: pi spawner implements the wake contract
A new `cli/pi-spawner.mjs` SHALL export a `PiSpawner` implementing the shared `Spawner.wake({ prompt, sessionId, isNew, cwd, onMessage, onChild })` contract. It SHALL resolve the `pi` executable from PATH (honoring `CHORUS_PI_PATH`), run headless as `pi --mode json -p` with a client-owned session id (`--session-id <anchor>` for a new session, resume the same anchor on subsequent wakes), write the prompt to stdin, parse the pi JSONL event stream via the shared NDJSON parser and forward events through `onMessage`, hand the live child to `onChild` (for the interrupt registry), and export the daemon's `CHORUS_URL` / `CHORUS_API_KEY` / `CHORUS_AGENT_PROFILE` and `CHORUS_DAEMON_HEADLESS=1` into the child env. It SHALL NOT pass any permission/sandbox flag (pi has no permission system, so `permissionMode` is a no-op). Missing `pi` on PATH SHALL log visibly and resolve with a no-crash failure result (`exitCode: null`), matching the other spawners.

#### Scenario: new session wake
- **WHEN** `PiSpawner.wake` is called for an anchor with no prior pi session
- **THEN** it spawns `pi --mode json -p --session-id <anchor> …`, feeds the prompt over stdin, and forwards parsed events to `onMessage`

#### Scenario: resume wake
- **WHEN** `PiSpawner.wake` is called for an anchor that already has a pi session
- **THEN** it resumes that session id rather than starting a fresh one

#### Scenario: pi executable missing
- **WHEN** no `pi` binary is found on PATH and `CHORUS_PI_PATH` is unset
- **THEN** it logs a visible error and resolves `{ exitCode: null }` without throwing

### Requirement: spawner selection returns the pi backend
`selectSpawner("pi", opts)` in `cli/spawner-select.mjs` SHALL return a `PiSpawner`, and `pi` SHALL NOT fall through to the `claude-code` default nor be treated as `offline`.

#### Scenario: pi selects PiSpawner
- **WHEN** `selectSpawner("pi", …)` runs
- **THEN** it returns a `PiSpawner` instance

### Requirement: server accepts the pi daemon client type
`DAEMON_CLIENT_TYPES` in `src/services/daemon-connection.service.ts` SHALL include `"pi"` so a pi daemon connection registers and appears in presence like the other wakeable backends. The `agent-type-map.mjs` selection mapping SHALL map `pi` → `pi` (no longer `offline`), so `chorus init` seeds a selected pi agent as wakeable.

#### Scenario: pi connection registers
- **WHEN** a daemon handshakes with `clientType=pi`
- **THEN** the connection is accepted (not rejected as an unknown client type) and materializes an instance

#### Scenario: init maps pi to a wakeable type
- **WHEN** `agentTypeForSelection("pi")` runs
- **THEN** it returns `"pi"` and `isWakeableAgentType("pi")` is true

