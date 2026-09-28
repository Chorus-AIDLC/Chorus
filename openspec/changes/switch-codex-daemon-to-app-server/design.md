## Context

The Idea is resolved by human verification; q1–q6 all select option a. This design reuses the initialization research and current repository inspection; no second broad research pass is needed. App Server documentation defines the JSONL RPC handshake and thread/turn lifecycle [official](ref:6ac8fd28-33e5-4833-a3de-8a23294beeb5). Multica demonstrates an execution-scoped stdio client, separate startup timeouts, classified resume fallback and process cleanup [reference](ref:8a5bddb5-af64-4027-97c1-80e8f780e0db). Neither source proves compatibility with every installed CLI.

Current `CodexSpawner.wake` owns map-based resume, injects the agent environment, emits exec-shaped events, normalizes cumulative usage and settles through `awaitChildSettled`. `Waker` captures the real child with `onChild`, manages authorized interrupt flags and reports terminal state. `control-handler` and daemon shutdown call `killProcessTree`. `upload-hooks` consumes `item.completed`/`agent_message` and `turn.completed` usage. Replacing this internal input format wholesale would unnecessarily affect other backends.

## Goals / Non-Goals

Goals: switch the Codex daemon transport, preserve observable behavior, make thread/turn outcome authoritative, preserve historical anchors and make all transport/cleanup paths bounded.

Non-goals: changing foreground `chorus agents run -- codex ...` semantics, expanding permissions, pooling App Server processes, adopting Multica's full workspace manager, introducing native interactive approval/input UI, steering an active turn, altering queue/coalescing behavior, or adding public REST/MCP schemas.

## Decisions

### 1. One stdio child per wake

Spawn `codex app-server --listen stdio://` through the existing executable/shim resolver and environment overlay. Keep POSIX detached process groups and Windows tree cleanup. Stdout is protocol data, stderr is bounded diagnostic data; prompt and API keys never appear in argv/logs. The selected agent's `CODEX_HOME`, model configuration and Chorus identity stay isolated as today.

Handshake: request `initialize`, await success, notify `initialized`, then start/resume a thread. Keep stdin open during the turn. Submit the existing headless-prefixed prompt as a text input to `turn/start`. Do not opt into experimental features unless a verified required field needs them; task 1 documents any such necessity.

A shared persistent server/pool is excluded because it changes ownership, credentials and crash isolation. Exec fallback conflicts with q3.

### 2. RPC client and bounded resource handling

Add `cli/codex-app-server-client.mjs` with monotonically unique request IDs, pending-response correlation, server-request handling and notifications, UTF-8 chunk-safe JSONL decoding, serialized writes/backpressure, and rejection of pending calls on EOF/error/close. A response to a server request echoes its original ID; notifications carry no ID. Unknown notifications are ignored; malformed protocol frames fail the wake with a bounded diagnostic.

Initial internal, injectable limits: initialize 30s; thread setup 60s; turn-start response 60s; semantic inactivity 10min; frame limit 32MiB; stderr tail 8KiB; normal stdin-close cleanup 10s. These are proposed defaults, not promised model latency. Requests/timers/listeners are released at settlement. Inactivity resets on relevant thread/turn progress, not arbitrary transport chatter. No total duration cap applies to a progressing turn. Never retry `turn/start` inside the client after an uncertain response. Bound buffering and stop on overflow instead of retaining unlimited model output.

RPC success does not mean turn success. Correlate all events with the selected thread and active turn; buffer only the bounded race between turn notification and turn-start response. Terminal events for other or historical turns cannot settle this wake.

### 3. Session continuity and fallback

Keep `codex-sessions.json` and the current anchor key semantics. `thread/resume` receives the saved backend ID and resolved current cwd/permission/config overrides. Capture authoritative thread IDs from setup responses/notifications and persist a newly established mapping once, before starting the turn. Never persist inferred IDs.

For a definitive unavailable/deleted/incompatible-history response verified against the supported schema, attempt `thread/start` once and persist its new ID. Do not treat generic JSON-RPC errors, authentication/config failures, timeouts, EOF or transport errors as history loss. Preserve the old mapping if fresh setup fails. Emit a bounded warning containing the old/new thread identifiers (not prompt or credentials) through logs and an assistant transcript notice: “Previous Codex history could not be restored; continuing in a new thread with Chorus context.” The original Chorus wake prompt is the available reconstruction context; no invented transcript is implied.

