## Why

The existing dsh integration connects Chorus MCP tools and gives daemon-driven sessions an authoritative turn and token pipeline, but interactive and embedded dsh sessions still lack in-harness lifecycle automation. A Cordis plugin can close that gap without duplicating daemon reporting by making the runtime boundary explicit.

## What Changes

- Add `packages/chorus-dsh`, a buildable TypeScript Cordis plugin that exports `name`, `inject`, `Config`, and `apply`.
- In non-daemon dsh sessions, run `chorus_checkin` at session start and inject its result once at the first agent step through a bounded, fail-open gate.
- Observe successful `mcp__chorus__*` lifecycle calls, queue reviewer and continuation actions, and deliver one deduplicated steering message at the turn-stopping boundary.
- Cover proposal review, task review, and conditional aggregate code review with the same parent-agent steering model used by the Pi integration.
- Disable lifecycle automation when a daemon-origin signal such as `CHORUS_DAEMON_HEADLESS=1` is present so the daemon remains the sole turn, usage, and orchestration authority.
- Extend `install-dsh.sh` to install the built plugin under `$DSH_HOME/chorus`, add one managed home-patch row, validate the effective composition, and roll back all managed files atomically on failure.
- Add unit, installer, and real dsh composition tests for event behavior, bounded cleanup, idempotent installation, and daemon suppression.

## Capabilities

### New Capabilities

- `dsh-chorus-lifecycle`: Interactive dsh lifecycle check-in, Chorus tool observation, workflow steering, daemon suppression, effect cleanup, and installer-managed delivery.

### Modified Capabilities

None.

## Impact

- New package: `packages/chorus-dsh/`.
- Updated public installer and installer tests under `public/`.
- Updated dsh home patch composition and installed files under `$DSH_HOME/chorus/`.
- Compatibility baseline: clean deepseek-harness tag `dsh-v0.1.0-rc.7`, commit `99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`.
- Consumes the existing `mcp__chorus__*` tool namespace; no new Chorus API, database schema, daemon turn contract, or upstream deepseek-harness change is introduced.
