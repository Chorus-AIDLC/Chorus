# Dedicated daemon operations — verification record

Date: 2026-09-27. Idea: `761b9e5d-7bbf-46e2-aff2-7ec1d3ac027c`.
Approved proposal: `4a917a0b-9fe8-4a29-ad0b-e685fca2da5d`.
Local branch: `feat/daemon-operation-events`, base `ecc31bfe`.

This is an interim verification record, not a feature completion report.
T1 (server), T2 (CLI), and T3 (UI) passed independent task review and admin
verification. T4 also passed independent review and admin verification (Round1 PASS
`1470bb5e-82b5-4954-bce3-bee726a81b32`). All four tasks are done. Browser evidence is recorded
below. Pencil synchronization was explicitly waived by the human at 08:18 UTC in
Idea comment `e072b3a2-15df-4f98-9dd3-595eadc1c49d` (“不用管pen文件，继续推进”).
The final aggregate code-review gateway has not run.
No push, PR merge, release, or production deployment was performed.

## Server and CLI

| Scope | Actual result |
| --- | --- |
| Migration | `prisma migrate deploy` and `prisma generate` passed on isolated PGlite :5435. Migration adds only nullable JSONB. |
| Server/API | 76 files, 2,243 tests passed; all 97 real database cases passed; 16 unrelated opt-in cases skipped. |
| CLI | 94 files, 2,253 tests passed. |
| OpenClaw | 13 files, 202 tests passed; 3 live-stack tests skipped. |
| Static checks | Root and OpenClaw TypeScript passed. Changed production ESLint passed; CLI has one unchanged `_rawData` warning. Diff checks passed. |

Commands:

```sh
RESEARCH_DATABASE_URL='postgresql://postgres:postgres@localhost:5435/postgres?sslmode=disable' \
  pnpm exec vitest run src/services/__tests__ src/app/api/daemon
env -u CHORUS_AGENT_PROFILE -u CHORUS_E2E_BASE_URL pnpm exec vitest run cli/__tests__
pnpm exec tsc --noEmit --incremental false
# From packages/openclaw-plugin:
env -u CHORUS_E2E_BASE_URL pnpm exec vitest run
pnpm exec tsc --noEmit --incremental false
```

The server database suite covers canonical and historical Research, both creation
modes and all description budgets, capability projections retaining the same UUID,
mixed FIFO/coalescing, origin/company/agent fences, stage changes and descendants,
exact admission, launch abort, terminal idempotence/usage, and the new-write rollback
switch. The first independent review found a stale admission could bind the losing
process's backend ID before returning a conflict. Status claim and both backend
writes now share one transaction. Eight permanent database regressions cover both
stale-read interleavings and rollback after the session write. The original reviewer
probe passed independently after the fix.

T1 Round 2 PASS: `8c2f6b9d-4784-4c11-bcfd-ded7f8b7661c`.
T2 Round 1 PASS: `e8e4ac4e-3f4a-473f-9a23-d4e8554e5c44`.
The CLI reviewer also composed the actual router, serial queue, waker and REST
reporter with mock network/process boundaries: both canonical operations launched
once after their exact admission and terminated on their original UUIDs.
This harness did not launch real agents or substitute for T4's live compatibility
matrix.

## T4 integration acceptance

T4: `a7f25c57-0555-4794-8452-32f2a5e64799`. Tested against implementation
`00f3973d` plus the uncommitted test/document changes on the shared branch.
No production defect was identified and no production code was changed by T4.

Permanent suite:
`src/services/__tests__/daemon-operation-http.database.integration.test.ts`.
All **14 cases passed**, adding to the existing **97 real database cases**.
It composes actual CLI control handler, pending backfill, EventRouter, WakeQueue,
Waker, prompts, turn reporter and REST client with a real loopback HTTP server.
The server invokes the actual Next creation, Idea-detail, pending-turn and
turn-advance handlers and services using real Prisma persistence on isolated
PGlite `:5435`. Creation enters through HTTP; Research dispatch calls its actual
service. The actual local EventBus supplies captured origin delivery pings.