The result returns the Chorus anchor separately from `backendSessionId`; fresh fallback sets `isNew=true`. A captured ID survives interruption even on the first turn. An interruption before thread establishment leaves no invented mapping. Usage baselines are tied to the actual thread ID, so a fresh replacement never subtracts the old thread's totals.

### 4. Event and usage adapter

Add `cli/codex-app-server-events.mjs`, owned by the stream task. It produces the already-supported internal exec-shaped envelopes; this is an internal compatibility adapter, not another exec runtime.

| App Server observation | Internal consumer event |
| --- | --- |
| Established thread ID | `thread.started` with `thread_id` |
| Completed assistant message item | `item.completed` with `item.type="agent_message"`, stable item ID and text |
| Relevant token usage notification | Retain latest validated cumulative totals for this thread/turn |
| Completed/failed/interrupted turn | One terminal outcome; at most one `turn.completed` usage envelope |

Completed-item snapshots are authoritative for transcript text; do not forward both deltas and snapshots as duplicate assistant messages. Commentary and final assistant items each retain their identity. Tools/reasoning/raw server request payloads do not become conversation messages. Deliver the continuity notice once as a synthetic assistant item with a distinct stable ID.

Use App Server thread cumulative totals minus a trusted baseline, then the existing exclusive-input/cache normalization. Never sum notification snapshots or treat the last model request's usage as a whole tool-using turn. Prefer a verified pre-turn total from resume/setup when available; otherwise use the existing same-thread persisted baseline. With no trustworthy baseline on an existing thread, seed the new total and omit this turn's usage as today. Fresh threads start from zero. Persist valid totals even after an interrupted turn so later resumed turns do not re-count them; report only data actually observed before terminal cleanup. Handle regressing counters conservatively: omit affected usage and re-seed instead of billing history. Missing fields stay null; reasoning output is not added to output again; retain `source="codex"` and existing model-null behavior.

No server/UI changes are needed. The adapter invokes existing normalization once; `upload-hooks` must not subtract the baseline a second time.

### 5. Permissions, configuration and headless requests

Express the resolved daemon policy in thread/turn configuration for both new and resumed threads: yolo maps to full-access sandbox plus noninteractive approval policy; chorus maps to read-only sandbox plus noninteractive approval policy. Use the actual supported field names/schema established in task 1. An existing thread's stored policy must not override the daemon's current resolved posture. Read-only is the CLI's read-only sandbox semantics, not a claim that all read-only shell commands are forbidden.

Continue loading MCP/skills from the selected user's Codex configuration, preserving `CHORUS_URL`, `CHORUS_API_KEY`, `CHORUS_AGENT_PROFILE` and `CHORUS_DAEMON_HEADLESS=1`. Missing Chorus MCP configuration remains warning-and-run. Preserve successful check-in and existing generic missing/failed configuration warnings without duplicates. Task 4 verifies actual App Server hook execution; if hooks differ, provide equivalent existing startup context/check-in in the Codex adapter without a second check-in or a new configuration format.

Extend `agent-cli-config` protection/arity to daemon-owned App Server transport options, including `--listen` and alternate code-mode host selection. Preserve literal `-c/--config` overrides for permitted settings. Translate existing supported model flags to equivalent App Server config/RPC parameters because App Server subcommand flags differ from exec; apply model and reasoning overrides on resume as well. Reject unsupported exec-only options clearly, without printing values. Do not silently discard options. Keep foreground parsing and other backends' option semantics intact.

Known server approval/input requests receive a schema-valid negative/cancel response and a visible diagnostic; never accept a command/file approval just because no human is attached. If no safe response exists in the supported schema, fail/interrupt the wake and clean up. Unknown server requests receive a method-not-supported error; those that prevent progress fail the turn. Errors must not loop indefinitely or wait for terminal input. Human decision prompts stay in Chorus.

### 6. Protocol-aware cancellation without backend branches

Add a small process-associated stop-hook registry (WeakMap keyed by the actual ChildProcess) used by `process-killer`. Codex registers a hook before invoking `onChild`; the shared killer detects capabilities, not agent type. The registry is never serialized in execution snapshots and entries are disposed after cleanup. Existing callers and `onChild(child)` signatures stay unchanged.

