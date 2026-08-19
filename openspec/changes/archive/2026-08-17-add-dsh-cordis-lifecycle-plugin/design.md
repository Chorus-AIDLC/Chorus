## Context

The dsh integration currently has two distinct execution planes. Chorus daemon wakes use the child-idea implementation in `cli/dsh-spawner.mjs` and the existing `waker -> turn-reporter -> REST turn-advance` path for committed messages, terminal turn state, and token usage. Separately, `install-dsh.sh` installs a home-wide MCP client that exposes server tools as `mcp__chorus__*` in interactive, web, and headless profiles.

Neither layer provides in-harness lifecycle behavior for an interactive dsh agent. The Pi extension demonstrates the desired user workflow, while deepseek-harness `hooks-claude-code` demonstrates the relevant Cordis events and disposal discipline. Important dsh constraints are:

- `agent/session-start` is an emit event and cannot block the first model step.
- `agent/pre-step`, `tools/post-execute`, and `agent/turn-stopping` are ordered interception points.
- `subagent/start` and `subagent/end` are observe-only lifecycle notifications.
- `ctx.effect` owns cleanup and plugin unload must reach quiescence.
- daemon and interactive sessions can share the same home patch, so origin detection must prevent duplicate Chorus activity.

The supported compatibility baseline is the clean deepseek-harness tag `dsh-v0.1.0-rc.7` at commit `99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`. Type checks, API-contract fixtures, effective composition, and real smoke behavior target that exact revision. A different checkout is unsupported until the same suite passes against it and the recorded baseline is deliberately advanced.

## Goals / Non-Goals

**Goals:**

- Automate check-in and workflow continuation for non-daemon dsh sessions.
- Guarantee first-step check-in context when Chorus responds within a configured bound.
- Match the Pi reviewer coverage without spawning a nested reviewer from inside a tool interceptor.
- Make daemon suppression, bounded memory, fail-open behavior, and unload cleanup directly testable.
- Deliver the plugin through the existing idempotent dsh installer.

**Non-Goals:**

- Report daemon turn state, transcript data, or token usage from the plugin.
- Add a new MCP turn-report API or call daemon REST routes directly.
- Create or close Chorus subagent sessions; parent-agent skills remain responsible for session bookkeeping.
- Enforce policy on non-Chorus tools or block normal dsh execution.
- Publish a standalone npm package or modify deepseek-harness upstream.

## Decisions

### Use a hard daemon-origin suppression boundary

`apply` determines whether the process is daemon-owned from one explicit environment signal. `Config.daemonOriginEnv` defaults to `CHORUS_DAEMON_HEADLESS`, must match the portable environment-name pattern `[A-Za-z_][A-Za-z0-9_]*`, and suppresses the plugin only when that variable's value is exactly `1`. The predicate is a small pure helper so deployments can select an equivalent explicit origin marker without changing event code. In daemon mode the plugin logs one local diagnostic and does not register check-in, tool, reviewer, or steering handlers.

This is stronger than allowing both paths and deduplicating server-side: the daemon already owns turn and usage identity, while the plugin has no stable idempotency key for the same turn. A no-handler daemon mode also prevents conflicts with the server's single-active-session guard.

### Execute check-in through the existing dsh tool registry

The plugin consumes `ctx.tools`; it does not hold Chorus URL or API-key configuration. On `agent/session-start`, it starts one `ctx.tools.execute` call for `mcp__chorus__chorus_checkin` and stores the promise in per-agent state. Synthetic call IDs use a plugin-owned prefix and are ignored by the plugin's own tool observer to prevent recursion.

The first `agent/pre-step` for that agent races the check-in against `Config.checkinTimeoutMs`, which defaults to 1500 ms and accepts integer values from 100 through 30000. A successful result becomes one plugin-sourced user message appended to the downstream `enter` decision. Timeout, missing tool, MCP failure, malformed content, or a downstream reject are fail-open: the model step proceeds and the failure is logged. Injection is at-most-once. A late successful response is retained only until it can be safely discarded; it does not inject stale context into a later unrelated turn.

Calling Chorus over direct HTTP was rejected because it would duplicate the MCP transport, credentials, and reconnect policy. Detached `agent.inject()` alone was rejected because it can miss the first turn.

### Keep one bounded state record per live agent

A `WeakMap<Agent, AgentState>` stores the check-in promise, first-step status, pending workflow nudge keys, and the abort controller for plugin-owned work. The pending set is bounded by `Config.maxPendingActions`, which defaults to 8 and accepts integer values from 1 through 64; duplicate keys collapse. A small detached-run tracker owns all asynchronous continuations so cleanup can abort work and await settlement.

`ctx.effect` installs the tracker disposer. Event subscriptions are registered from the plugin context and therefore share the same Cordis fiber lifetime. Disposal aborts in-flight calls, clears pending actions, and waits for tracked promises. Failures are reported but never prevent dsh shutdown.

