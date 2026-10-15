# Low-cost SSE authorization lease verification

- Idea: `d5b5849c-c806-4f35-aacb-5346bd78e4ce`
- Follow-up task: `da9e85f7-e938-4318-823a-b14870140e78`
- Date: 2026-10-15
- Implements the requester's cost principle and Leo/Clay's event-driven design; supersedes the per-delivery authentication contract in the historical SSE report.

## Implementation contract

- Ordinary event/notification delivery only checks memory, known credential expiry and a monotonic deadline. It does not repeat full authentication, token cryptography, profile refresh or API-key `lastUsed` writes.
- Verified credential metadata stays in internal WeakMaps, not public DTOs. Lightweight state checks read current user/workspace/session generation or key/Agent/owner/permissions using existing indexes.
- Successful user lifecycle commits and Agent/key changes publish tenant/UUID-scoped `account_access_changed`. Failed transactions do not publish. Related connections revalidate rather than blindly closing, preserving fresh sessions and otherwise-valid owner keys after password-only resets.
- Registration precedes the initial authoritative read. Revision changes force rereading; pending checks suspend queued sends. Failure, abort or expiry closes once and removes listeners/timers.
- Lease duration is 30 seconds from query **start**, not completion. Renewal normally starts after 25 seconds, ahead of the existing 30-second heartbeat. Final enqueue checks the deadline even when timer callbacks are delayed; hung queries cannot extend old authorization.
- Redis remains best-effort. Missing broadcasts intentionally permit a bounded 30-second revocation window, not per-message authoritative revocation. Project/group authorization remains independent.
- Mention candidate SQL now folds active/undeleted user and owned-Agent eligibility into existing queries before `take`; no extra recipient lookup is added. Unowned Agent candidates remain compatible.
- Removed unrelated Prisma formatting changes without changing those models' semantics. Deleted identifier reuse still creates a fresh UUID with no inherited rights/history.

## Tests and honest failure history

The first run against the old per-message test contract failed (44 failed, 372 passed). Those tests required immediate revocation without a broadcast, incompatible with the authorized bounded-window design. Tests now explicitly send committed invalidations and additionally exercise lease/missed-relay behavior; no failed run is reported as passing. Two initial TypeScript failures (unsupported Agent update property; union fixture access) were corrected.

Scoped run: **12 files / 484 tests passed**, covering both actual SSE routes, actual JWT/API-key resolution with persistence doubles, local lifecycle commit ordering, identity recreation and backward-compatible authorization. Mention/gate run: **7 files / 97 tests passed** before adding stricter query-shape assertions; final full regression covers those assertions.

Three independent in-memory negative controls transformed only the loaded gate, never the working-tree source:

1. Remove final monotonic deadline check: delayed-timer test **fails**.
2. Restore per-message refresh: 100-message cost test **fails** (101 checks instead of one).
3. Ignore initialization revision changes: registration-race test **fails**.

Each control exits 1 with the intended assertion failure, not an import/configuration failure. Controls/config/logs are under `/tmp`, not committed.

## Validation boundary

Gate tests simulate two server connections and a dropped relay; they are not a live two-Redis-instance deployment or a measured production load test. Query counts demonstrate removal of message-proportional authentication work, not a throughput benchmark. Existing isolated HTTP/SQL and Playwright reports are historical evidence, not rerun claims for this patch. PostgreSQL multi-connection contention and Pencil design updates remain outside this round's evidence. Private deployment configuration/credentials are never committed.

## Final developer validation

- Final scoped regression: **13 files / 505 tests passed**.
- Mention persistence integration: **68 tests passed**, including actual status/owner relation filtering, tombstones and unchanged unowned-Agent behavior with one existing candidate query per model.
- First complete run: **24 failed / 11,165 passed / 245 skipped**. The mention persistence double lacked migrated active/deleted fields and relational `owner.is` matching; corrected the double to model real owner rows (including the prior agents-only search fixture) and updated exact query expectations. Added four eligibility regression cases rather than weakening the filter.
- Final complete run: **477 files passed / 11 skipped; 11,193 tests passed / 245 skipped**, exit 0 (322.71 seconds).
- Root TypeScript (non-incremental), CDK build/types and `git diff --check`: passed.
- Production `pnpm build:local`: passed; **67/67** static pages generated. Existing non-blocking lint warnings remain.
- Current OpenSpec source mirrored byte-for-byte to Chorus document `3b298ce3-2bb3-4262-8d6f-02187e9af069`, version 5.

## Independent round 1 and finalization-race correction

Independent reviewer comment `eafe6e6f-1502-4956-91b6-4805c73bcf47` returned **FAIL** despite 524 focused tests and 11 extra light-validator probes passing. Two adversarial microtask probes showed a received invalidation could arrive after a successful read but before promise finalization and be lost (both initialization and renewal). No commit, PR or deployment was performed on that failed review.

The gate now tracks the revision actually validated, repeats a dirty check in promise finalization, and makes send wait until both pending checks and dirty revisions are resolved. An already-aborted request closes rather than restarting initialization. Ordinary clean sends still do no authentication work. Both adversarial cases are permanent queued-send regressions.

After correction:
- Focused gate/routes/lifecycle/mention regression passed.
- Four in-memory negative-control runs each fail only their intended assertions: deadline, per-message cost, registration revision and both completion-to-finalizer races (five failing tests across four runs).
- Non-incremental root types and diff checks passed.
- Complete regression: **11,195 passed / 245 skipped; 477 files passed / 11 skipped**, exit 0 (327.79 seconds).
- Production build repeated successfully after the correction, **67/67** pages.

## Independent round 2 and aborted-setup correction

Round-2 comment `8db509e4-33a9-4f82-b937-ad245869518e` confirmed B1 fixed (both exact original unqueued probes, both permanent queued regressions, and five extra waiting/cancellation probes passed), but returned **FAIL** for B2: an already-aborted request could synchronously call the gate's route teardown before `cleanup` was initialized. Both actual routes reproduced the exception and skipped daemon disconnection; the events route retained connect-window listeners. The reviewer independently ran 526 focused tests and types; those do not override the failing adversarial cases.

The abort guard now schedules teardown in a microtask so synchronous route setup can initialize its callback; aborted sends remain rejected immediately and subsequent close is idempotent. Two permanent actual-route tests cancel during API-key authentication and check both GET/body completion, exactly one disconnection, and no remaining listeners. The in-memory negative control restoring synchronous close fails both intended cleanup assertions.

After B2 correction: focused gate/route tests, non-incremental root types and diff checks passed; final complete regression **11,197 passed / 245 skipped**, **477 files passed / 11 skipped**, exit 0 (326.73 seconds); production build repeated successfully (**67/67** pages). Earlier failed independent rounds are retained as failed evidence, not erased or counted as approvals.

## Final independent acceptance

Round-3 comment `b2293fef-bf65-461e-b4a2-d19846f952bf`: **PASS**, zero blockers/notes. Both B1 and B2 were independently reproduced with the exact original probes and confirmed fixed. The reviewer ran **528 focused tests / 14 files**, **7 additional adversarial probes**, and non-incremental types twice. Additional actual-route probes advanced only the monotonic clock (not timers) beyond the lease: both routes stopped protected delivery, disconnected once and removed listeners without extra authentication reads or usage writes.

All three acceptance criteria were independently evidenced and admin-verified with explicit `task:admin`; follow-up task `da9e85f7` is **done**. Parent full-suite/build results remain distinct from independent runs. Authorized PR/default-deploy outcomes are recorded in the Idea's subsequent completion comment/report.
