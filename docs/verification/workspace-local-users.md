# Workspace local users — verification

Date: 2026-10-15. Idea: `d5b5849c-c806-4f35-aacb-5346bd78e4ce`. Proposal: `6ea93f41-96bc-474b-94d1-8c9a87b6ff71`. Branch: `feat/workspace-local-users`. No commits, pushes, merges or production deployment performed.

## Status after external review

The original completion/archive and tests below are historical snapshots, not current merge clearance. Clay found R1 (global unknown-address throttle / spoofable ALB prefix), and Leo's independent Round 1 returned FAIL for open-SSE revocation and local Workspace detail editing. Follow-up tasks `52947ca5-a0bb-498d-bafd-59ca8b2c754d`, `d95ab903-a179-499f-9d31-80a0fb3e19de`, and `5c3909a6-4d59-4cc0-8562-52a8e8c64367` track fixes without reopening the original four done tasks. No passing historical review overrides these blockers.

### R1 patch evidence

- Before the fix, 19 new throttle regressions failed: default-mode unrelated attempts exhausted shared address buckets; spoofed left prefixes changed ALB identity; invalid/hop/IPv6/capacity checks failed.
- Fixed: identity/token-only fallback without trusted address, validated right-hand configurable proxy hop selection, bounded LRU storage without global capacity denial, token-hashed acceptance key. Malformed login bodies return401 without credential checks or a shared invalid bucket.
- Expanded regression: 10 files / 204 tests passed (9.82s), covering throttle/local-auth/identify/local-routes plus picker/login/session/API-key/OIDC/server-auth. Earlier focused patch run: 4 files / 108 tests passed. Expected negative-path ApiError logs are not failed assertions.
- Final combined root typecheck and whitespace checks passed after workers settled, and again after the acceptance hash follow-up. Scoped production lint: 0 errors / 1 pre-existing editor hook warning. Earlier concurrent typecheck saw transient notifications/SSE worker diagnostics; those failed intermediate snapshots are not claimed as passes.
- Clay's second read found acceptance hashing before token validation. Five new no-bcrypt regressions all failed before reordering (missing/expired/used/disabled/stale). Hashing now occurs only after authoritative token/account checks under the workspace lock, preserving atomic replay defense. Expanded follow-up: 5 files / 218 tests passed. A concurrent crypto run initially timed out the ten-comparison login test at 5 seconds; its realistic 15-second budget passed without relaxing assertions.
- Independent R1 Round 1 `9084c30c-5967-4da6-8814-267851a07bb9` returned PASS WITH NOTES, independently running 204 tests, types/CDK synth and additional capacity/token probes. It predates the acceptance follow-up; a fresh Round 2 is required before task verification. Native Agent spawning/closing failed with canonical-path collisions; separate ephemeral headless TRAE CLI reviewers are independent processes, not orchestrator self-review. Native MCP approval-never reads were blocked in those sessions, so reviewers used the authorized Chorus CLI fallback.
- CDK `tsc --noEmit` and offline `cdk synth --lookups=false` for ALB and CloudFront passed; emitted ECS environment assertions passed (ALB trust=true/hops1; CloudFront trust=false/hops2). No AWS deployment or credentials check executed. The private CloudFront origin listener admits VPC traffic, so two-hop trust remains off until that bypass is closed.
- English/Chinese operations guidance and `.env.example` document the exact `client, cloudfront`/hops2 selection and password-spraying/edge-limiter boundary. Bcrypt and process-local identity buckets are not edge enforcement.
- Fresh R1 Round 2 `c2ec4e2a-87f2-4012-8edb-6f25d408b972` returned PASS WITH NOTES: 218 tests/types plus 9 independent in-memory hash-order/post-lock mutation probes passed; no blockers. Clay's code-only recheck `bc92ecbe-4ad2-4e78-afcd-7e182f064c47` also returned PASS. Capacity-regression strength remains a nonblocking note (independent actual cap/LRU probe passes, committed tests primarily check availability).
- This patch has not re-run real HTTP/PGlite or Playwright MCP acceptance; previous browser evidence is pre-patch.