| Integration case | Observed result |
| --- | --- |
| Both flags and operation-only | Elaborate and decompose each create one canonical turn through HTTP, then Research runs on the same root. Payload-selected prompts, original UUID, explicit project cwd and exact admission/terminal reports survive the whole path. All four executions per mode end; reconnect has no pending rows for those sessions. |
| Research-only capability | Both creation modes use saved `human_instruction` projection and FIFO; Research retains exact isolated admission. Canonical stored triggers remain unchanged; all four executions end. |
| No capability | The historical FIFO adapter runs projected creation and Research through the real queue/waker and HTTP acknowledgement path. A separate creation + two Research sequence ends as `ended, ended, merged`; a fresh consumer starts nothing on reconnect. |
| New CLI / old-server shape | New client still sends both flags. A server adapter ignores `operationProtocol`, exercising real compatibility projection/acknowledgement with the new router and Research-prefix fallback. Both creation modes and Research end successfully. |
| Duplicate live + backfill, independent consumers | Repeated actual captured `deliver_turn` pings and backfill launch once. While the first process stub remains active, another same-origin consumer with a stale pending DTO receives HTTP 409 and launches nothing; the original row remains running until its owner completes. |
| Two Research + ordinary work | Batch sequence is Research, ordinary, Research, two ordinary instructions. Maximum active batch count is one. Both Research rows end separately; only the final ordinary neighbor is merged. |
| Terminal response loss | The handler commits `ended`, then the loopback server returns a fixture 503. The actual reporter retries the same UUID; persisted per-turn usage stays 7 input / 3 output and the four-execution session total remains 28 / 12, with no double rollup. |
| Wrong origin | Another registered connection ignores the origin control ping, receives no origin pending turn and cannot admit the exact UUID. The row stays pending/unbound until the origin executes it. |
| Invalid payload and retry | Unsupported version stays pending, produces a visible retryable CLI warning, does not acquire seen ownership or spawn, and receives HTTP 409 on direct admission. Repairing that same fixture UUID allows reconnect to execute it once. |
| Descendant stage change | Actual descendant task transition to in_progress closes Research at either pending-read or stale-DTO admission. The row becomes `interrupted/research_stage_changed`, no Research process starts, and its ordinary neighbor still executes. |
| Prelaunch cwd/config failure | Missing cwd retires the exact pending operation; config failure retires the admitted operation. Neither starts a process. A fresh consumer executes the untouched Research neighbor once without replaying the failed turn. |

Boundary limitations are deliberate and explicit: authentication identity is
stubbed in the permanent suite; the MCP Idea read is adapted to the real REST
Idea-detail handler over HTTP. Subprocess results, MCP config file creation,
transcript/new-session disk probing, usage and cwd validation are controlled test
boundaries. No LLM, SSE socket, Redis fan-out, historical CLI binary, or historical
server binary runs in this suite. For historical FIFO, a neutral envelope around
the complete saved instruction bypasses the current Waker's Research-prefix
detector, modeling the older ordinary batch behavior. The old-server adapter
strips only the new capability before invoking the real handlers. These adapters
are compatibility contract evidence, not a claim to have installed old binaries.
The existing 97 cases independently retain three-generation FIFO/origin rules,
direct stage changes, prefixless Research, rollback, transaction and admission
race coverage; T4 does not duplicate that entire suite.

Initial focused runs failed on harness assumptions (no project cwd preference,
canonical versus legacy prompt wording, fixture isolation and the current Waker's
Research detector). Those test issues were corrected before the passing run;
they were not production failures.

### Parent actual-server smoke

Parent-provided, independently executed evidence complements the auth/MCP
boundaries above:

- Harness: `/tmp/daemon-operation-live-cli.mjs`.
- User/browser fixture setup: `/tmp/daemon-operation-live-cli-create.cjs`.
- Saved fixture: `/tmp/daemon-operation-live-cli-fixture.json`.
- Result: `/tmp/daemon-operation-live-cli-result.json`.
- Commands: `node /tmp/daemon-operation-live-cli-create.cjs`, then
  `node /tmp/daemon-operation-live-cli.mjs` (parent-owned local acceptance setup).

The smoke uses actual Next `:8637`, real bearer authentication, ChorusClient/MCP,
LineageResolver, EventRouter, WakeQueue, Waker, REST reporter, real
`validateDirectory`, and the parent's local database `:5433`. Only subprocess
result and usage/new-session disk boundaries are stubbed; no LLM runs. The T4
worker read the saved artifacts and did not access or modify `:5433`.

Saved successful fixture Idea: `90e3bbc8-3192-41b9-bbea-488dd6f378c7`. Two
concurrent dispatches for each of three pending turns produce exactly three
serial process-stub launches, each after an exact HTTP 200 running admission.
The six running/ended requests all return 200 on original turn UUIDs:
`a169b3ab-fd5a-4ab1-8497-6d70aea06bd9`,
`39699f99-60a8-421f-a1c5-66a4f3bd658b`,
`6ff92048-cd07-48b7-ad68-1deb7910caaa`.
Reconnect pending is zero; actual session totals are 39 input / 21 output tokens.

