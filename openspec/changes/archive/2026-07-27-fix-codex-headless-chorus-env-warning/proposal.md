## Why

Codex headless sessions spawned by the Chorus daemon can use Chorus MCP successfully while the SessionStart hook reports that Chorus is not configured. The daemon currently injects the resolved API key but not the resolved Chorus URL into the Codex child environment, so the hook's environment check disagrees with the MCP connection configured in `config.toml`.

## What Changes

- Propagate the daemon's resolved Chorus URL and API key into each Codex headless child process while keeping secrets out of process arguments.
- Make the Codex SessionStart diagnostic reflect the daemon-provided connection context, so a usable Chorus session does not emit a false configuration warning.
- Ensure the same Chorus configuration warning is emitted at most once per headless startup.
- Preserve the existing generic warning when Chorus is genuinely not configured or unavailable.
- Add regression coverage for configured, unconfigured, connection-failure, and duplicate-trigger startup paths.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `daemon-codex-backend`: Extend the spawned Codex environment contract and its startup-diagnostic behavior for Chorus connectivity.

## Impact

The change affects `cli/codex-spawner.mjs`, the Codex SessionStart hook under `plugins/chorus/hooks/`, and their focused tests. It does not change MCP configuration format, credential resolution precedence, public APIs, or non-Codex daemon backends.
