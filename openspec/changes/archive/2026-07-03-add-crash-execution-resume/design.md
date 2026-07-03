# Technical Design: One-click Resume for crash-exited daemon executions

## Overview

Extend the shipped interrupt/resume infrastructure (change `daemon-interrupt-resume`, cumulative spec `openspec/specs/daemon-interrupt-resume/spec.md`) so a `crash`-interrupted `DaemonExecution` row is manually resumable, exactly like a `user`-interrupted one — same endpoint, same control channel, same wake re-dispatch — with one addition: the resumed wake's prompt states that the previous run exited abnormally and instructs the agent to verify state before continuing (elaboration q2=a).

Everything reuses existing seams. No schema change, no new endpoint, no new permission bit.

## Current state (verified against code)

| Piece | Today | File |
|---|---|---|
| Crash detection | Daemon reports `reason="crash"` on unexpected non-zero/kill exit via `POST /api/daemon/report-interrupt`; row becomes sticky `interrupted`/`crash` | `cli/waker.mjs:409-429`, `cli/interrupt-reporter.mjs`, `src/app/api/daemon/report-interrupt/route.ts` |
| Resume endpoint | `POST /api/daemon/resume` **rejects** `crash` rows (`resumeExecution` requires `interruptedReason === "user"`); refuses offline connections | `src/app/api/daemon/resume/route.ts:88-96`, `src/services/daemon-execution.service.ts:917-947` |
| Control channel | `dispatchControl` emits `{command:"resume", entityType, entityUuid}` on `control:{connectionUuid}`; daemon double-checks connection uuid then `redispatchResume` | `src/services/daemon-control.service.ts`, `cli/control-handler.mjs:138-146` |
| Wake re-dispatch | `EventRouter.dispatchResume` builds a synthetic `resource_resumed` wake → normal keyFor/enqueue path → spawner probes on-disk transcript (Claude) / thread-id map (codex) → session resume | `cli/event-router.mjs:225-236`, `cli/prompts.mjs:182` |
| Resume prompt | Fixed text: "Your work on this {entity} was RESUMED after an interrupt… continue where you left off" | `cli/prompts.mjs:182-198` |
| UI | Composer action row + connection-deck rows: `running`→Interrupt, `interrupted/user`→Resume, `interrupted/crash`→static "Auto-recovers" text | `src/components/agent-presence/send-instruction-box.tsx:164-183`, `execution-row.tsx:359-375` |

## Key decisions

### D1 — The continue instruction is the synthetic wake prompt, not a persisted turn

q2=a asks for a fixed injected continue instruction. The existing `resource_resumed` synthetic wake prompt **already is** a fixed continue instruction; a crash resume only needs a variant of that text. So: thread the resume *kind* (`user` | `crash`) through the control event and the daemon's re-dispatch, and branch the prompt text in `cli/prompts.mjs`. No new `DaemonSessionTurn` is persisted for the resume itself (same as user-resume today); the resumed run's transcript still appends to the same daemon session, satisfying q6=a (crash → resume → continuation visible in one conversation stream).

Rejected alternative: server-side injection of a `human_instruction` turn. More moving parts (turn creation, origin pinning, pending-turn sweep interplay) for the same user-visible outcome, and it would double-render the instruction in the chat transcript.

### D2 — Reason threading on the wire

- `resumeExecution` (service): accept rows with `interruptedReason ∈ {"user","crash"}`; return the prior reason so the route can forward it.
- Control event: `dispatchControl` payload gains an optional `resumeReason?: "user" | "crash"` field (forward-compatible: older daemons ignore unknown fields — `control-handler` destructures only what it knows).
- Daemon: `control-handler` passes `resumeReason` to `redispatchResume` → `EventRouter.dispatchResume` stamps it on the synthetic notification (e.g. `resumedFrom: "crash"`) → `buildPrompt("resource_resumed")` branches: crash text = "the previous run on this {entity} EXITED ABNORMALLY (crashed) — first re-check the current state with the appropriate chorus_get_* tool and inspect any partial work, then continue the unfinished work"; user text unchanged.
- Missing/unknown `resumeReason` (old server, new daemon) degrades to the existing user-resume text — never a failure.

