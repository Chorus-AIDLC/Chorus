# Workspace local users — Playwright MCP acceptance

Date: 2026-10-15. Requested after the original completion report by the human on Idea `d5b5849c-c806-4f35-aacb-5346bd78e4ce`. Branch: `feat/workspace-local-users`. This is additional real MCP browser acceptance, not a replacement for earlier independent reviews or a new full-suite test run.

## Installation and execution

- Official `@playwright/mcp` **0.0.83** was already installed globally; Chromium 155 was already available. Registered a new enabled `playwright` stdio server through `trae-cli mcp add`. No project dependencies or lockfiles were changed.
- Command: absolute Node executable and official package `cli.js`, with `--headless --isolated`, explicit Chromium executable, `--viewport-size 1440x1000`, and output directory `.playwright-mcp`. `trae-cli mcp get playwright` confirmed enabled stdio registration.
- The current session did not hot-load newly registered native MCP tools. A temporary loopback bridge connected to **that same official stdio MCP server**, performed `initialize`, `notifications/initialized`, `tools/list`, then real `tools/call` requests. Browser interaction used `browser_navigate`, `browser_snapshot`, `browser_fill_form`, `browser_click`, `browser_evaluate`, `browser_take_screenshot` and `browser_console_messages`. This was not a rerun of the standalone Playwright script.
- First browser launch failed with Chromium `No usable sandbox` under this host's AppArmor/user-namespace restrictions. Added `--no-sandbox` for this isolated local test browser; did not change system AppArmor settings. Do not use that configuration to browse untrusted sites.
- Started the retained disposable PGlite database `/tmp/chorus-workspace-users-pglite` on **5435**, and the previously verified production build locally with `next start --port 8637`. Explicitly overrode database URL, local origins, session secret and test Superadmin credentials; disabled default fallback login. This is a local compiled server, not a new development-server build.
- `GET http://localhost:8637/login` returned **200** before browser actions. Real `.env`, `.pglite`, production data and actual user credentials were not used or altered.

## Observed acceptance

All paths below were exercised in the MCP browser, with accessibility snapshots and observed result state. API checks were made through MCP `browser_evaluate` using the real browser session. Only the final tombstone/audit corroboration used a separate read-only database query.

| Path | Observed result |
| --- | --- |
| Superadmin login | Chinese UI login redirected to `/admin`; English login also succeeded later |
| Local Workspace bootstrap | Selected local-auth radio, entered required initial admin name, created `MCP E2E Workspace 20261015` and received a real invitation link/expiry |
| Invitation handoff | Copy buttons produced copied feedback; UI explicitly states no automatic email |
| Acceptance privacy | Token query removed from address bar; referrer metadata is `no-referrer` |
| Password validation | Short password rejected with visible Chinese guidance; same invitation then accepted a valid password |
| Explicit login | Logged-out member acceptance landed on `/login`, with no automatic local session; initial admin acceptance occurred while the pre-existing Superadmin session was still present and therefore returned to `/admin` via the existing login redirect |
| Username/email login | Initial admin logged in by username; ordinary member logged in by email; authenticated identity matched the selected account |
| Onboarding | Fresh admin reached onboarding; clicked the actual skip control and reached `/projects` |
| Admin navigation and list | Admin saw the Workspace users navigation and current user rows |
| Ordinary-user restriction | Member did not see admin navigation; direct `/settings/users` displayed access-denied guidance; GET `/api/workspace/users` returned **403 FORBIDDEN** |
| Last effective admin | Confirmed sole-admin revocation attempt; request rejected, role preserved and Chinese actionable error remained in the confirmation dialog |
| Duplicate identity | Editing member to the admin's username rejected with **409** and localized conflict guidance; edit dialog remained open |
| Profile update | Corrected username and changed display name; saved row showed updated name |
| Role grant/revoke | Granted member Workspace Admin, observed persisted role; revoked it, observed Member again |
| Disable/enable | Disabled member, observed disabled row and **401** login despite valid password; enabled member, observed Active again |
| Password reset | Issued and copied reset link, accepted through UI, landed on explicit login |
| Reset replay | Reusing consumed reset link displayed invalid/expired/used guidance and did not change credentials |
| Old/new password | Old password failed with generic Chinese error; new password successfully reached `/projects` |
| User removal | Confirmed Remove user; member disappeared from active list and new valid password could no longer log in (**401**) |
| History retention | Read-only SQL found the original member UUID with `status=deleted`, non-null deletion timestamp, null password hash and sessionVersion 9; ten lifecycle audit records including removal remained |
| Duplicate identity across tenants | Created `MCP E2E Workspace B 20261015` with the same admin username/email; both username and email discovery offered two explicit Workspace choices |
| Selected tenant authentication | Original tenant's password did not authenticate the still-invited B identity; selecting the original tenant succeeded and returned to its user list |
| Locale/theme | Switched actual UI controls through Chinese/English and light/dark; screenshots captured all four combinations; evaluated semantic class (`light`/`dark`) and no horizontal page overflow at 1440px |
| Final browser console | Final authenticated management-page navigation reported **0 errors, 0 warnings** |

Earlier console resource errors were observed and are not hidden: unauthenticated `/api/admin/session` and `/api/session` probes returned 401; deliberately denied management/login/credential operations returned expected 403/409/401/400 responses. No uncaught application exception was observed. Two harness selector mistakes (invalid exact-attribute syntax and English `Sign in` versus `Sign In`) were corrected using fresh snapshots; neither is counted as a successful action or as an application defect.

## Screenshot evidence

Saved under ignored `.playwright-mcp/`, not uploaded externally:

- `mcp-e2e-zh-light-bootstrap.png` — invitation value visually redacted before capture.
- `mcp-e2e-zh-light-last-admin.png` — localized protection failure.
- `mcp-e2e-zh-light-member-denied.png` — ordinary-user denial.
- `mcp-e2e-zh-light-reset-link.png` — reset value visually redacted.
- `mcp-e2e-{zh,en}-{light,dark}-users.png` — all four locale/theme combinations.
- `mcp-e2e-en-light-removed.png` — active list after removal.
- `mcp-e2e-en-light-workspace-picker.png` — explicit tenant selection.

Chinese/dark and English/light screenshots were opened and visually inspected: table/controls are readable, semantic theme colors consistent, and no viewport overflow was observed. Auto-generated snapshots from this run were scrubbed of token query values and test password strings before handoff.

## Boundaries and handoff

- This new MCP pass covers the UI lifecycle and selected real authorization/password requests above. It does not newly prove live external IdP SSO, production reverse-proxy behavior, owned-Agent permission/revocation paths or multi-connection PostgreSQL locking; previous isolated HTTP/MCP tests cover the relevant local owner paths.
- Minor existing wording remains: create-company subtitle mentions OIDC even after choosing local auth, and multi-role/back prompts say email when the input may be a username. Neither blocked any tested flow; no application implementation edits were made in this acceptance-only request.
- Playwright registration is retained for future sessions. Browser/temporary bridge are closed after acceptance. Local isolated Chorus **8637** and PGlite **5435** are left running for human inspection, as requested; no permanence across daemon/process shutdown is promised.
- No commit, push, merge, release, production migration or production deployment was performed.
