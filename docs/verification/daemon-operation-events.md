# Dedicated daemon operations — verification record

Date: 2026-09-27. Idea: `761b9e5d-7bbf-46e2-aff2-7ec1d3ac027c`.
Approved proposal: `4a917a0b-9fe8-4a29-ad0b-e685fca2da5d`.
Local branch: `feat/daemon-operation-events`, base `ecc31bfe`.

This is an interim verification record, not a feature completion report.
T1 (server) and T2 (CLI) passed independent task review and admin verification.
T3 implementation and automated checks are ready; browser evidence is recorded
below. Required Pencil design synchronization remains outstanding. T4 has not
started, and the final aggregate code-review gateway has not run.
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
through the filesystem, and no design waiver has been granted.

Restore the Pencil editor connection and save/review the design update, or obtain
an explicit human waiver recorded on the Idea. Then finish T3 self-checks,
submission, independent task review and admin verification; execute T4's full
compatibility/recovery matrix; run aggregate code review; archive/mirror OpenSpec;
and publish the completion report. Push and merge still require explicit human
approval.

Deployment order and safe rollback boundaries are documented in
[the rollout guide](../deployment/daemon-operation-events.md).
