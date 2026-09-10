## Why

Operators need per-agent CLI customization (including model and reasoning choices) without maintaining separate daemon and foreground launch settings. PR #550 was closed without merging; its request for unified ENV/params is background evidence, not a compatibility dependency.

## What Changes

- Add optional per-agent `args: string[]` and `env: Record<string,string>` in daemon.json. No shared top-level defaults in multi-agent configurations.
- Share validation and child-environment composition between daemon wakes and `chorus agents run`.
- Deliver configuration to Claude Code, Codex, Kiro, Pi and dsh daemon backends and all supported foreground launch types. Offline stays non-wakeable.
- Protect protocol/session/identity controls while retaining arbitrary non-protocol CLI extensions. Explicit foreground options supersede recognizable configured options.
- Fail before spawning on malformed or protected configuration, without printing values. Preserve existing behavior when configuration is absent.
- Document literal values, restart semantics, supported override forms, and examples.

## Capabilities

### New Capabilities
- `agent-cli-config`: Per-agent extra argv and environment, validation, isolation and launch-surface parity.

### Modified Capabilities
- None. Existing unconfigured launch behavior and explicit passthrough remain unchanged; the new capability specifies additional behavior when configuration is present.

## Impact

CLI-only change: daemon-config, credentials launch selection, daemon runtime/spawner selection, five backend spawners, foreground launcher, tests and DAEMON documentation. No database, web UI, new dependencies or plugin runtime changes. No design.pen screen change is applicable because no frontend screen/component is modified.

Reference: https://github.com/Chorus-AIDLC/Chorus/pull/550#issuecomment-5619287931
