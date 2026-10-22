# Live principal eligibility — Clay B1 follow-up

Task: `cdaf3753-ece7-4baf-888a-99e637999d13`; original proposal: `6ea93f41-96bc-474b-94d1-8c9a87b6ff71`.
Review finding: `B1-clay-tombstone-selectable-principal`, Idea comment `1075048d-6429-4213-bca5-12be8372d236`, baseline `1703f471`.

## Reproduction and fix

The real lifecycle service deletes A, releases its identifiers, creates a fresh invitation B and activates B. A stateful persistence double executes the actual service writes; this is not a live PostgreSQL locking experiment.

- Before the fix, the candidate list contained both A and B. The new regression ran with **6 failures / 9 passes** (`/tmp/chorus-b1-red.log`).
- Hiding candidates alone was insufficient: project membership creation with A returned success. The first follow-up run also exposed a missing test mock export; after completing the mock, the corrected negative control again had **6 failures / 9 passes**, with the deleted UUID returned as a newly created member (`/tmp/chorus-b1-grants-red2.log`).
- Assignment candidates now use the existing user query with `status: active, deletedAt: null` and tenant scoping.
- Project/group membership creation and promotion require the same eligibility within the existing resource mutation transaction. Removal and demotion retain historical cleanup and automatic/last-admin guards. No fallback-admin policy changes are made.
- The shared new-assignment gate rejects ineligible users before the public-project editor floor or a retained private-project membership can authorize them; task claim, Idea claim and Idea assignment all use it. Historical `resolveLiveAssignee`, display queries and stored member UUIDs remain unchanged.
- EN/ZH operator guides explain the identity-only targeted-lockout trade-off and why edge attribution/abuse controls are required. No throttle policy changes are made.
- The cumulative OpenSpec adds a live-user assignment/grant scenario; the historical archived change is not rewritten. Chorus spec document `3b298ce3-2bb3-4262-8d6f-02187e9af069` updated to version 7.

## Validation

```sh
pnpm exec vitest run src/services/__tests__/local-user-recreation.test.ts \
  src/services/__tests__/agent.service.test.ts \
  src/services/__tests__/project-member.service.test.ts \
  src/services/__tests__/project-group-member.service.test.ts \
  src/services/__tests__/task.service.test.ts \
  src/services/__tests__/idea.service.test.ts \
  src/services/__tests__/task-assignment-access.test.ts
# 7 files, 362 tests passed
pnpm exec tsc --noEmit --incremental false
# exit 0, no diagnostics
pnpm exec openspec validate workspace-local-users --type spec --strict
# valid (informational long-requirement hints only)
git diff --check
# exit 0
```

The first scoped run had 10 failures / 279 passes because old fixtures lacked schema-default active/deletedAt fields, one task mock lacked the user model, and two exact-query assertions still expected the old predicate. These fixtures/assertions were updated, not bypassed. The lifecycle regression tests run real target services; project authorization is separately covered by the existing real-access-service matrix and automatic-admin suites.

Changed-service ESLint completed with 0 errors. Test files are ignored by the repository lint configuration (6 ignored-file warnings), not independently linted. Whole-repository strict OpenSpec validation reported 44 valid / 113 failures for pre-existing Purpose placeholders in unrelated specs; the touched workspace-local-users spec is valid. These unrelated specifications were not modified.

## Complete-suite follow-ups

- First complete run: **1 failed / 11,214 passed / 245 skipped**. The positive same-company user in the shared MCP integration fixture omitted `status`/`deletedAt`; the real active/undeleted query correctly could not find it. The fixture now includes the actual schema defaults.
- Added four actual MCP-handler → Idea-service rejection cases (invited, disabled, deleted, active-with-deletedAt), asserting no assignment, Activity, notification or daemon turn.
- The initial new cases expected an `isError` return, but this fixture invokes the raw unwrapped handler, which correctly throws `AssigneeAccessError`. The combined test/typecheck shell returned the last command's exit status; the initial task progress comment wrongly called the integration suite passed. Task comment `bda445a2-2c9a-4f39-b7c5-1613e83d7151` corrects that result explicitly. The tests now assert the raw-handler 403 rejection rather than changing production error handling.
- Second complete run: **5 failed / 11,214 passed / 245 skipped** — four new raw-handler assertion errors above, plus an unchanged CLI spawner 5ms stdio grace timing assertion observing an extra warning under overlapping suites. No CLI production code, timeout or assertion was changed.
- Corrected integration plus CLI-spawner rerun: **76 passed** (15 integration + 61 spawner), exit 0; another nonincremental typecheck passed. The final complete run uses `--maxWorkers=2` to bound test-process load; its result is recorded below.

## Fresh independent task review

A separate ephemeral read-only TRAE CLI process invoked `chorus:chorus-task-reviewer` and posted Task comment `326f3d5a-d250-422b-b1b5-caf13b6bf97a`: **VERDICT: PASS WITH NOTES**, zero blockers. The current round's comment, not a stale output file or prior review, is the authority.

The reviewer independently ran 377 task-scoped tests, nonincremental types, changed-service lint, touched-spec strict validation and diff checks. Read-only in-memory HEAD negative controls independently produced 12 expected failures for all four old services and six expected failures for old membership services alone. The final corrected integration assertions were re-read and rerun. Their own broad run had 11 failures / 11,208 passes / 245 skips (four then-incorrect raw-handler assertions and seven untouched installer/users-UI failures); final isolated reruns passed 15 integration, 145 installer and 26 users-UI tests. N1-full-suite-final-snapshot remains a note until a clean final-snapshot aggregate/CI run; the review does not misrepresent the failed broad run. pnpm execution initially failed under their read-only filesystem; already-installed binaries were used without installing packages.

## Final developer aggregate validation and cleanup

- `pnpm exec vitest run --maxWorkers=2`: exit 0, **477 passed / 11 skipped files; 11,219 passed / 245 skipped tests**, duration 309.77s. This clean final-snapshot run addresses the aggregate-run evidence requested by the independent note; it is developer evidence, not a claim that the reviewer reran the whole suite successfully.
- `pnpm build`: exit 0, compiled successfully and **67/67** static pages generated. Existing repository lint warnings remain; no errors.
- Local/Chorus cumulative spec bytes compared exactly: version 7 matches.
- Fresh reviewer CLI and all test/build processes exited. No test listeners on 5435/8640/8641. No new browser, app or database was started, and the normal deployment/private data were not stopped or altered.

## Boundaries and pending gates

No frontend or SSE implementation changes. This round does not claim new browser, external IdP, Redis multi-instance, PostgreSQL multi-connection locking or load verification. The existing resource transaction's eligibility check is not a new cross-resource serialization guarantee against concurrent account lifecycle mutations. N5 first-company-user implicit-admin behavior remains unchanged pending the requester's product decision. Full regression and fresh independent task review results are recorded below when available. No merge is authorized; Clay's requested limited aggregate re-review remains a separate gate.