Evidence precision: the supplied creation script sent `mode: "decompose"` but
the HTTP schema accepts `decompose: true`; the saved payload actually records
`mode: "elaborate", researchFirst: true`. Therefore this particular smoke proves
ordinary creation plus two Research requests. Decomposition is covered by the
permanent HTTP matrix and T3 browser evidence, not inferred from this script's
intended mode. The parent's initial harness omitted the required cwd validator
and correctly retired all three unstarted turns with crash/error evidence; adding
actual `validateDirectory` and using a fresh fixture produced the successful result
above. That was a harness correction, not a product failure.

The parent subsequently ran the corrected `decompose: true` setup and asserted
the returned operation payload plus the actual MCP Idea `isContainer` value.
Idea `c58d9da2-e897-4db5-beaa-3bdba813c8c8` records `mode=decompose`,
`researchFirst=true`. It and two Research requests also produced exactly three
serial process-stub launches after admission, six successful exact running/ended
HTTP reports, no reconnect replay, and database totals of 39 input / 21 output.
This is distinct decomposition evidence; the ordinary smoke above is preserved.
Commands: `node /tmp/daemon-operation-live-cli-decompose-create.cjs` followed by
`node /tmp/daemon-operation-live-cli-decompose.mjs`. The saved result is
`/tmp/daemon-operation-live-cli-decompose-result.json`. The initial additional
assertion on the compact creation DTO was corrected to read `isContainer` from
the full MCP Idea; that field is not present in the compact creation response.

### Final regression commands and counts

```sh
env -u REDIS_URL -u REDIS_HOST \
  RESEARCH_DATABASE_URL='postgresql://postgres:postgres@localhost:5435/postgres?sslmode=disable' \
  pnpm exec vitest run src/services/__tests__/daemon-operation-http.database.integration.test.ts

env -u REDIS_URL -u REDIS_HOST -u CHORUS_AGENT_PROFILE -u CHORUS_E2E_BASE_URL \
  RESEARCH_DATABASE_URL='postgresql://postgres:postgres@localhost:5435/postgres?sslmode=disable' \
  pnpm exec vitest run src/services/__tests__ src/app/api/daemon cli/__tests__ \
  src/components/agent-presence/__tests__ \
  src/components/__tests__/notification-popup.test.tsx \
  src/components/__tests__/research-action.test.tsx \
  'src/app/(dashboard)/projects/[uuid]/dashboard/__tests__' \
  src/i18n/__tests__/locale-parity.test.ts

pnpm exec tsc --noEmit --incremental false
pnpm exec eslint --no-ignore src/services/__tests__/daemon-operation-http.database.integration.test.ts
openspec validate add-daemon-operation-events --strict
git diff --check
# From packages/openclaw-plugin:
env -u CHORUS_E2E_BASE_URL pnpm exec vitest run
```

All commands passed. Focused suite: 1 file / 14 tests, no skips. Combined
server/API/CLI/component regression: **205 files passed, 3 files skipped;
4,924 tests passed, 16 skipped**, including all 111 real database cases.
The skipped tests are the unrelated registration, multipath, repoint and one
notification opt-in case. OpenClaw: **13 files / 202 tests passed**, one
live-stack file / 3 tests skipped. TypeScript and explicitly unignored test lint
have no diagnostics; OpenSpec strict and diff checks passed. Existing production
lint and OpenClaw typecheck evidence remain in the T1/T2/T3 records above.
Logs: `/tmp/t4-focused.log`, `/tmp/t4-regression.log`, `/tmp/t4-openclaw.log`,
`/tmp/t4-tsc.log`, `/tmp/t4-lint.log`, `/tmp/t4-openspec.log`.
No opt-in skip is represented as a pass.

T4 developer evidence maps to all four ACs: protocol/execution matrix and parent
live smoke (AC1); recovery, isolation, mixed queues, origin and stage cases plus
the existing 97-case suite (AC2); unchanged UI with T3 browser acceptance,
independent PASS `6b365ec0-d05a-4907-a024-b96c389e8d0f` and the explicit pen-only
waiver (AC3); the command results above and rollout guide (AC4). This is
developer evidence; independent T4 PASS `1470bb5e-82b5-4954-bce3-bee726a81b32` additionally reran all111 database cases,2665 CLI/UI tests,202 OpenClaw tests and static checks.

## UI and transcript

Automated UI/transcript checks passed: 35 files, 596 tests. Final targeted follow-ups
passed 50 tests and then 56 locale/notification/turn-band tests.

```sh
pnpm exec vitest run src/services/__tests__/daemon-session.service.test.ts \
  src/components/agent-presence/__tests__ \
  src/components/__tests__/notification-popup.test.tsx \
  src/components/__tests__/research-action.test.tsx \
  'src/app/(dashboard)/projects/[uuid]/dashboard/__tests__' \
  src/i18n/__tests__/locale-parity.test.ts
```

