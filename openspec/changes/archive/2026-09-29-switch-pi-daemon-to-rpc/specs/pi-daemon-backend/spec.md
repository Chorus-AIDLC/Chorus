## MODIFIED Requirements

### Requirement: pi spawner implements the wake contract
A new `cli/pi-spawner.mjs` SHALL export a `PiSpawner` implementing the shared `Spawner.wake({ prompt, sessionId, isNew, cwd, onMessage, onChild })` contract. It SHALL resolve the `pi` executable from PATH (honoring `CHORUS_PI_PATH`), run headless as `pi --mode rpc` with a client-owned session id (`--session-id <anchor>` for a new session, resume the same anchor on subsequent wakes), send the prompt over stdin as an RPC `prompt` command, parse the pi JSONL stream via the shared NDJSON parser and forward non-protocol events through `onMessage`, hand the live child to `onChild` (for the interrupt registry), and export the daemon's `CHORUS_URL` / `CHORUS_API_KEY` / `CHORUS_AGENT_PROFILE` and `CHORUS_DAEMON_HEADLESS=1` into the child env. It SHALL NOT pass any permission/sandbox flag (pi has no permission system, so `permissionMode` is a no-op). Missing `pi` on PATH SHALL log visibly and resolve with a no-crash failure result (`exitCode: null`), matching the other spawners.

#### Scenario: new session wake
- **WHEN** `PiSpawner.wake` is called for an anchor with no prior pi session
- **THEN** it spawns `pi --mode rpc --session-id <anchor> …`, sends the prompt as an RPC `prompt` command over stdin, and forwards parsed events to `onMessage`

#### Scenario: resume wake
- **WHEN** `PiSpawner.wake` is called for an anchor that already has a pi session
- **THEN** it resumes that session id rather than starting a fresh one

#### Scenario: pi executable missing
- **WHEN** no `pi` binary is found on PATH and `CHORUS_PI_PATH` is unset
- **THEN** it logs a visible error and resolves `{ exitCode: null }` without throwing