### B1 / B2 and final combined evidence

- B1 SSE revocation: `d95ab903-a179-499f-9d31-80a0fb3e19de`, independent Round 1 `38f3e19a-55b1-4dc5-9906-4f051fd83014` PASS. Reviewer independently passed 329 tests across 9 files, types/lint, and reproduced four leaks with old routes substituted only in memory. Real-auth route matrix (52 tests) covers both streams, human generation/owner state, queued deliveries, heartbeat and cleanup. See [SSE record](sse-revocation-d95ab903.md).
- B2 local editor: `5c3909a6-4d59-4cc0-8562-52a8e8c64367`, independent Round 1 `c600203f-1b3c-4976-ae4a-77df9507f1be` PASS. Reviewer independently passed 87 tests and types; original editor in-memory negative control produced two expected failures. See [editor record](workspace-detail-local-rename-b2.md).
- All three follow-up tasks passed AC self-check, independent task review and explicit task-admin verification; original four done tasks were not reopened.
- First combined suite: 11,144 passed / 245 skipped / 5 failed (256.09s). One crypto login case exceeded its old 5-second budget; now uses 15 seconds. Four daemon-turn access failures came from a minimal mock Agent lacking required `permissions`; adding `permissions: []` restored a valid fixture without weakening production authorization or assertions. Focused repair: 54 tests across 2 files passed.
- Final combined suite: `pnpm exec vitest run --maxWorkers=4`, `/tmp/chorus-post-review-full-regression-final.log` → exit 0; **11,154 passed / 245 skipped**, 475 files passed / 11 skipped, 263.09s. This is the post-patch result, not the historical 11,054 result.
- Post-patch production build: `pnpm build:local`, `/tmp/chorus-post-review-build.log` → exit 0, compiled in 55 seconds, 67/67 static pages generated. Scoped final production lint: 0 errors / 1 pre-existing editor hook warning; root types and whitespace checks passed.
- Aggregate follow-up Round 2 gateway `3e15231b-35e6-475a-b703-03dc832e2c61` returned **PASS WITH NOTES**, independently running the integrated 16-file / 570-test suite, final types and whitespace checks; all known blockers fixed, 0 new notes. It read the completed full-suite/build logs rather than claiming independent reruns. All prior product/deployment/tooling/test-strength notes remain explicitly open. No post-patch real DB/browser or PostgreSQL multi-connection validation claimed.

## Environment and isolation

- Disposable PGlite directory `/tmp/chorus-workspace-users-pglite`, database port 5435. Independent Next dev server port 8640, explicitly overridden test database/auth/origin settings. Real `.env`, `.pglite` and production database untouched.
- `DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:5435/postgres?sslmode=disable' pnpm exec prisma migrate deploy`: passed, all 48 migrations including the additive local-user migration applied only to this disposable database. Initial localhost/TLS-default attempt failed P1001; explicit IPv4 and disabled TLS succeeded.
- Chromium 155 driven through an existing external Playwright installation. No dependency installs needed. Browser/Pencil MCP unavailable; standalone Chromium was used rather than skipping browser verification.

## Observed verification