### D3 — Backend coverage is free by construction (q7=b)

`dispatchResume` re-enters the normal wake path; spawner selection (`cli/spawner-select.mjs`) and session anchoring (Claude on-disk transcript probe / codex `codex-session-map`) are downstream of it and already backend-generic. The design adds no backend-specific code; the integration task verifies both.

### D4 — UI: crash row renders ResumeButton; the misleading hint goes away

In both mounts (`send-instruction-box.tsx` composer action row; `execution-row.tsx` deck row), the `interrupted/crash` branch renders `<ResumeButton exec={exec} />` — the same shipped component, same `POST /api/daemon/resume` call — preceded by a short error label (e.g. "Exited with error") replacing `execCrashAutoRecovers` ("Auto-recovers"), whose claim is wrong when the daemon never went offline. The conversation-list error glyph (`session-execution.ts` "error" display state) stays. Offline origin: the existing endpoint refusal + composer offline gating already cover it (q3 "align with interrupt-resume").

### D5 — Reconnect-backfill auto-recovery is kept, dedup bounds double-runs

The cumulative spec's "A crash is auto-recovered by reconnect-backfill" scenario stays true (it covers the daemon-restart case). Manual resume covers the daemon-still-online case the backfill never reaches. Interplay: a manual resume flips the row to `running`; if the daemon later reconnects, backfill re-fires only *unread notifications / pending turns* (not execution rows), and the shared `seen` set plus per-session queue serialization bound duplicate wakes — same exposure as the shipped user-resume, no new mechanism. The spec's intent requirement is MODIFIED to say crash recovery is "automatic on reconnect **or** manual via resume", and that a user interrupt is still never auto-resumed.

## Module contracts

- `resumeExecution(companyUuid, connectionUuid, entityType, entityUuid)` → `{ ok: true, resumedFrom: "user" | "crash" } | { ok: false, ... }` (extends the existing discriminated result; not-found / not-resumable arms unchanged).
- Control event (resume): `{ type: "control", command: "resume", targetConnectionUuid, entityType, entityUuid, resumeReason?: "user" | "crash" }`.
- Synthetic wake: `{ action: "resource_resumed", entityType, entityUuid, resumedFrom?: "user" | "crash" }`.
- UI branch contract (both mounts): `running` → Interrupt; `interrupted/user` → Resume; `interrupted/crash` → error label + Resume; else → nothing.

## Implementation plan

1. **T1 server**: widen `resumeExecution` guard + result; route forwards `resumeReason` into `dispatchControl`; service/route unit tests (crash row resumable, ended row still rejected, offline still refused, reason forwarded).
2. **T2 daemon CLI**: thread `resumeReason` through `control-handler` → `daemon.mjs` wiring → `event-router.dispatchResume` → `prompts.mjs` crash variant; CLI unit tests for both texts + degradation without the field.
3. **T3 frontend**: swap crash branches to error-label + ResumeButton in both mounts; remove/replace `execCrashAutoRecovers` in both locales; design.pen update.
4. **T4 integration checkpoint**: local server + daemon, real crash (kill the subprocess externally) → row shows `interrupted/crash` → Resume in chat window → same conversation continues; verify Claude Code path end-to-end and codex path at the dispatch level.

## Risks & mitigations

- **Double execution (manual resume races reconnect-backfill)** — bounded by existing `seen` dedup + per-session serialization (D5); the integration task exercises a resume-then-reconnect sequence.
- **Crash row with a dead session anchor** (e.g. crash before any transcript existed): the wake path's new-vs-resume probe naturally starts a fresh session in the same cwd — degraded but safe; the crash prompt's "re-check current state" instruction covers the missing in-session context.
- **Old daemon + new server**: daemon ignores `resumeReason`, resumes with the generic text — functional, just less specific. No version gate needed.
