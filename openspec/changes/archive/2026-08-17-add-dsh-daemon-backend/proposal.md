## Why

Chorus can register `dsh` as a daemon client type, but it cannot yet wake a DeepSeek Harness worker through the backend-neutral Spawner contract. The normal `dsh --profile headless` surface emits plain text and does not provide the event and usage wire needed by daemon transcript and turn reporting.

## What Changes

- Add a `DshSpawner` that drives an externally installed `dsh-jsonrpc-agent` over newline-delimited JSON-RPC stdio.
- Translate root-session committed user and assistant messages into dsh conversation frames and emit one normalized terminal usage frame per wake.
- Run one fresh dsh runtime and session per wake, expose the child for process-tree interruption, and close the runtime after the root session becomes idle.
- Add dsh backend selection, CLI help/menu support, executable probing, environment-only runtime configuration, and focused unit/backend integration coverage.
- Fail visibly when the external runtime or required runtime configuration is unavailable.
- **BREAKING** relative to the original Idea scope: v1 does not resume a dsh session between wakes or across daemon restarts and does not create `dsh-sessions.json`; durable work context is reconstructed from Chorus resources on each wake.

## Capabilities

### New Capabilities

- `daemon-dsh-backend`: External-runtime dsh spawning, JSON-RPC event normalization, terminal usage, interruption, selection, and diagnostics.

### Modified Capabilities

None.

## Impact

- Affects daemon CLI modules under `cli/`, their tests under `cli/__tests__/`, and the existing backend selection/install flow.
- Depends on the sibling `dsh` client-type registration change.
- Requires users to install `dsh-jsonrpc-agent` separately and provide its Cordis config through environment/configuration; Chorus does not bundle the runtime's native `node-pty` and `koffi` closure.
- Establishes the dsh event dialect consumed by the follow-up token-usage/transcript integration.
