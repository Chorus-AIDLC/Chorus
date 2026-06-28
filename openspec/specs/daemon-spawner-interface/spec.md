# daemon-spawner-interface Specification

## Purpose
TBD - created by archiving change add-daemon-codex-backend. Update Purpose after archive.
## Requirements
### Requirement: Backend-agnostic spawner interface and selection

The daemon SHALL define a backend-agnostic spawner contract `wake({ prompt, sessionId, isNew, mcpConfigPath, cwd, onMessage, onChild }) → { sessionId, exitCode, isNew }` that both the Claude Code and Codex backends implement, and SHALL select which spawner instance to inject based on the agent type resolved from `--agent` / `CHORUS_AGENT`. The wake pipeline above the spawner (wake-queue, waker, directed delivery, headless guard, turn/transcript lifecycle reporters) SHALL remain backend-agnostic and SHALL NOT branch on the agent type. A spawner SHALL NOT throw into the wake path: any failure to resolve the executable, spawn, or write the prompt SHALL resolve with `exitCode: null` and a visible log line, so one failed wake never crashes the daemon. The spawner SHALL invoke `onChild` exactly once, synchronously, only on a successful spawn, before the wake promise resolves.

#### Scenario: Default selection injects the Claude backend unchanged

- **WHEN** the resolved agent type is `claude-code`
- **THEN** the daemon injects the Claude spawner and its spawn argv and behavior are byte-for-byte the same as before this change

#### Scenario: codex selection injects the Codex backend

- **WHEN** the resolved agent type is `codex`
- **THEN** the daemon injects the Codex spawner, and the waker drives it through the same `wake(...)` contract without any agent-type-specific branching in the waker

#### Scenario: A spawn failure does not crash the daemon

- **WHEN** a spawner cannot locate its backend executable or the spawn fails
- **THEN** the wake resolves with `exitCode: null` and a visible error log, and the daemon continues serving subsequent notifications

