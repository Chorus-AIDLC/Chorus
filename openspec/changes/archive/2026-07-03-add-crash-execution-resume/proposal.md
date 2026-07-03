# Proposal: One-click Resume for crash-exited daemon executions

## Why

The daemon chat window (left conversation list / right transcript) offers an **Interrupt** button on a running execution, and a **Resume** button after a *user-requested* interrupt. But when an execution **crashes** (the headless subprocess exits non-zero, is killed, or dies unexpectedly — `DaemonExecution.status = "interrupted"`, `interruptedReason = "crash"`), the UI shows only a static "Auto-recovers" hint and no action.

That hint is misleading in the common case: reconnect-backfill re-fires missed wakes only when the **daemon reconnects**. When the subprocess crashes while the daemon stays online, nothing re-fires. The user is left manually typing a new instruction like "continue what you were doing", and hoping the new turn lands on the right session.

Elaboration (Round 1, verified 2026-07-03) settled the scope:

- **q1=a** — cover only subprocess error exits (`interruptedReason = "crash"`). Daemon-offline interruptions and "interrupted but never continued" sessions are out of scope.
- **q4** — no new detection/storage: the crash state already exists (daemon reports via `POST /api/daemon/report-interrupt`; the row is sticky across reconcile).
- **q5/q3** — button placement and delivery mirror the existing post-interrupt Resume exactly: same composer action-row position, same origin-connection targeting, same offline-refusal behavior.
- **q2=a** — resuming a crash injects a **fixed, server/daemon-generated continue instruction** ("the previous run exited abnormally — check state and continue unfinished work"), resuming the original session context; no user input required.
- **q6=a** — the resumed run continues in the **same conversation**: the transcript shows crash → resume → continuation in one stream.
- **q7=b** — both daemon backends: Claude Code (`claude --resume`) and codex (thread_id resume).

## What Changes

1. **Server**: `POST /api/daemon/resume` and `resumeExecution` accept a `crash`-interrupted row in addition to `user` (still rejecting `running`/`queued`/`ended` rows and offline connections). The dispatched `resume` control command carries the prior `interruptedReason` so the daemon can build a crash-specific prompt.
2. **Daemon CLI**: the resume re-dispatch path threads the reason through `control-handler` → `event-router` → `prompts`; a crash resume produces a crash-specific continue instruction ("exited abnormally — verify current state, then continue"), a user resume keeps the existing text. The path is spawner-agnostic, so codex sessions resume via their thread_id map exactly as Claude Code sessions resume via the on-disk transcript probe.
3. **Frontend**: crash-interrupted executions render the same `ResumeButton` as user-interrupted ones — in the chat composer action row and on connection-deck execution rows — replacing the static "Auto-recovers" hint with an accurate "exited with error" label + Resume. i18n in both locales; design.pen updated.

**Not changing**: crash detection/reporting (already shipped), reconnect-backfill auto-recovery on daemon reconnect (kept as-is; manual resume covers the daemon-still-online case), interrupt flow, `DaemonExecution` schema (no migration needed).

## Impact

- **Affected spec**: `daemon-interrupt-resume` (resume endpoint semantics, resume-intent requirement, UI controls requirement; one added requirement for the crash-specific instruction).
- **Affected code**: `src/services/daemon-execution.service.ts` (resumeExecution guard), `src/app/api/daemon/resume/route.ts`, `src/services/daemon-control.service.ts` (control event payload), `cli/control-handler.mjs`, `cli/event-router.mjs`, `cli/prompts.mjs`, `src/components/agent-presence/execution-row.tsx`, `src/components/agent-presence/send-instruction-box.tsx`, `messages/en.json` / `messages/zh.json`, `docs/design.pen`.
- **Risk**: low — reuses shipped resume infrastructure end-to-end; the main behavioral change is permitting one more `interruptedReason` value through an existing, tested path. Double-run risk (manual resume + later reconnect-backfill re-fire of the same crashed wake) is bounded by the existing per-notification `seen` dedup and per-session turn serialization; addressed in design Risks.

OpenSpec change slug: add-crash-execution-resume