| Check | Command / artifact | Result |
| --- | --- | --- |
| Baseline full regression | `pnpm test` before implementation | 10,808 passed, 245 skipped; 465 files passed, 11 skipped |
| Backend/auth independent review | Task 1 and Task 2 reviewer comments | PASS; Task 2 independently ran 473 tests across 14 files and a clean typecheck |
| UI independent review | Task 3 Round 2, comment `1316c2c2-3368-4869-a7fb-433b47fc14a5` | PASS; 65 interaction tests across 5 files |
| Integration independent review | Task 4 comment `53666e1a-9aa1-4494-a834-b6f1c3fa502d`; reviewer HTTP/browser/focused logs under `/tmp/chorus-reviewer-*` | PASS WITH NOTES; independently repeated 51 HTTP checks, 24 browser groups, 311 tests across 11 files, clean tsc and lint (0 errors / 182 warnings); all six AC passed |
| Real HTTP/database/MCP lifecycle | `node scripts/verify-local-users.mjs` with documented isolation/test settings; `/tmp/chorus-local-users-integration-final.log` | 51 checks passed |
| Real browser | `node scripts/verify-local-users-browser.mjs` with documented settings and explicit Playwright module path; `/tmp/chorus-local-users-browser-verified.log` | 24 grouped checks passed across en/zh × light/dark |
| Full lint | `pnpm lint`; `/tmp/chorus-workspace-full-lint.log` | Exit 0; 0 errors, 182 warnings |
| Typecheck | `pnpm exec tsc --noEmit --incremental false`; `/tmp/chorus-workspace-final-tsc.log` | Exit 0, no diagnostics after final integration hardening |
| Patch / script syntax | `git diff --check`; `node --check scripts/verify-local-users{,-browser}.mjs` | Passed |
| Final full regression | `pnpm exec vitest run --maxWorkers=4`; `/tmp/chorus-workspace-full-regression-verified.log` | 11,054 passed, 245 skipped; 472 files passed, 11 skipped; 207.84 seconds, no failures |
| Aggregate code review | Idea Round 1 comment `d4758cf7-987a-46d5-8ce8-4358de5acb9b` | PASS WITH NOTES; main-orchestrator second-silence fallback after independent reviewer and one retry both exited `max_output_tokens` without a verdict; not an independent aggregate pass |
| Aggregate regression rerun | `pnpm exec vitest run --maxWorkers=4` | Exit 0; 11,054 passed / 245 skipped, 472 files passed / 11 skipped; 199.32 seconds |
| Aggregate type/lint/patch rerun | `pnpm exec tsc --noEmit --incremental false && pnpm lint && git diff --check` | Exit 0; no type diagnostics, 0 lint errors / 182 warnings, including four console warnings in new verification scripts |
| Production compilation | `pnpm build:local`; `/tmp/chorus-workspace-production-build.log` | Passed; compiled in 64 seconds, 67/67 static pages generated; existing lint warnings, no errors |

HTTP checks cover bootstrap, invitation acceptance/replay/expiry, username/email multi-workspace discovery, active-account wrong-tenant rejection, normalized duplicates, ordinary-user/Agent user-management denial, owner keys working before disable and rejected through REST/MCP afterward, reset acceptance/replay/expiry and session invalidation, suspended-invitation recovery, last-admin protection under concurrent requests, deletion tombstones and audit persistence. Fixtures are retained with explicit integration prefixes. The SQL expiry fixture uses an explicit JavaScript UTC timestamp rather than database `NOW()` because the isolated PGlite timestamp-without-time-zone representation differed from the Node clock; the corrected expiry tests passed.

Browser checks exercise real Superadmin creation/link copying, acceptance/no-referrer/token query removal, multiple-workspace selection/local password login, settings navigation and semantic theme state, invitation handoff, localized last-admin and duplicate mutation feedback. Screenshots are under ignored `.playwright-mcp/local-users-{en,zh}-{light,dark}-*.png`; credential fields are masked. English/light and Chinese/dark settings screenshots were also visually inspected. Early harness failures were fixed: client locale must be seeded in localStorage as well as cookies, and the footer Close selector must be scoped to avoid the built-in dialog close button. These were harness corrections, not silently skipped checks.

## Findings fixed during reviews

