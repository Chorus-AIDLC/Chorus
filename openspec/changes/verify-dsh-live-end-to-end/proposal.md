## Why

The dsh integration is covered by deterministic unit and composed integration tests, but it has not yet been accepted as one live system using a real `dsh-jsonrpc-agent`, a real DeepSeek credential, Chorus workflow resources, daemon restart, and UI-driven interruption. This milestone closes that gap with auditable, redacted evidence before the integration is treated as complete.

## What Changes

- Run `chorus daemon --agent dsh` against an owner-provided environment containing the external dsh runtime, Cordis configuration, Chorus credentials, and DeepSeek provider credential.
- Create an isolated acceptance-only Idea and drive it through a real Idea -> Proposal -> Task workflow with dsh, including MCP and installed skill loading.
- Verify a normal wake produces the `dsh` client label, committed transcript, terminal per-wake usage, and correct Idea/session attribution in Chorus.
- Restart the daemon and verify a new dsh runtime/session continues the same workflow from the wake prompt and persisted Chorus resources. This is Chorus resource-context continuity, not native dsh session resume.
- Interrupt a controlled, side-effect-free long turn and verify the Chorus turn is interrupted, the runtime process group exits, and no transcript or usage arrives after the terminal interrupt boundary.
- Publish a redacted acceptance report with commands, environment categories, resource identifiers, logs or UI/API evidence, usage, and a pass/fail result for every acceptance path.
- Keep reusable automation as supporting evidence; the report and referenced Chorus records remain the primary evidence.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `daemon-dsh-backend`: Add a live end-to-end acceptance contract for wake, Chorus-resource continuity after daemon restart, transcript and usage attribution, and process-group interruption.

## Impact

- Exercises the existing `cli/dsh-spawner.mjs`, daemon connection and control paths, transcript upload hooks, turn reporting, dsh installer output, and installed Chorus skills without changing their production contracts.
- Adds a redacted report under `docs/acceptance/` and may add a small non-secret repeatability helper if it materially reduces manual setup.
- Requires a human owner to start the daemon from a terminal whose environment already contains the required secrets and dsh configuration.
- Adds no API, schema, dependency, or native dsh session-persistence behavior.
