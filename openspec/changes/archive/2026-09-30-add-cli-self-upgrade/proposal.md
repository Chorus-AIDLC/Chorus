## Why

Chorus users currently need to update the globally installed CLI and each coding agent's Chorus plugin separately. One explicit command should update the CLI and optionally refresh the plugins referenced by the machine's daemon configuration.

This implements Idea `cf4f404b-8472-41fc-b919-122c99b12fd5`, using the human's seven elaboration answers and subsequent YOLO authorization.

## What Changes

- Add `chorus upgrade`, with `chorus update` as an identical alias. Default behavior upgrades only the current npm global installation to the registry's latest stable release.
- `--plugins` additionally updates configured Claude Code, Codex, Kiro and Pi Chorus plugins, including missing plugins when the host CLI is installed. It still runs when Chorus is already current.
- Deduplicate shared plugin installations. Explain skips for offline/unknown records and missing hosts. Do not install or update host CLIs.
- Confine plugin mutations to Chorus and required integration dependencies. If targeted Pi updating is not supported by a verified command, report that limitation instead of invoking its all-extension updater.
- Stop on CLI upgrade failure; continue across individual plugin failures, summarize outcomes, and return a nonzero status when the requested operation is incomplete.
- Print restart/new-session guidance; do not restart daemons or interrupt active sessions.

## Capabilities

### New Capabilities
- `cli-self-upgrade`: npm global self-upgrade, optional configured plugin refresh, predictable noninteractive outcomes.

### Modified Capabilities
None.

## Impact

CLI entry routing and help, new isolated upgrade modules, installer helpers only where needed, focused Node tests, and English/Chinese usage documentation. No backend API, database, daemon credential, agent registration, or daemon configuration migration.

Out of scope: self-upgrading pnpm/yarn/source/npx installations, prerelease/version selection, host CLI upgrades, offline type discovery, automatic restarts and rollback of completed updates.

## Acceptance

The command and alias must safely identify their own npm global installation, report the CLI result, and honor `--plugins` without unrelated installations/configuration changes. Tests must exercise installation provenance, current-version behavior, default isolation, subprocess failures, daemon config edge cases, scoped installer behavior and live entry-point help without real updates.
