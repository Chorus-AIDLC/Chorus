# User avatar acceptance evidence

Verified 2026-10-18 against the working tree for Idea `573c0f18-d9fe-4d47-802e-5d026aa0f9d3`, Proposal `030b0421-9de4-4cb9-8e71-1d122173ddff`.

## Isolation and migration

- Business service at port 18637 and its database were not modified. All browser writes targeted an owned PostgreSQL 17 container and a separate application at `http://localhost:38637`.
- `AVATAR_MIGRATION_POSTGRES=1 node --test scripts/__tests__/user-avatar-migration.test.mjs`: **14 passed**, PGlite 17.5 and PostgreSQL 17.11. Final rerun log: `/tmp/chorus-avatar-final-migration.log`.
- The suite applies all 48 prior migrations and the real new SQL, verifies failed-transaction rollback, legacy backfill, NOT NULL/database DEFAULT, fresh creation and old-writer rollback. Real pre-change Prisma 7.10 client emits 15 seed-omitting User INSERTs per engine. See `scripts/__tests__/user-avatar-migration.md` for reproducibility and limits.
- The browser database separately applied all 49 migrations using Prisma migrate deploy. Repeating `DATABASE_URL=<owned-test-url> pnpm exec prisma migrate deploy` reports **No pending migrations to apply**. Logs: `/tmp/chorus-avatar-e2e-migrations.log`, `/tmp/chorus-avatar-repeat-deploy.log`.

## Real browser acceptance

Playwright drove the actual authenticated UI and HTTP API, not mocked UI components. The only intercepted response was the explicitly injected save failure. The test account and password are disposable fixtures, not production credentials.

1. Chinese settings: randomize twice; distinct local previews, unchanged sidebar avatar, zero PATCH requests. Cancel restores the persisted preview.
2. Randomize again; intercept `/api/users/me/avatar` with HTTP 500. Localized failure feedback appears, draft remains, sidebar stays unchanged. Remove the interception and retry: exactly the same draft seed is sent and saved. Both sidebar and preview update immediately. Successful saved seed: `636dd55d-4f05-4f0b-835a-257d0e43a3b9`.
3. Reload settings: same loaded avatar and saved seed. Sign out through the UI; discover the disposable email, enter its password, sign in (new account returns to onboarding), then navigate to settings. `/api/session` still returns the saved seed for unchanged user UUID `dc6f0b04-f7f7-4195-ba35-f7e8b6d2ed8c`.
4. Randomize without saving and leave for the fixture task. Sidebar, Kanban assignee, detail assignee, comment input and historical comment author display **five loaded images with one identical SVG data URI**. Earlier real PATCH/read acceptance confirms historical comment and task DTOs return the current seed rather than a stored snapshot.
5. English settings keyboard: focus Randomize, press Enter, Tab reaches Save, another Tab reaches Cancel; Enter cancels and disables Save again. Status feedback has `role=status` and `aria-live=polite`.
6. At 375×812, dark theme: avatar card and wrapping controls fit; document scrollWidth = viewport width = 375. At 1440×1050, light theme: card and sidebar load. Mobile navigation opened from settings shows the same saved image (three loaded avatar elements, one unique URI), with no horizontal overflow.
7. Visible attribution names Personas, Draftbit and DiceBear with linked author, source and CC BY 4.0 license. Credit is localized, not repeated beside each small avatar. All avatar images use local SVG data URIs; saved network capture has no external avatar-service requests. The DiceBear JavaScript chunk is served locally.

Screenshots (gitignored, inspected during acceptance):
- `.playwright-mcp/user-avatar-settings-mobile-dark.png`
- `.playwright-mcp/user-avatar-settings-desktop-light.png`
- `.playwright-mcp/user-avatar-task-integration.png`

Network/console captures: `.playwright-mcp/user-avatar-network.log`, `.playwright-mcp/user-avatar-console.log`. Console findings were expected unauthorized session/admin probes at login/logout, the injected 500, development JSON hot-reload noise, and existing mobile Sheet missing-title/description accessibility warnings. The Sheet markup was not changed by this feature; these warnings are not hidden or claimed fixed.

## Coverage and regression

- `avatar-coverage-audit.md` and `project-avatar-audit.md` classify all existing human-avatar slots and retained semantic/text-only/Agent surfaces. Final source scan found no additional unconverted human identity avatar. Agent renderer/style/motion is unchanged.
- Real-module identity tests cover repeated actors and mixed types, company/project access boundaries, missing/deleted identities, historical current-seed reads, and normal other-user refetch. No per-avatar HTTP requests or per-row list identity queries are introduced.
- Independent task reviewers passed the persistence API, rendering, identity propagation and settings tasks. Identity review reran 475 tests and two independent stale-session/list-query probes. Settings review independently reran 58 tests, tsc and lint.
- Initial full Vitest run: 11,457 passed, 18 failed, 245 skipped. Seventeen failures were outdated mocks in two integration suites after switching to batch identity resolution; only those fixtures were updated. Both suites then passed all 127 tests. The remaining failure is the unrelated existing installer SIGHUP PTY timeout (`install-local.test.ts`); no installer files changed.
- Final rerun: `env -u DATABASE_URL -u DIRECT_URL pnpm exec vitest run --exclude 'src/lib/__tests__/install-local.test.ts'` → **493 files / 11,330 tests passed**, 11 files / 245 conditionally skipped, zero failures. The excluded installer file had 144 passing tests and the unrelated SIGHUP PTY timeout in the initial run. Log: `/tmp/chorus-avatar-final-vitest.log`.
- TypeScript passed independently during both task reviews. Final source `git diff --check` and `openspec validate user-avatars-personas-seed` passed. `DATABASE_URL=<owned-test-url> NEXTAUTH_URL=http://localhost:38637 pnpm build` completed successfully (all 68 static pages, TypeScript and ESLint gate included). Existing unused-symbol/hook/image lint warnings and the pre-existing rate-limiter dynamic-dependency warning remain; no build errors. Log: `/tmp/chorus-avatar-build.log`.

## Scope limits

No realtime synchronization for other sessions is promised; normal authorized refetch returns the new seed. This does not benchmark large-table migration locking or require a destructive database rollback. No image upload, manual seed field, old avatar URL compatibility toggle, production deployment, branch or commit was added.

## Final review and handoff

- Final task review `d76e101d-8c46-41de-92d5-583d225ed99e`: PASS, with 207 independently rerun tests, an independent PGlite probe and repeated authenticated production-build browser flows.
- Aggregate code-review gateway `fedeafe4-890b-4f41-8663-5da3ed938d2e`: PASS WITH NOTES, no blockers; 478 independent tests, TypeScript, targeted ESLint and real Origin/auth/validation/browser probes passed.
- Non-blocking review note N1 remains pending: `CLAUDE.md` requires updating `docs/design.pen` through Pencil. This session has no Pencil MCP tools or resources. The design file is unchanged; enabling Pencil or explicitly approving a deferral requires human action. No deferral is assumed.
- OpenSpec archive and both cumulative spec mirrors completed; exact-byte roundtrip verification passed. All 159 cumulative specifications validated without errors. The new user-avatar Purpose placeholder was replaced with the approved capability purpose and re-mirrored.
- Owned test server and PostgreSQL container were stopped/removed after reviews. Business service at port 18637 remained healthy (HTTP 200). Screenshots and logs remain available at the paths above.
