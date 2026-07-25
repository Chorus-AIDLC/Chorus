## Context

Codex generates its own thread identifier. `CodexSpawner` therefore maps the deterministic Chorus anchor to the `thread_id` emitted by `thread.started`, then uses that map to build later `codex exec resume <thread_id>` commands.

The current implementation holds the observed identifier in memory and writes the map only from the child `close` handler when `code === 0`. Chorus UI interrupt sends SIGINT to the detached process group and Codex exits with code 1. A fresh turn interrupted after `thread.started` consequently leaves a valid rollout on disk but no daemon mapping. The next wake treats the anchor as new and loses conversation continuity.

The Waker also computes and logs new/resume using the Claude transcript probe before invoking the backend. Codex ignores that input and makes its own map-based decision, so the current lifecycle line can contradict the command actually spawned.

## Goals / Non-Goals

**Goals:**

- Preserve the Codex thread identity as soon as the stream establishes it.
- Resume the same thread after an interrupted first turn and across daemon restart.
- Preserve best-effort persistence and no-throw wake behavior.
- Report Codex new/resume state from the decision that built the actual command.
- Add deterministic regression coverage without invoking a real model.

**Non-Goals:**

- Changing interrupt authorization, control transport, process-tree killing, or server execution state.
- Introducing automatic fallback to a new thread when a recorded resume fails.
- Changing the session-map file format or migrating existing entries.
- Generalizing Kiro or Claude session handling.

## Decisions

### Persist on first valid identifier

For a fresh Codex run with a non-empty anchor, the stdout event handler will call the injected mapping writer when it observes the first valid thread identifier. A local guard will ensure duplicate `thread.started` or compatible `session_meta` events result in exactly one persistence call for that wake.

This point is authoritative because Codex has emitted the generated identifier and created its rollout before a user can interrupt the process. Waiting for `turn.completed` or exit code 0 conflates successful turn completion with successful session creation.

Alternative considered: persist from the child `close` handler for every exit code. This still leaves a crash window between identifier observation and close processing and makes identity durability depend on process teardown.

### Do not write without an observed identifier

Spawn errors, stdin failures, or exits before an identifier event will not create a mapping. The daemon must not map an anchor to the Chorus UUID or infer a Codex thread identifier from unrelated output.

### Keep the session-map contract unchanged

The existing atomic temp-file rename, preservation of unrelated anchors, visible warnings, and swallowed persistence errors remain unchanged. Immediate persistence uses the same injected `setThreadIdFn`; no new storage layer is introduced.

### Surface the backend's actual decision

The spawner result already returns `isNew`, which for Codex is derived from its persisted map. Waker lifecycle logging will avoid presenting its pre-spawn Claude probe as authoritative for Codex. The implementation may log a backend-neutral dispatch line before spawn and the actual new/resume result after the spawner resolves, or expose a synchronous backend decision through the existing spawner boundary. It must not add agent-type branching to orchestration behavior.

The spawner exposes session-decision metadata through the shared boundary. Claude marks the transcript probe authoritative and supplies its `claude --resume` takeover command, preserving the existing new/resume lifecycle contract. Codex marks the probe non-authoritative, so Waker emits a neutral pre-spawn dispatch line and logs the map-based `result.isNew` decision after completion. Missing metadata retains the established Claude-compatible behavior for injected or third-party spawners.

## Module Contracts

- `CodexSpawner.wake()` owns Codex new/resume selection from `getThreadIdFn(anchor)`.
- Spawners expose whether the shared transcript probe is authoritative through backend capability metadata; Waker does not branch on agent type.
- Claude's existing `spawning new` / `resuming session` and `claude --resume <id>` takeover logging contract remains unchanged.
- A fresh run persists exactly once after the first valid generated thread ID is observed.
- `wake()` resolves `{ sessionId, exitCode, isNew }`, where `isNew` is the decision used to build argv.
- Mapping persistence failures are logged by the session-map implementation and never reject the wake.
- Waker must not claim a backend-specific new/resume state that differs from `result.isNew`.

## Risks / Trade-offs

- **Risk: An identifier is persisted before Codex has fully flushed its rollout.** Mitigation: `thread.started` is Codex's session establishment event; regression tests cover resume command selection, and no fallback hides a genuine resume failure.
- **Risk: Duplicate identifier events cause unnecessary disk writes.** Mitigation: guard the first successful observation and assert exactly one persistence call per fresh wake.
- **Risk: Moving Codex lifecycle detail later reduces pre-spawn operator information.** Mitigation: retain the anchor in a neutral dispatch line, then log actual backend state from the result; Claude keeps its existing pre-spawn takeover hint.
- **Risk: Existing stale mappings remain stale.** Mitigation: this change is forward-fixing and does not alter the deliberate no-silent-fallback policy.

## Migration Plan

No data migration is required. Deploy the daemon code and restart running daemons to pick it up. Existing valid mappings continue to work unchanged. Rollback restores the previous persistence timing but does not invalidate mappings written by the new version.

## Open Questions

None.
