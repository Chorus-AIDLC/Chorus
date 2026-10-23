# Agent Team routing and gates — verification

## Scope and environment

Idea `1cd14b40-e4fc-4766-a5fd-8699835bed61`, proposal `8076e9c3-7748-40a4-ad1b-c4bbee4486aa`.

Browser checks use a fresh PGlite database at `/tmp/chorus-team-e2e-l1SJL8`, listening on localhost:5433, with the development application on localhost:8637. The connected Chorus tracking server on localhost:18637 is not the test database. The disposable fixture project is `8075f76e-7885-41f9-8d34-e41643729bf6`; its Idea is `7911acaa-d44b-4a16-89c5-c79d98f55561`.

## Browser observations

1. Logged in through the real username/password flow, then skipped fresh-account onboarding.
2. Created a disposable project and unassigned Idea using authenticated application REST APIs. Observed `assignee: null` and the Idea detail's unmanaged/manual gate summary.
3. Created a disposable admin agent and personal Team, then applied the Team through its API. The existing unassigned Idea remained unassigned; no daemon exists for the fixture agent.
4. Used the actual Idea assignment dialog to explicitly assign the fixture lead. The gate endpoint returned `managed: true`, `state: active`, `proposalGate: human`, `taskGate: lead`, and the fixture lead name. Chinese light-theme UI showed those gates in the default Elaboration tab, not only Overview.
5. Switched to English and dark mode through the real sidebar menus. Unbound the disposable Team via its API. The endpoint retained managed enrollment, returned `state: paused`, `reason: team_unbound`, and preserved the recorded lead. The rendered warning explained that explicit repair is required and human management remains available.
6. Screenshot inspection found readable light/dark text and no private role/member lists. Artifacts: `.playwright-mcp/team-gates-active-zh.png` and `.playwright-mcp/team-gates-paused-en-dark.png` (gitignored).

The initial hot-reload session emitted a React dependency-array warning while the effect's source was being edited; a clean navigation removed it. A later navigation reported transient browser `ERR_NETWORK_CHANGED` for unrelated session/navigation requests; subsequent gate fetch and rendering succeeded. These are not asserted as application test failures or silently claimed as a console-clean session. No live agent execution, deployment, or native Pencil rendering is claimed by these browser checks.

## Automated evidence

- API/MCP/UI focused pass: 90 tests across gate summary, locale parity, MCP registration/contracts, approval/verification actor propagation, access inventory and both Idea panel regressions.
- Backend worker: 3,137 service tests passed, 132 existing skips, including 12 isolated PostgreSQL Team scenarios.
- CLI/OpenClaw/Hermes/dsh/Pi checks and exact version-maintenance evidence are recorded on task `fddfd598-a88d-4e28-9a7f-4e1bf76a3329`; no publish command was executed.
- TypeScript passes. Scoped source lint has no errors (test files ignored by repository config and pre-existing warnings are not claimed as lint coverage).
- `docs/design.pen` parses with 9,870 unique IDs; the two added frames describe light/dark gate states. Native Pencil rendering is not available here.

## Review and follow-up evidence

- The three original implementation tasks passed independent task review and admin verification. A small follow-up corrected the stored-input submission test's actor expectation and the archived cumulative specification's generated Purpose; its 11 targeted tests and independent review passed.
- Before the lifecycle-wake remediation, the full suite passed: 524 files passed, 11 skipped; 12,080 tests passed, 245 skipped (`pnpm exec vitest run --maxWorkers=4`, 2026-10-23). This result does not validate subsequent wake changes.
- Aggregate code review Round 1 found that lead notifications for proposal submission and task verification/status changes did not create daemon turns. Proposal-linked task `3579d973-fe26-4eea-85d6-68eab7e0a59e` tracks the dedicated `team_lead_handoff` fix; completion requires its independent task review and a new aggregate review.
- After the backend/CLI wake fix, the full root suite passed: 524 files passed, 11 skipped; 12,101 tests passed, 245 skipped. Task review then found OpenClaw recovery negotiation and notification-broadcast bypass gaps. The follow-up requests `wakeRecoveryProtocol=1`, ignores dedicated handoff audit notifications, preserves legacy task recovery, and refuses embedded execution when exact-turn admission fails. Real REST-client/server-shaped-response tests cover live/reconnect delivery, suppressed/other-connection/duplicate broadcasts, and rejected/missing/mismatched admission; OpenClaw's separate suite and typecheck are rerun after those changes.
- The lifecycle-wake fix passed task review Round 2. Aggregate review Round 2 accepted its runtime repair but caught a root-owned parity test still expecting a notification-switch handler. Task `591b2e93-0b47-4f4f-9c56-cb7f02962640` updates the exact named turn-delivery exceptions and asserts canonical delivery, audit suppression, negotiation and admission remain present. It does not restore broadcast execution or weaken ordinary missing-handler detection. Targeted root parity/CLI regressions pass (185 tests); OpenClaw passes (254 tests, 3 optional skips) with clean typecheck. A new full root run covers the final combined tree; earlier full results are not substituted for it.
- The OpenSpec change is archived at `openspec/changes/archive/2026-10-23-agent-team-routing-gates/`. Cumulative specification validation and exact byte comparison with Chorus Document `1d5daadc-63bf-4387-aff3-9bb7866f3d71` version 3 passed. The follow-up does not re-archive or weaken the existing requirements.