Coverage includes static and ad-hoc behavior, manual session selection, canonical
seq=0 pagination slots/cursors, retained real messages, historical synthetic prompts,
live overlap/deduplication, Research retry and repeated requests, and four-language
labels. Parent browser acceptance found two additional issues: focus fell to BODY
after keyboard creation, and synchronous repeated clicks could create two themes.
The tracker now restores the actual invoking button, with a fallback when SSE
replaces the empty-state button. A synchronous dispatch ref prevents duplicate
submission; two native clicks within one React batch fail before the fix and pass
after it.

Real-browser setup: `pnpm dev:local`, separate PGlite :5433 in
`/tmp/chorus-daemon-operations-e2e`, Next :8637, local default-auth login,
Playwright CLI session `daemon-operations`. The test agent's SSE receiver consumes
delivery notifications but never launches an agent. Fixtures are local only.

| Browser scenario | Observed result |
| --- | --- |
| Ordinary and theme creation | HTTP 200, localized submitted feedback, dialog closes, same URL, no automatic conversation. SSE refresh adds the Idea. |
| Four-language keyboard/focus | en/zh/ja/ko return focus to the localized New Idea button. |
| Theme repeated click | Two synchronous clicks produce one HTTP request and one Idea; canonical payload retains `mode=decompose`, `researchFirst=true`. |
| Research | Repeated intentional requests add distinct turns. Two synchronous activations add one turn. Queued feedback remains, no chat opens, focus returns to Actions. |
| Manual history | Existing entry opens the session list without a stale target; selecting the original Idea shows Create Idea/Research labels in all four languages. |
| Live status and messages | Actual local HTTP admission/terminal reports change the visible state to Running/Ended; appended real user/assistant messages each appear once. Compatibility system prompts are absent. These reports are acceptance fixtures, not real agent execution. |
| Existing open conversation | Research submitted from a second browser tab leaves the first tab's selected session open. Its Research bands refresh from 3 to 4; the submitting tab opens no conversation. |
| Failure and retry | A browser-intercepted 503 displays the error and retains description/selection. Activating the visible Retry button reaches the real endpoint, returns 200, and closes the dialog without opening chat. |
| Static creation | The original project Ideas endpoint returns 200 and opens the created Idea panel, preserving the static form's behavior. |
| Layout | Desktop 1440×1000 and narrow 390×844, light and dark. Narrow theme submission has no horizontal document overflow. |

Actual HTTP transcript reads against the local database with `limit=1` produce
seven pages: `(5,0), (4,0), (3,0), (2,0), (1,2), (1,1), (1,0)`. Five canonical
operation slots contain zero fabricated messages, and two real message rows retain
their original identities. Re-reading every page produces identical data. The final
page has `hasMore=false`. Evidence: `/tmp/daemon-operation-pagination-result.json`.

Local screenshots are under `.playwright-mcp/daemon-operation-events/` (gitignored):

- `baseline-auto-chat.png`, `baseline-research-auto-chat.png`
- `{en,zh,ja,ko}-create-final.png`
- `en-dark-narrow-decompose-form.png`, `en-dark-narrow-decompose-submitted.png`
- `en-dark-narrow-research-queued.png`
- `en-dark-manual-history-running.png`, `en-dark-manual-history-completed.png`
- `{en,zh,ja,ko}-light-history.png`, `ko-light-narrow-history.png`
- `en-light-submit-error-retry.png`, `en-light-open-history-research-refresh.png`

Browser execution encountered locator/animation timing failures while resizing and
switching locales; corrected scripts and stable screenshots supplied the evidence
above. A transient dashboard 404 occurred during concurrent Next Fast Refresh.
These observations are not counted as passing assertions or hidden by test totals.
`openspec validate add-daemon-operation-events --strict` passed on the final
unarchived change.

## Remaining gate and resumption

Approved T3 criterion `cda528e7-5165-4684-81cd-e32910422bbd`, technical design §5,
and `CLAUDE.md` require updating `docs/design.pen` through Pencil. Repeated
`pencil/get_app_state` calls failed with
`transport not connected to app: visual_studio_code`. No `.pen` file was accessed
through the filesystem, at the time of that gate. The later 08:18 UTC human instruction explicitly waives this file update for the current delivery.

The human waiver resolves the design-file gate. T3 has since passed independent
review and admin verification; T4's compatibility/recovery implementation and
checks are complete. T4 independent review/admin verification is now complete. Aggregate code review,
the completion report remain next. OpenSpec archive completed successfully at
`openspec/changes/archive/2026-09-27-add-daemon-operation-events/`; all six
cumulative specs were mirrored to their materialized Chorus Documents and passed
the supported `verify-document-roundtrip.sh` byte check.
Push and merge still require explicit human approval.

Deployment order and safe rollback boundaries are documented in
[the rollout guide](../deployment/daemon-operation-events.md).
