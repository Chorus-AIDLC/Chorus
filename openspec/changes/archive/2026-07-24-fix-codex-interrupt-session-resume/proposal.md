## Why

Chorus UI interrupt stops a fresh Codex turn with a non-zero exit after Codex has already created and reported its thread. The daemon currently persists the anchor-to-thread mapping only after exit code 0, so the next wake cannot reliably resume the interrupted conversation.

## What Changes

- Persist a fresh Codex thread mapping as soon as the first valid thread identifier is observed.
- Keep mapping persistence exactly-once per fresh wake, atomic, best-effort, and independent of the child process exit code.
- Ensure a wake after interrupt resumes the captured thread instead of silently starting a new conversation.
- Make Codex new/resume lifecycle logging reflect the backend's actual map-based decision.
- Add focused unit and daemon integration regression coverage for interrupted first turns and repeated interrupts of already-known threads.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `daemon-codex-backend`: Strengthen Codex session anchoring so a thread captured before an interrupted exit remains resumable, and require accurate map-based lifecycle observability.

## Impact

- Affected modules: `cli/codex-spawner.mjs`, `cli/waker.mjs`, and their focused tests.
- Persisted format: unchanged `~/.chorus/codex-sessions.json` anchor-to-thread map.
- APIs, database schema, dependencies, and UI contracts: unchanged.
