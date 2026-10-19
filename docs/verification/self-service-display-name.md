# Self-service display-name verification

Idea: `84b4a814-9448-4c1f-b2a0-2cd5f72982dd`

Proposal: `72410b75-8ba1-4ac7-8b79-6ceebea44984`

Task: `3c6a841b-0a4e-4c27-ab32-8c59145da0b2`

Base revision: `30db2212e4e54549f9be07f9e085a17c68bac855`

## Scope and authorization

The user selected trimmed 1–32 Unicode code points, mandatory non-empty names, settings-page editing for all ordinary users and persistent overrides for OIDC. YOLO round 2 preserves existing names and other admin/invitation write policies. The human instruction “豁免design.PEN” explicitly waives only the Pencil design artifact; textual design and both-theme acceptance remain required. The initial implementation completed without a commit or push. The subsequent human instruction authorizes a PR targeting `develop` and saved-script local deployment, with Clay reviewing; it does not authorize merging.

## Automated verification

- Shared validation, self-name service/API, OIDC subject/email linking, fresh session reads, editor/context and avatar identity tests run with Vitest.
- Backend worker additionally ran local-user/OIDC/auth/avatar regressions: 260 tests in one run and 324 in a second overlapping run, all passed. These counts are not additive.
- `node --test scripts/__tests__/display-name-migration.test.mjs`: 6 tests passed on disposable PGlite. Runs the real migration chain, verifies every legacy field is unchanged, defaults/non-null constraints, fresh installation and both self-save/OIDC write orderings.
- `pnpm exec prisma generate`: passed. `pnpm exec tsc --noEmit`: passed after adding the required default flag to the existing local-user fixture and narrowing optional auth safely.
- Targeted ESLint: no errors; the dashboard layout retains two pre-existing `@next/next/no-img-element` warnings. No unrelated warning cleanup.
- Final focused run: 10 files, 177 tests passed, covering the validator, service, route, OIDC, session, editor, context and avatar identities.
- Initial full suite: 11,598 passed, one failed, 245 skipped. The failure identified a missing classification for the new name route in the explicit API access inventory. Added the self-only/tenant-scoped/same-origin entry; all eight inventory tests then passed. This was a related omission, not an unrelated baseline failure.
- Final full run: `pnpm exec vitest run --maxWorkers=4` exited 0, with **499 files / 11,600 tests passed**, 11 files / 245 tests skipped, no failures (249.38 seconds). The opt-in database integration suites remained skipped; the feature's dedicated disposable PGlite migration tests ran separately.
- Independent task review passed after rerunning 185 focused tests plus 6 migration tests. Final aggregate code review passed after rerunning 128 focused tests plus 6 migration tests. These overlapping counts are not additive.
- OpenSpec change archived to `openspec/changes/archive/2026-10-19-self-service-display-name/`; cumulative spec mirrored to Chorus Document `1d59da43-93e1-40dd-8a6c-349870e7f584`. The supported roundtrip verifier confirmed exact-byte agreement for the PRD, technical design and cumulative spec.

## Real-browser acceptance (2026-10-19)

Environment: source dev server on `http://localhost:8637`, started with `PGLITE_DIR=.testdata/display-name-e2e pnpm dev:local`. This is an isolated, gitignored local database; no production workspace data was changed. Login used the configured default-auth test user. Credentials are not reproduced here. After login returned 200, the browser remained on the login page; navigation to `/settings` established the authenticated page. No login-flow changes were made.

Playwright MCP results:

1. Name editor appears immediately below avatar settings with a labeled input, helper text and trimmed code-point counter.
2. 33 single-code-point emoji disable save; 32 emoji are accepted and persisted even though they occupy 64 UTF-16 code units. `/api/session` returned the exact saved value.
3. Saving `  小明  😀  ` stores `小明  😀`: outer whitespace removed, inner spaces retained. Sidebar name updates without refresh. Reload retains the value.
4. Direct authenticated requests bypassing the UI reject whitespace-only, 33 emoji, extra actor/tenant fields, NUL and an unpaired surrogate with 400. A foreign Origin receives 403. None changes the saved name.
5. A deliberately intercepted 503 response keeps the draft and old sidebar identity. Removing interception and retrying succeeds; the fixture name is then restored to `小明  😀`.
6. Desktop light and dark screenshots were visually inspected: name input, helper text, count and buttons remain readable with semantic colors. English mobile layout at 390px was inspected; the editor fits without horizontal document overflow.
7. Missing-session 401s during unauthenticated login and the deliberately simulated 503 are expected console entries, not hidden failures. OIDC identity-provider behavior and local-account authorization are covered by service/route regression tests, not claimed as live external-IdP browser tests.

Local screenshot artifacts (gitignored):
- `.playwright-mcp/display-name-light.png`
- `.playwright-mcp/display-name-dark.png`
- `.playwright-mcp/display-name-mobile-en-dark.png`

## Operational notes

Deploy migration `20261019094000_self_service_display_name` before updated application code, regenerate Prisma and restart cached application processes. Existing data is retained; no reset-to-IdP control or cross-client realtime propagation is introduced. Rolling back to old OIDC code resumes provider overwrites even if the additive column remains.

The owned browser session, dev server and isolated PGlite process were stopped after verification. Gitignored screenshots and disposable test database remain available locally.
