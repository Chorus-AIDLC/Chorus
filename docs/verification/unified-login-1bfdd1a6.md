# Identifier-first unified login follow-up

Date: 2026-10-15. Idea `d5b5849c-c806-4f35-aacb-5346bd78e4ce`; follow-up task `1bfdd1a6-e100-431b-89af-74dcabac7293`. This fixes an original requirement missed by the deployed default-auth entry, rather than adding a new authentication method.

## Cause and implementation

`/login` still used `/api/auth/check-default` to show a password-first form when DEFAULT_USER was enabled, with a separate SSO toggle. A Superadmin/default collision even showed roles before identifying the visitor. Prior local-user tests disabled default auth and did not cover that deployed entry.

The page no longer fetches deployment defaults or preselects an auth path. Every unauthenticated entry accepts username/email and calls identify. Multiple paths require workspace/role selection; a single local/default match opens its password step and a single OIDC match redirects immediately. The existing SSO-only multi-workspace page remains the selection step, not a separate login entry. Default-auth identification works independently of the removed config-fetch state. The password-step identity is read-only; Back restores discovery and clears password state. Existing session recovery, Superadmin routing, local tenant-bound login and SSO login_hint are preserved. No auth API, database migration or SSE implementation changed.

Updated the durable specification, bilingual user guide and E2E skill so documentation does not prescribe the obsolete password-first entry.

## New automated checks

- Login, workspace-picker and identify scope: **56 passed**, four files.
- Final full suite: **11,203 passed / 245 skipped**, 477 files passed / 11 skipped (180.46 seconds).
- First concurrent full suite failed three pre-existing interactive-installer timeout cases while production build ran. Exact error: `RuntimeError("Interactive installer timed out")`. No assertion fix or timeout relaxation was made. Installer-only rerun: **145 passed**; complete rerun without concurrent build: all tests above passed.
- `pnpm exec tsc --noEmit`: exit 0, empty final log.
- `pnpm build`: exit 0, **67/67** static pages generated. Existing repository lint warnings remain.
- Scoped ESLint: zero errors; existing img warning and two ignored-test-file notices. Ignored files are not claimed as linted.
- `git diff --check`: passed.

New regressions cover default-auth on/off/collision first entry, no config fetch, default-auth single discovery/back/password clearing, single Superadmin and SSO routing, mixed local/SSO selection, SSO-only multi-match selection, and existing local identity/password/IME behavior.

## Real Playwright MCP acceptance

Used the new production build on loopback **8640**, retained disposable PGlite on **5435**, with explicitly overridden test default/Superadmin credentials and session secret. Did not use live deployment credentials, real `.env` values or production data. DEFAULT_USER enabled and Superadmin collision true were verified through the real check-default API.

Observed through actual browser interactions and real API/session responses:

1. Chinese login first screen had exactly one username/email input and Continue; zero password fields, no role picker and no separate SSO toggle despite enabled/colliding defaults.
2. Entering the default email showed the two collision paths only after identification. Selecting password and signing in reached onboarding with a real user session (200). Selecting Superadmin routed with the entered email and authenticated into `/admin`.
3. Bootstrapped test local workspaces and accepted invitations using real APIs in that isolated database. A single local username skipped selection; password login reached `/projects`, and session company matched the single workspace.
4. Email matching two local workspaces and one SSO suffix showed all three candidates before any password or redirect. Selected local workspace identity was read-only. Back/re-identify/reselect cleared a typed password; real login reached `/projects` with exactly the selected company UUID.
5. Selecting SSO from that mixed picker reached a **loopback-only mock IdP** `/authorize` with the intended client, callback and login_hint. A new SSO email matching only the configured suffix skipped selection and reached the same authorize endpoint. This proves discovery/configuration/redirect, **not external IdP authentication, token exchange or callback completion**.
6. Screenshot `.playwright-mcp/unified-login-identifier-first-zh.png` was opened and visually inspected; one unified identifier-first form, no password or SSO toggle.

Expected console HTTP failures were unauthenticated admin/session 401 probes and the fixture IdP's missing favicon 404, not uncaught application exceptions. Harness mistakes (wrong bootstrap link property and user-only logout not clearing admin auth) were corrected using the actual response shape and admin sign-out; they are not counted as successful checks.

Browser closed; the three test processes (app, disposable DB, mock IdP) stopped. Ports **5435/8640/8641** had no listeners. Retained disposable data is not a running resource. Real deployed services and other sessions were left intact.

## Review and delivery

Fresh independent Round 1 review `cdacc8e5-7406-47b7-8e78-b783d48b20fe` returned **PASS**, zero blockers/notes. The separate ephemeral reviewer process independently ran **97 focused tests**, a non-incremental type check, whitespace checks and **six additional probes of the actual current component's session-recovery effect**. It reviewed but did not rerun the parent full suite/build/browser evidence. No older review verdict was reused. Its pinned-pnpm sandbox launcher failed before tests; installed Node entrypoints successfully ran the full intended scope without installation or sandbox changes.

PR and default-deployment outcomes are posted on the originating Idea after the authorized delivery; this file records the pre-delivery validation of the code being shipped.
