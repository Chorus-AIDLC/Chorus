# Tasks: add-crash-execution-resume

> Chorus task drafts are the source of truth; this file mirrors them for local reference.

## T1 — Server: allow crash resume + thread resumeReason
- [ ] Widen `resumeExecution` guard to `interruptedReason ∈ {user, crash}`; extend result with `resumedFrom`
- [ ] `POST /api/daemon/resume` forwards `resumeReason` into `dispatchControl`; offline refusal + auth unchanged
- [ ] Unit tests: crash row resumable; running/queued/ended rejected; offline refused; reason forwarded

## T2 — Daemon CLI: crash-specific continue instruction (depends: T1)
- [ ] Thread `resumeReason` through `control-handler` → `daemon.mjs` wiring → `event-router.dispatchResume`
- [ ] `prompts.mjs` `resource_resumed` branches on `resumedFrom`; crash variant instructs verify-then-continue
- [ ] Missing/unknown reason degrades to existing user-resume prompt; CLI unit tests

## T3 — Frontend: Resume button on crash rows (depends: T1)
- [ ] `send-instruction-box.tsx` + `execution-row.tsx`: crash branch renders error label + `ResumeButton`
- [ ] Replace `execCrashAutoRecovers` with accurate error string in en+zh
- [ ] design.pen updated

## T4 — Integration checkpoint (depends: T2, T3)
- [ ] Local server + daemon e2e: kill subprocess → crash row → click Resume in chat → same conversation continues
- [ ] Verify codex-path dispatch (spawner-agnostic resume) and resume-then-reconnect dedup
