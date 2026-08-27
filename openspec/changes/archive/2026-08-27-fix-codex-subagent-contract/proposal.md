## Why

The Codex plugin still teaches an obsolete `spawn_agent(agent_type=...)` contract that the current tool schema rejects. Because these examples appear in skills, hook-injected guidance, reviewer metadata, and the plugin README, agents can fail before work or review begins and can leak subagent thread slots through incomplete lifecycle handling.

## What Changes

- Replace every Codex plugin `spawn_agent` example with the current object-shaped contract using `items` for mounted skills and text assignments, or `message` for self-contained work.
- Mount reviewer skills and `chorus:develop` explicitly instead of relying on unsupported roles or implicit skill loading.
- Explain that `fork_context` is opt-in for children that genuinely need the parent's conversation state, and should otherwise remain disabled to keep assignments focused.
- Standardize lifecycle guidance for `wait_agent`, `send_input`, `close_agent`, and `resume_agent`.
- Preserve the boundary between Codex execution orchestration and Chorus MCP task/status/evidence management.
- Add a static contract test that rejects obsolete `agent_type` usage and verifies required worker/reviewer/lifecycle guidance.
- Preserve the current unpublished Codex plugin version consistently and verify a generated/installed plugin copy in addition to repository sources.

## Capabilities

### New Capabilities

- `codex-subagent-orchestration`: Defines the supported Codex subagent spawning, skill-mounting, lifecycle, and regression-test contract for the Chorus plugin.

### Modified Capabilities

None.

## Impact

Affected sources are under `plugins/chorus/`: stage and reviewer skills, reviewer/session hook messages, README guidance, tests, plugin manifest, and MCP helper client version. No Chorus MCP API, database, non-Codex plugin port, or runtime application behavior changes.