## Final outcome

All six proposal-linked tasks are verified done. Aggregate code review Round 3 passed with zero remaining blockers (Idea comment `92da8c47-c226-454e-a04a-b0da81e8f5cc`). The final combined-tree root run completed successfully: **524 files passed, 11 skipped; 12,102 tests passed, 245 skipped** (`vitest run --maxWorkers=4`, 2026-10-23, 263.25 seconds). Fresh root TypeScript checking with incremental compilation disabled also passed. Final OpenClaw validation passed **254 tests, 3 optional skips**, plus TypeScript; Hermes validation passed **434 tests**. Skipped opt-in suites are not claimed as executed.

No commit, push, merge, deployment or publication was performed. Local app/plugin versions are aligned at 0.23.1. The requester's additional Clay review is separate from these automated gates; it does not authorize publishing or merging.

## Clay review S1 follow-up

Task `6bf18368-2671-4112-8e16-9b29d43f504d` adds bounded P2034 retry to proposal approval/submission and task completion, retaining Serializable isolation and the original timeout. Approval rereads its source inside each attempt, requires pending status, and updates using tenant/UUID/status predicates. This prevents a serialization loser from repeating a competing committed approval or overriding closure/rejection. Publications remain outside retry; ordinary non-done task updates do not retry.

Sixteen added isolated-PGlite cases cover managed and unmanaged work, complete callback rollback before retry, bounded failure/non-conflict propagation, unique committed materialization/publication, Team revocation between attempts, and competing approved/closed/draft states. These are deterministic conflict-injection/interleaving tests, not a claim of natural PostgreSQL contention. Independent task review Round 2 passed; targeted suites passed 274 tests and TypeScript passed. Final combined-tree root validation completed with **524 files passed, 11 skipped; 12,118 tests passed, 245 skipped**, in 270.85 seconds. Scoped lint reports zero errors and two preexisting unused-import warnings.

Clay's D1 choice remains unresolved: explicit reassignment to a non-lead can either retain paused enrollment or explicitly exit Team management. This follow-up does not change that policy, historical YOLO authorization, super-admin semantics, or notification caching. No commit/push/merge is authorized by these results.

The additional aggregate review caught the task-side equivalent of approval replay: a serialized verification retry could overwrite a competing reopen/close. Follow-up task `7a3f339c-50d7-4d77-91ab-19f8ff7bfe42` rechecks `to_verify` and required acceptance criteria inside every transaction attempt, then uses a tenant/status-qualified update. Four registered-MCP/PGlite schedules cover reopen, close, criterion invalidation and successful retry, including absence of a losing verification activity. No-criteria and optional-criteria compatibility is retained. The AC helper's client type derives from the actual extended Prisma client; an initially incompatible unextended type was caught and corrected during review.

Latest runtime full-suite result: **524 files passed, 11 skipped; 12,122 tests passed, 245 skipped**, in 283.86 seconds. The sole subsequent production-source edit is that type annotation; fresh no-incremental TypeScript checking and 147 task/PGlite tests both passed afterward. Earlier full-suite counts above remain historical evidence, not substitutes for this latest validation.

Both S1 follow-up tasks are verified done. Additional aggregate review passed in follow-up cycle 2/3 (overall Round 5, Idea comment `0aeb92f4-4e17-46ef-af06-5e0d6063941f`), independently rerunning 153 tests and no-incremental TypeScript checking with no remaining code blockers. D1 remains a separate human decision, not an implicitly accepted policy change.