- Backend Round 1: disabling a passwordless invitation made the account unrecoverable. Enable now returns it to Invited with a fresh link; actual-service and HTTP regressions cover old-link invalidation and subsequent acceptance.
- UI Round 1: initial admin name was optional contrary to UI AC; English server errors bypassed localized guidance; duplicate/generic/network mutation rejection tests were absent. All corrected and independently passed Round 2.
- StrictMode effect replay could erase the acceptance token after URL cleanup. A once-ref guard preserves it, with a StrictMode success regression.
- Full regression initially failed: the legacy OIDC picker integration lacked the newly required local lookup fixture (3 failures), and the access inventory needed explicit classification of six new non-project routes (1 failure). Both adapted while retaining the real route/component tests. An unrelated installer SIGTERM/terminal-echo test also timed out under the initial full-suite load. The focused repair run passed 171 tests across 4 files, including all 145 installer tests, and the final full regression passed all 11,054 tests above without changing the installer implementation.
- An attempted `pnpm test --maxWorkers=4` was rejected by pnpm with `Unknown option: maxWorkers` before any tests ran. It is not a passing test run. The corrected `pnpm exec vitest run --maxWorkers=4` produced the final passing summary; the subsequent production build and typecheck independently exited 0.
- Next's development request logger initially included credential query URLs. Acceptance requests are now excluded through the supported logging filter; earlier temporary framework entries were redacted, and a nonsecret probe confirmed omission. Infrastructure/access-log redaction is documented separately; no-referrer does not redact proxy logs.

## Additional Playwright MCP acceptance

After the human requested MCP installation and local acceptance, the existing official `@playwright/mcp` 0.0.83 was registered in TRAE and successfully used through real MCP `tools/call` browser interactions. Additional bootstrap, invitation, password, administration, role/state, reset/replay, deletion, authorization and duplicate-tenant selection paths passed, with screenshots for en/zh × light/dark. See [the MCP acceptance record](workspace-local-users-mcp.md) for execution details, observed expected HTTP denials, sandbox/harness limitations and local-server handoff. This is additional evidence, not an independent aggregate-review rerun or a new full-suite result.

## Completion and archive

- All four Chorus tasks are `done`, with independent task reviews and admin verification. Aggregate Round 1 returned PASS WITH NOTES via the disclosed main-orchestrator second-silence fallback; neither failed independent aggregate reviewer produced a verdict.
- `openspec archive add-workspace-local-users --yes` succeeded and added 13 requirements to the cumulative spec. Archive: `openspec/changes/archive/2026-10-15-add-workspace-local-users/`. At archive time the only unchecked local item was completion housekeeping 4.4; it was checked after the report was created.
- The archive CLI generated a placeholder Purpose, causing the first additional strict validation to exit 1 with a warning. The cumulative Purpose was then authored; `openspec validate workspace-local-users --type spec --strict` passed.
- Cumulative `openspec/specs/workspace-local-users/spec.md` was mirrored via guarded CLI `--arg-file` to Document `3b298ce3-2bb3-4262-8d6f-02187e9af069`, version 3. `verify-document-roundtrip.sh` exited 0, confirming byte equality.
- Mandatory Chorus completion report: `f3518d5e-f804-406d-a637-d64600c441f1`. Tool-notification defect follow-up Idea: `04328e25-f433-452e-b450-1907f2877f22`; tracked separately, not repaired in this feature.

## Boundaries and follow-ups

- `docs/design.pen` was **not updated**: Pencil MCP is unavailable and the file is encrypted. No raw read/edit was attempted. This remains a tooling-dependent design-artifact follow-up, not a claim that it was completed.
- Process-local throttle is bounded but not a shared distributed limiter; multi-instance installations require a shared trusted edge limiter. Untrusted forwarding headers are ignored by default.
- Concurrent HTTP requests and final-admin persistence were verified on PGlite. Its single-connection pool serializes operations; this is not a PostgreSQL multi-connection lock-contention proof. The implementation uses workspace row locks; deployment-specific PostgreSQL concurrency validation remains recommended.
- Invitation/reset delivery is explicit administrator copy/share through a trusted channel, not automatic email. Both link purposes expire after 24 hours. Initial UI admin name is required; general API display-name DTOs remain optional.
- Fixed Workspace Admin only; existing SSO identity management and project/business access remain unchanged. No configurable RBAC, self-registration, self-service forgotten-password email, or global Superadmin daily user CRUD added.
- Production migration, push, PR merge and release remain outside this authorized run.
