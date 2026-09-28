## Why

Chorus 0.20.0 will move Codex daemon execution from `codex exec/resume --json` to the bidirectional App Server interface, following Multica's integration. The human verified Idea `5e62d13f-91e2-4a2f-892f-dc3e93c918fd` on 2026-09-28: all six answers select a behavior-preserving backend replacement.

App Server exposes explicit thread and turn lifecycles; adopting it requires adapting process completion, resume, cancellation and stream reporting together. It is not sufficient to replace command arguments. Protocol evidence: [official documentation](ref:6ac8fd28-33e5-4833-a3de-8a23294beeb5). Reference lifecycle implementation: [Multica](ref:8a5bddb5-af64-4027-97c1-80e8f780e0db).

## What Changes

- **BREAKING:** Codex daemon wakes use `codex app-server --listen stdio://` exclusively. There is no exec fallback or backend selection switch. Unsupported CLI versions/options produce actionable failures.
- Run one App Server child per wake, initialize the connection, start/resume the mapped thread, submit one turn, collect its outcome, then clean up the child.
- Preserve Chorus session anchors and existing thread mappings. Resume first; only a definitive unrecoverable-history error permits one fresh thread with the existing Chorus context and a visible continuity warning.
- Preserve cwd, per-agent configuration and credentials, permission modes, MCP and plugin context, transcript delivery, operation/turn status and token accounting.
- Use bounded protocol cancellation before process-tree escalation, with existing interrupt authorization, queueing and resume behavior.
- Respond to unexpected native approval/input requests without terminal interaction; report the outcome using existing diagnostics. Human decisions continue through Chorus comments/elaboration.
- Keep existing scheduling. No `turn/steer`, new-message preemption, interaction bridge UI, process pool, remote listener, authentication redesign or database/API migration.

## Capabilities

### New Capabilities

None; this replaces the existing Codex backend.

### Modified Capabilities

- `daemon-codex-backend`: App Server startup, session continuity, permissions, failure handling and cancellation.
- `daemon-spawner-interface`: optional process-associated protocol stop capability and separation of raw process settlement from protocol outcome classification, retaining backend-neutral callers.
- `daemon-interrupt-resume`: bounded protocol-first graceful stop for capable children, with existing signal fallback.
- `daemon-token-usage`: Codex App Server cumulative usage normalized once to the existing terminal event and shared usage shape.
- `agent-cli-config`: protect App Server transport controls and translate supported Codex model/config options without changing foreground launch behavior.

## Impact

Primary modules: `cli/codex-spawner.mjs`, new local RPC/event adapters, `cli/codex-session-map.mjs`, `cli/codex-usage-map.mjs`, `cli/agent-cli-config.mjs`, `cli/process-killer.mjs`, and compatibility with `cli/waker.mjs`, `cli/control-handler.mjs`, `cli/upload-hooks.mjs` and `cli/child-exit.mjs`. Update `docs/DAEMON.md` and relevant CLI tests. The existing [spawner baseline](ref:9497725e-ebd9-44f6-811c-0be7b7ca9b49) defines preserved responsibilities.

Use Node built-ins and existing dependencies. Support the project's Linux, macOS and Windows targets. The proposal adds no UI or server persistence surface.

Acceptance requires new/resumed/legacy sessions, unavailable-history recovery, interrupted first-turn recovery, no false success on early process exit, deduplicated transcripts and per-turn usage, credential/permission parity, bounded cleanup, protected argv, and integrated daemon regressions. The target CLI version and real old-exec history compatibility are engineering verification gates in tasks 1 and 4, not facts established by the earlier research.
