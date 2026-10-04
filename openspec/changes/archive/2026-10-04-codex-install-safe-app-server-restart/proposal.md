## Why

Writing Codex credentials does not refresh an already-running local App Server. Restarting only the terminal client can leave the old process environment active. The human approved an explicit-consent restart flow and deferred all new verification functionality in elaboration for Idea dd83f861-7dbb-4cdf-b5c5-fdba755be3b4; the subsequent YOLO request authorizes implementation.

## What Changes

- Add a Codex-only post-configuration step to `chorus agents add` (including its `init` alias), after successful credential persistence and plugin configuration.
- Detect supported daemon restart capability and running state using bounded, read-only commands. Offer an explicit default-no confirmation explaining interruption of other sessions.
- Restart only with the newly persisted Chorus environment and the resolved CODEX_HOME. Never put credentials in argv or logs.
- In noninteractive, headless, or `--yes` runs, do not prompt or restart; provide deferred/manual instructions. Never start an absent daemon or upgrade Codex automatically.
- Report success of the restart command, failure, unsupported/unknown status, or deferral without claiming that MCP connectivity is verified. Preserve existing install checks; add no new authentication, MCP, or model-turn probes.
- Update English and Chinese installation/troubleshooting instructions.

## Capabilities

### New Capabilities
- `codex-install-restart`: safe optional local Codex App Server restart following configuration.

## Impact

CLI installer orchestration, one injectable Codex restart step, tests, and Codex connection documentation. No database/API changes, gateway changes, other agent behavior changes, releases, push, or merge. Plugin-only refreshes do not restart automatically because they do not persist new credentials.
