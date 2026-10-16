# Local login UX correction — 1f9cc3b1

## Scope and intent

Follow-up to Idea `d5b5849c-c806-4f35-aacb-5346bd78e4ce`, approved Proposal `6ea93f41-96bc-474b-94d1-8c9a87b6ff71`, human comment `3e120151-59a2-415d-abc2-76376840d3b8` (2026-10-16). Baseline `8ce8a1d3`; implementation task `1f9cc3b1-c26a-4752-8fcb-f9f61f8b3080`, delivery task `c5dcdb83-fdc7-4924-8bdc-3a3d955bb539`.

- Accept passwords with **8 Unicode characters**, no character-class complexity requirements; retain bcrypt work factor **12** and maximum **72 UTF-8 bytes**.
- Invite/reset acceptance displays live satisfied requirement count and individual checkmarks. Both inputs independently show/hide via the existing Superadmin ghost-icon interaction, with accessible labels and pressed state; local sign-in uses the same interaction.
- Restore the existing `login/pick-workspace` visual vocabulary: 440px card, p-10 content, logo/22px heading, colored 40px initials icons, name and secondary line, arrows, identifier footer. That original page was not redesigned. Unified local/mixed options now reuse its styling; default/Superadmin collision options remain distinguishable.
- Keep identifier-first discovery, single-candidate bypass, explicit multi-candidate selection, frozen selected identity, and cleared/hidden passwords on back. Do not change N5 automatic-admin selection or SSE behavior.

## Automated evidence

```sh
./node_modules/.bin/vitest run src/services/__tests__/local-user.service.test.ts \
  src/app/login/__tests__ src/app/login/pick-workspace/__tests__ --maxWorkers=2
# 4 files / 162 tests passed
./node_modules/.bin/tsc --noEmit --incremental false
# exit 0, no diagnostics
./node_modules/.bin/vitest run --maxWorkers=2
# 477 files passed / 11 skipped; 11,229 tests passed / 245 skipped; 303.81s
pnpm build:local
# compiled successfully; static pages 67/67; production route table generated
```

Full suite and build ran **serially** (`&&`), not concurrently. Scoped ESLint: zero errors, existing img warning and three ignored-test-file warnings. English/Chinese/Japanese/Korean locale schemas and translated policy/interaction strings updated together. Service tests exercise actual invite/reset acceptance and bcrypt comparison at eight characters; boundary tests distinguish Unicode character length from UTF-8 byte length.

### First-run failures retained

- Before implementation: new red tests reported **10 failures** against the old 12-character policy/missing feedback and visibility controls.
- First green attempt: two preexisting picker assertions looked for the old single-line text. They now query the unchanged accessible button name; additional assertions cover actual name/subtitle/icons/card width. Final focused run passed all 162 tests.
- First type check: four unsupported `exact` role-query options plus missing new keys in ja/ko locale schemas. Removed the unsupported test options and translated the keys; final type check passed.
- First programmatic browser launch used cached Playwright expecting missing Chromium revision 1243. It failed before visiting the app. Retried using the already-installed matching Playwright/Chromium 1247, without dependency installation.

## Real browser evidence

Isolated production app on loopback **8640**, retained disposable PGlite on **5435**, explicit test Superadmin/default credentials and session secret. No real deployment credentials or production data used. Disposable schema: 48 migrations, up to date.

Playwright MCP manually verified Chinese rendering and actual DOM state:
- blank → 7 characters → 8 characters changed live status **0/2 → 1/2 → 2/2**;
- password and confirmation independently toggled text/password; controls did not submit;
- mixed local/SSO discovery showed three colored icons, two-line candidates and **440px** card, **zero password inputs** before selection;
- local selection froze identifier and supplied password eye button;
- back followed by single local match skipped picker and restored an empty, hidden password.

Screenshots captured and visually inspected (gitignored): `.playwright-mcp/ux-password-progress-zh.png`, `.playwright-mcp/ux-workspace-picker-zh.png`. Console contained only the three expected unauthenticated admin/user-session 401 probes, no unexpected JavaScript error.

Programmatic **en/zh × light/dark** browser suite passed **28 grouped checks**. It created disposable local workspaces through the real Superadmin UI, used invitation and reset links with eight lowercase characters, exercised live feedback/independent visibility, checked restored 440px/two-line/icon picker, logged into the selected workspace, and retained last-admin/duplicate-error/settings regressions. Production API invite/reset acceptance returned 200 in all four combinations. Screenshot `local-users-zh-dark-workspace-choice.png` was also visually inspected. The script closes all contexts and the browser in `finally`.

## Review, delivery and cleanup

Browser contexts are closed; the isolated app and disposable DB started by this round were stopped. Verified no listeners on 5435/8640/8641; normal app/DB/HTTPS deployment containers remained healthy. Native Agent launch failed before creating a reviewer (`/root/euclid` already exists); a fresh ephemeral read-only `trae-cli` process explicitly mounted `chorus:chorus-task-reviewer` instead. That first CLI round independently passed tsc but could not initialize Vitest temporary directories or use Chorus MCP under its read-only approval profile, so its FAIL/environmental blockers were preserved in Task comment `fedc6fb4-4166-4d1c-af96-12998222e788`, not silently discarded. A fresh noninteractive retry retained strict read-only review instructions and denied Edit/Write while permitting test-generated caches and Chorus I/O. **Round2 direct Task comment `3dc2706c-be28-4d6d-ab7e-f5a70793cf45`: VERDICT PASS, zero blockers**, independently **162 tests / 4 files**, tsc and diff-check passed; both prior environmental blockers explicitly marked fixed after successful live context reads/tests. It did not independently rerun the full suite/build/browser and did not modify files, task state or services. Both reviewer CLI processes completed. PR/CI/default-deployment final evidence is tracked separately in delivery Task `c5dcdb83-fdc7-4924-8bdc-3a3d955bb539`. No merge is authorized. External IdP authentication and SSE/Redis load tests are outside this UX-only correction and were not rerun.
