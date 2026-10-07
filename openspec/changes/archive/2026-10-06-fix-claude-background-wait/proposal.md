# Prevent silent termination of Claude background agents

## Why

Daemon-woken Claude sessions can end their main turn while workers or reviewers are still running. Claude then waits only 600 seconds before terminating those agents while returning exit code zero, leaving apparently successful wakes and unfinished work.

## What Changes

- Default Claude's post-turn background wait ceiling to 3600000ms, with operator overrides and native-variable precedence.
- Keep the main agent responsible for collecting background completions before normal turn termination; document cancellation and human-decision handoffs.
- Detect Claude's explicit background-termination stderr diagnostic even across chunks, classify the wake as failed, and post one bounded explanatory comment on the triggering Idea/Task.
- Preserve stop/shutdown semantics and existing diagnostic redaction; add regression tests without waiting an actual hour.

## Capabilities

### New Capabilities
- `daemon-claude-background-agents`: background-agent lifetime configuration, ownership guidance, and visible abnormal termination for Claude daemon wakes.

### Modified Capabilities
None. Existing generic headless interaction and stream-json transport contracts remain intact; this adds Claude-specific background-agent handling.

## Impact

Touches Claude spawner, wake completion/reporting wiring, shared prompt wording scoped to Claude, Claude workflow skills and standalone mirrors, and CLI tests. No server schema, dependency, other backend runtime, whole-wake watchdog, automatic task state repair, retry, merge, or publication changes. After independent review including the requested Clay review, locally package/install the CLI and restart the daemon. Codex behavior is a separate follow-up Idea.