An unbounded retry queue was rejected because Chorus outages could retain agent objects and grow memory. Immediate drop was rejected because short-lived tool/check-in races would lose useful workflow context.

### Observe only successful Chorus lifecycle tools

`tools/post-execute` normalizes only names beginning with `mcp__chorus__`. Plugin-owned synthetic calls are excluded. It records local metadata without persisting arguments or results, and it delegates to downstream listeners before adding any context.

Three successful backend operations create nudge keys:

- `chorus_pm_submit_proposal` -> proposal reviewer instruction.
- `chorus_submit_for_verify` -> task reviewer instruction.
- `chorus_admin_verify_task` -> conditional aggregate code-review instruction.

Tool errors and blocked downstream results do not enqueue actions. Non-Chorus tools are untouched. The exact result-shape predicate and normalized-name helper are pure functions covered by tests because dsh adapters may expose names with one server prefix.

### Deliver reviewer and continuation work through parent steering

At `agent/turn-stopping`, the plugin drains the pending action set into one deterministic instruction message and calls `agent.steer()`. This forces another model step through dsh's existing stopping semantics and lets the parent invoke the blocking subagent tool, wait for the verdict, and close it according to the installed Chorus skill.

The aggregate-review instruction tells the parent to verify that the just-approved task was the final task of an idea-rooted proposal before spawning the code reviewer. The plugin does not claim that local tool output proves this condition.

Direct nested `ctx.tools.execute({ name: "subagent" })` from `tools/post-execute` was rejected because it creates re-entrant tool execution, bypasses the parent workflow, and cannot safely map reviewer lifecycle. Detached reviewer spawning was rejected because a verdict could arrive after the parent turn ended. `subagent/start/end` remain observe-only signals used for diagnostics and cleanup correlation, not a decision API.

### Install one self-contained built artifact through the existing managed region

`packages/chorus-dsh` contains TypeScript source, unit tests, and a build that emits a self-contained ESM runtime artifact. dsh/Cordis imports used only for typing remain type-only; any runtime schema helper is bundled so the installed file does not rely on Node resolving Chorus workspace dependencies.

`install-dsh.sh` copies the artifact to `$DSH_HOME/chorus/chorus-dsh.mjs` with owner-only permissions and inserts its absolute path as a second installer-owned row in the existing managed patch region. The installer extends its temp-file, backup, rollback, and malformed-marker handling to the plugin artifact. Effective-config validation must contain both the MCP client and lifecycle plugin rows before success is reported.

A separate npm publication was rejected because this is Chorus-owned release content and would add version skew. Upstream placement was rejected because the behavior is Chorus-specific.

### Verify behavior at three layers

Package tests use a fake Cordis context, tool registry, and agent to cover daemon no-op behavior, bounded first-step check-in, failure/timeout fallbacks, configuration defaults and validation, tool-name normalization, success-only nudge creation, deduplication, one-message turn stopping, and disposal. Contract-facing tests compile and run against deepseek-harness `dsh-v0.1.0-rc.7` at commit `99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`.

Installer tests cover first install, rerun, replacement, rollback, permissions, and exactly one managed lifecycle row. A real dsh smoke test loads the installed home patch against the supported checkout, asserts the plugin is present in the effective composition, and exercises representative events with a local fake Chorus tool.

## Risks / Trade-offs

- **The installed dsh event or tool contracts may drift.** -> Pin contract and smoke tests to `dsh-v0.1.0-rc.7` / `99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`, require an explicit baseline update for newer revisions, and fail installer composition validation visibly.
- **The MCP tool may not be synchronized at session start.** -> Use a bounded fail-open gate and a clear warning; rely on the existing MCP reconnect behavior rather than adding another transport.
- **A steer message could be duplicated by repeated tool results.** -> Normalize action keys in a bounded set and drain once at the stopping boundary.
- **Daemon detection based only on an environment variable can be omitted by a future launcher.** -> Centralize the predicate, test the daemon spawner environment, and document the origin signal as a cross-module contract.
- **Bundled runtime dependencies increase artifact size.** -> Bundle only the small schema/runtime surface and verify the emitted artifact in installer smoke tests.

## Migration Plan

1. Add and test `packages/chorus-dsh` without enabling it in user profiles.
2. Build the runtime artifact as part of release preparation.
3. Extend `install-dsh.sh` and its isolated tests to manage the artifact and patch row atomically.
4. Run the real dsh composition/event smoke test on the supported checkout.
5. Ship the updated installer; existing users opt in by rerunning it.
6. Roll back by rerunning an older installer or removing the installer-owned managed region and `$DSH_HOME/chorus/chorus-dsh.mjs`; unrelated dsh configuration remains untouched.

## Open Questions

None for this change. A stable MCP turn-report API with server idempotency remains an explicit follow-up and is not a prerequisite.