For a child with a hook, the same existing configurable graceful-stop deadline covers `turn/interrupt`, waiting for the matching turn-completed event and closing stdin/awaiting exit. If cancellation happens before an active turn exists, close/stop startup immediately and prevent a later `turn/start`. Any hang, rejection or remaining process at the deadline falls back to process-tree termination; do not add another full graceful window. For children without a hook, preserve SIGINT → timed tree-kill behavior exactly.

User interrupt authorization and interrupting flags remain owned by control-handler/Waker; daemon shutdown retains its existing reason suppression. A normal `turn/completed` triggers stream flush, stdin close and bounded cleanup without being reported as a user interrupt. Keep a process-group cleanup path for descendants that survive the leader, including inherited-pipe cases; an exit notification is not proof the tree is gone.

### 7. Module Contracts and failure outcomes

- `CodexSpawner.wake(params)` keeps existing parameters and returns `{sessionId, backendSessionId, exitCode, isNew}`. `onChild` fires exactly once only after successful child creation; pre-spawn failure never advances a turn to running.
- The RPC client exposes request/notify/respond/subscription and idempotent close primitives, throws only typed internal errors, and never invokes Chorus APIs.
- The event adapter accepts raw decoded messages and emits normalized events plus a terminal outcome. It owns per-item deduplication and thread/turn filtering; persistence remains in the spawner.
- The spawner contains internal exceptions and settles once after bounded cleanup. `exitCode=0` requires a matching completed-success turn and successful cleanup. Failed/interrupted protocol turns or missing terminal events cannot become success when the process exits 0. Pre-spawn/I/O/protocol failures use `exitCode=null` with visible diagnostics; protocol terminal failure uses a nonzero synthetic code. Waker uses its existing user/shutdown flags to classify intentional interruption.
- The process-stop registry accepts an async stop hook with a deadline; the killer owns the deadline and signal escalation. Hooks cannot suppress forced cleanup by never resolving.
- Do not expand this work into automatic crash-redelivery policy changes. Within one wake, send `turn/start` once; existing Waker retry policy remains. Record the residual uncertainty of side effects before a crash.

## Risks / Trade-offs

- **CLI drift** → task 1 generates/inspects the installed CLI schema, captures sanitized protocol fixtures and records the minimum version actually tested. Unsupported protocol/configuration fails visibly; no guessed version claim.
- **History loss** → definitive-error allowlist, one fresh fallback, visible transcript notice, persist IDs early.
- **False success / duplicate work** → terminal state drives outcome, no local turn-start retry; preserve existing global crash semantics explicitly.
- **Double token counts** → same-thread baseline, snapshot replacement, one normalization and null on unknown/regressing totals.
- **Cleanup races** → hook installed before exposure, cancellation latch during startup, matching IDs, deadline and tree cleanup, process exit drained through shared `awaitChildSettled`.
- **Scope drift** → no UI bridge or pooling; integration can adjust hooks/config translation to preserve existing behavior, not add unrelated plugin features.

## Migration Plan

1. Implement and test RPC/CLI contract, then spawner/session/stop integration and event adaptation.
2. Converge in an integrated daemon checkpoint with real target CLI and fixtures from old exec history. Record CLI version, OS and protocol/hook evidence.
3. Update `docs/DAEMON.md` for the new daemon backend, supported version, old option remediation, resume warning and failure handling; preserve documentation for legitimate foreground exec use.
4. Ship through the normal approved release workflow. Do not create a runtime fallback switch or delete existing session files. Operational rollback is reinstalling the preceding Chorus package, not automatic runtime exec selection; do not promise downgrades can read histories produced by newer Codex.

## Open Questions

No remaining product decisions. Engineering gates: exact supported protocol/version, legacy exec-thread compatibility, model/config translation, hook behavior and OS coverage. Task 1 resolves API shapes before dependent implementation; task 4 records real integration evidence. Any platform that cannot be exercised must be reported explicitly with equivalent contract tests and an outstanding live-check requirement, not labeled passed.

## Task DAG

T1 RPC client/CLI contract → T2 lifecycle/session/cancellation and T3 transcript/usage adapter → T4 integrated verification/documentation. T2 and T3 share the contracts above and may proceed in parallel after T1. T4 requires both, including real execution of the combined path. Chorus task drafts own task state; local `tasks.md` maps to those drafts.
