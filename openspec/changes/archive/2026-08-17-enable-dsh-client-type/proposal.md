## Why

Chorus currently rejects daemon connections that report `clientType=dsh`, and its CLI and presence UI do not recognize DeepSeek Harness as a supported backend. Registering the type is the small prerequisite that lets later dsh integration work connect to the server and appear in connection and session surfaces.

## What Changes

- Accept `dsh` as a daemon client type at the server connection gate.
- Recognize `dsh` as a CLI daemon backend and map it to the `dsh` executable, `CHORUS_DSH_PATH`, and the `dsh` self-reported client type.
- Render a localized `dsh` label in agent presence, connection, and session surfaces.
- Add focused unit coverage for the server allowlist and CLI backend mappings.
- Keep the existing string and JSON persistence model unchanged; no database migration is introduced.

## Capabilities

### New Capabilities

- `dsh-client-type`: Defines server acceptance, CLI backend metadata, and localized UI presentation for the DeepSeek Harness client type.

### Modified Capabilities

None.

## Impact

The change affects `src/services/daemon-connection.service.ts`, `cli/daemon-agent.mjs`, their focused unit tests, `src/components/agent-presence/hooks.ts`, and the `agentConnections.clientDsh` key in all four locale files. It adds no dependency, endpoint, schema, or migration.
