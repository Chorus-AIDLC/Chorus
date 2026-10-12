# Portable self-host guide — local validation

## Follow-up: explicit PG16 to PG17 migration (2026-10-12)

This follow-up uses disposable synthetic databases only, not the previously
restored real dataset. New deployments still default to PG17; no automatic
major-version selection or production cutover was added.

- `CHORUS_TEST_PG_UPGRADE=1 pnpm exec vitest run src/lib/__tests__/postgres-upgrade.test.ts`
  exercises the real isolated path as well as contract tests. Requires cached
  PG16/PG17 Alpine images and a Chorus image with the Prisma migration CLI
  (`CHORUS_TEST_MIGRATION_IMAGE`, default `chorus-local:chorus-local`). The real
  test is opt-in; ordinary CI runs the mocked safeguard tests without it.
- Created a disposable PG16 cluster, applied this checkout's Prisma migrations
  using a cached local Chorus image's CLI and a read-only migration-directory
  mount, then seeded JSONB/Unicode, arrays, bytea and a nontrivial sequence state.
- PG17 failed to open a **throwaway copy** of the stopped PG16 volume with
  `database files are incompatible with server`. No original volume was exposed
  writable to that experiment.
- The new script copied the original read-only, dumped from its isolated PG16
  working copy and restored into a fresh isolated PG17 volume. Public table row
  counts and sequence states matched. The fixture's full values and every Prisma
  migration checksum matched; the next generated sequence ID was correct.
- The original PG16 volume restarted successfully, retained its fixture values
  and migration checksums, and reported major version 16. All test-owned helpers
  and volumes were removed by test teardown; the migration script itself never
  deletes volumes.
- Safeguard tests cover active/missing/wrong-version sources, existing target or
  helper resources, inventory errors, volume ownership changes, private-file
  permissions, explicit offline acknowledgement, repeat refusal, unsupported
  schema, restore failure and count/sequence mismatch. AWS reuse now rejects local
  or unmarked wrappers without renaming `default_deploy.sh`.
- Existing local app, PG17 database and independent Cloudflare connector retained
  their pre-test start times; no deployment, source credentials, public route or
  restored application data was changed.

Scope: same-host official-image/default-layout, single public-schema database,
explicit operator-maintained downtime. This is not a full app login/OIDC/public
Tunnel test after upgrade, a zero-downtime migration, a custom-extension/role/ACL
migration, or a general cross-version application rollback guarantee. See
[migration and cutover instructions](../POSTGRES_UPGRADE.md).

## Result and scope

**Local guide/configuration validation: PASS, 2026-10-11.** This is evidence for
the portable [English](../SELF_HOST.md) / [Chinese](../SELF_HOST.zh.md) guide,
not a claim that a workstation-specific production deployment or the public
Cloudflare path has been accepted. No production data, existing containers,
DNS records, Cloudflare resources, or global daemon profiles were modified.

The tested application was an already available **locally built image**, not a
freshly pulled official release. A Docker Hub manifest request failed with a
registry connection refusal. That does not establish whether any release tag
exists, and this record does not certify a published `0.22.1` image.

## Exact fixture

| Component | Observed value |
| --- | --- |
| Repository base | `37d62d9a91223eddb2b04e6e5004d7c520839297` plus this uncommitted guide/config change |
| Host class | Linux x86_64; not a minimum hardware specification |
| Docker Engine / Compose | 29.8.2 / v5.6.0 |
| Application image | Local `chorus:prisma-fix`, package version **0.22.0**, Node **v22.23.3** |
| Application image ID | `sha256:fba0a2517371403317290ea521ed5e3678c1f09f10de74e10d78e6fac6f284ab` |
| Database image | `postgres:16-alpine`, PostgreSQL **16.15** |
| Database image ID | `sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea` |
| Foreground test daemon | Repository CLI **0.22.1**, host Node **v24.21.0** |
| Source project / loopback port | `chorus-guide-20261011` / **18637** |
| Restore project / loopback port | `chorus-guide-restore-20261011` / **28637** |

These names, image tags and ports identify this fixture only. Readers choose
their own unused project names, available tested images and ports. Image IDs
above are local Docker identities, **not registry pull digests**.

Fresh random database/bootstrap passwords, fresh project-scoped volumes and
fresh disposable application records were used. Private env files, cookie/API
credentials, daemon logs and backups were retained in a mode-0700 directory
outside the checkout; secret files are mode 0600. None of their contents are
included here. At the end of the initial run the app/database were running with
`restart: unless-stopped`; the foreground test daemon exited. The restore
project was brought down **without `-v`**, retaining its disposable volumes.

The pre-existing unrelated `node:22-alpine` container remained running with the
same container ID, name and image. No existing volume or database was reused.

## Reproducible checks and observed results

Use the guide's `dc` and `restore_dc` functions with your own protected env file.
The fixture substituted the project/port/image values listed above and used
`--pull never` because those exact local images were already present.

| Check | What ran / what was observed |
| --- | --- |
| Configuration contracts | `pnpm exec vitest run src/lib/__tests__/self-host-compose.test.ts`: **10/10 passed**. Real Compose rendering checks base/local/Tunnel topology, required inputs, loopback binding, secret-file wiring and absence of `DB_HOST`. Requires Docker Compose CLI, not a running daemon; suite skips if CLI is unavailable. |
| Related regressions | Same command including `src/lib/__tests__/docker-ensure-secret.test.ts` and `src/lib/__tests__/cookie-utils.test.ts`: **69/69 passed**. |
| Static guide validation | All **18** Bash blocks parse with `bash -n`; English and Chinese command blocks match. `git diff --check` and `pnpm exec eslint --no-ignore src/lib/__tests__/self-host-compose.test.ts` pass. |
| Fresh stack | `dc config --quiet`, then `dc up -d --pull never --wait --wait-timeout 180`: app and database healthy after the TLS correction below. App bound only to `127.0.0.1:18637`; database port was not published. |
| Health and login | `GET /api/health` returned HTTP 200 and `database: connected`. `POST /api/auth/default-login` with private fixture credentials returned HTTP 200 and an HttpOnly `user_session` cookie without `Secure`, matching local HTTP mode. Browser login page rendered; authenticated checks below used HTTP requests, not a claimed end-to-end browser login. |
| Authenticated REST | Created a disposable project, agent, API key and idea using the documented REST authentication. Private cookie/key values were kept out of output. |
| MCP | Authenticated `/api/mcp` initialize, initialized notification and `tools/call` for `chorus_checkin` succeeded with JSON-RPC/tool error checks. Accepted JSON and SSE response framing; HTTP 200 alone was not treated as success. |
| Incremental SSE | Opened authenticated `/api/events`, observed `text/event-stream` and initial connection comment, then created an idea in an accessible project. Its UUID arrived in an incremental event before the 15-second bound, not merely when the stream closed. |
| Daemon connection/reconnection | Ran the real repository `chorus daemon --agent codex --chorus-only --cwd <fixture> --browse-root <fixture>` with a separate HOME and explicit private daemon/settings paths. `/api/agent-connections` showed online. After `dc restart app db` and health recovery, the same test daemon registered online with a **new connectedAt** generation. Private daemon log had reconnect activity and no unauthorized/forbidden/invalid-key error. No task was assigned to launch a model/backend. |
| Restart persistence | After app/database restart, the original cookie still authenticated and the sentinel project UUID remained present. |
| Protected backup | Stopped app writes; ran `pg_dump -U chorus -d chorus -Fc`; archived `/app/data` via `dc run --rm --no-deps -T --entrypoint tar app -C /app/data -czf - .`; preserved private env; restarted source app. Binary dump/archive were saved without text conversion. |
| Independent restore | Started only the new project's database; piped dump into `pg_restore -U chorus -d chorus --exit-on-error`; extracted app-data with the app entrypoint bypassed; only then started the restored app. Source and restore use distinct volumes/network/port. |
| Restored consistency | Restored app healthy; original signed cookie authenticated; sentinel project and idea UUIDs matched; source/restored `.secret` SHA-256 checksums matched without exposing secret contents. |
| Container replacement | `dc up -d --pull never --force-recreate --wait --wait-timeout 180 app`: same image, persistent signing checksum, valid original login, and retained sentinel project. **Not** a cross-version migration/rollback test. |

## Failure found and corrected

The first draft used `DB_HOST`/`DB_*` to construct the local database URL.
Migrations completed, but the application's health check failed with
`The server does not support SSL connections`. Inspection of `src/lib/prisma.ts`
confirmed that setting `DB_HOST` enables TLS, while the default PostgreSQL
container has no TLS server configuration. This was a real runtime failure,
not a successful initial deployment.

The final Compose example uses an explicit internal `DATABASE_URL` with
`sslmode=disable` and does not set `DB_HOST`. The contract test now asserts both
conditions. Both guides explain that this is confined to the same-host private
Docker network, not appropriate for an untrusted remote database connection.
Health, protocol, restart and restore checks above were rerun successfully
against that corrected configuration. No application business logic changed.

## Explicitly unverified / follow-up checks

| Check | Why not executed | How to complete |
| --- | --- | --- |
| Published release image | Docker Hub registry connection refused; only local image available | Pull an existing selected official release/digest and rerun this matrix, recording actual image identity. |
| Public Named Tunnel / DNS / HTTPS / secure cookies | User did not supply a hostname and user-created Tunnel token; no cloud-write permission was inferred from YOLO | Follow guide section 3B with the user's private token file and origin `http://app:8637`; verify HTTPS/browser login, no host ports and `Secure` cookies. |
| Real cloudflared token-file readability / connector startup | No supplied token; no cloudflared image ran | Check selected image version ≥2025.4.0, directory/file permissions and successful connector startup without printing token. Compose syntax/secret wiring passed, not live connector authentication. |
| API/MCP/SSE through Cloudflare and connector recovery | Same public prerequisites unavailable | Repeat section 5 against the public URL, verify non-HTML MCP responses and incremental events, inspect cache bypass, interrupt/restart connector and verify recovery. Local streaming/reconnect success is not edge-path proof. |
| Cloudflare Access integration | No Access application/policy supplied; interaction is not enabled by default | If used, validate non-browser credentials and browser/CLI/MCP/SSE behavior under the exact policy; do not assume an interactive challenge is transparent. |
| Team OIDC | No test IdP/company OIDC configuration supplied | Use the documented admin/company setup and separate users; validate callback/logout/refresh at actual external origin. Bootstrap login is not a team identity acceptance test. |
| Model-backed daemon wake | Probe intentionally registered a new unassigned test agent only; no model credentials/backend launch or task automation authorized for this disposable instance | With a deliberately configured backend and dedicated disposable task, verify wake/report/interrupt separately. Real daemon transport connection and reconnect were executed. |
| R2 encryption/upload/download | R2 was selected as optional documentation only; no Bucket or credentials provided | Choose a backup/encryption tool, protect recovery keys, apply retention, download/decrypt and repeat isolated restore; confirm current billing before provisioning. |
| Cross-version upgrade/schema rollback | No second compatible app image available; same-image recreation only | Take a pre-upgrade backup, use a selected target release, validate migrations, rehearse matching old image + restored backup in isolation before any cutover. |
| Host reboot / other platforms / capacity | No host reboot authorization or load target; one Linux fixture only | Plan a separate boot-recovery window and workload/platform matrix; do not treat this host's resources as minimum requirements or an SLA. |

These limitations remain visible even when the documentation task is complete.
No cloud resources, public exposure, fees, release, commit, push or merge were
performed by this validation.

## Follow-up: saved local deploy script and prompted accounts (2026-10-12)

Local setup now requests ordinary and super admin account emails/passwords,
confirms hidden terminal inputs, and computes the admin bcrypt hash automatically.
The ordinary password is preserved in protected Compose env encoding; the admin
plaintext is never written to the env or generated wrapper. Database passwords
remain generated. Existing installations/configuration are not silently replaced.

Fresh setup generates a mode-0700, secret-free `default_deploy.sh` (or the path
selected by `CHORUS_DEPLOY_CONFIG`). Its saved project/private-path/source metadata
cannot be retargeted via wrapper arguments; only optional `--dry-run` is accepted.
Build reruns build the current checkout; pull reruns use the saved application
image. Both reuse private state and Compose resources, with no `down`, forced
recreation, credential regeneration or volume deletion. Present private HTTPS and
PG17 overrides are included on every rerun. Application startup can still apply
migrations: idempotent deployment does not imply automatic rollback or zero writes.

Verification performed:

- **134 focused tests passed**: 108 installer/rerun tests and 26 Compose tests.
  Coverage includes both image sources, repeated wrapper runs, unchanged private
  env bytes, no secret argv/log/wrapper leakage, real Compose rendering, password
  files, no-TTY behavior, PTY hidden prompts/confirmation, hash/input failures,
  saved HTTPS/PG17 overrides, script/resource collisions and existing AWS routing.
  Another 91 signing-secret/cookie tests passed (225 total). Independent review
  identified interactive `read` trimming password-boundary whitespace; all four
  password/confirmation reads now use `IFS=`, with six new PTY regressions for
  preserving spaces/tabs and rejecting whitespace-only confirmation differences.
  Two additional regressions reject password files within the Docker build context.
- A real ephemeral `httpd:2.4-alpine` container ran isolated `htpasswd` with stdin
  fixture input, `--network none --read-only --cap-drop ALL` and no-new-privileges.
  Its cost-12 `$2y$` bcrypt hash verified with `bcryptjs`; a wrong password failed.
  A separate fixture confirmed boundary spaces/tabs survive hashing and a trimmed
  password does not verify.
- Seven real isolated Compose container roundtrips confirmed fixture passwords
  preserve trailing backslashes, backslash-before-apostrophe, double backslashes,
  quotes, dollar signs, hash marks/spaces and literal backslash-n. The corrected
  ordinary-password encoding uses escaped double-quoted dotenv values; admin
  bcrypt remains single-quoted. Only fixture credentials were used.
- Bash syntax, targeted ESLint, whitespace, bilingual command parity and cumulative
  OpenSpec checks passed; the version-8 spec mirror roundtrip was byte-identical.

A root `default_deploy.sh` was generated for the existing `chorus-local` instance,
selecting build mode and its existing private directory. It is Git-ignored and
excluded from Docker build context. **Only its dry-run was executed**; no full app
build/redeploy, restart or new account setup was performed against the running
restored instance. Before/after checks showed unchanged app/db/connector/unrelated
container IDs, image IDs and start times, and identical private env/HTTPS/PG17/
existing management-wrapper fingerprints. Cached helper-image pulls and disposable
fixture containers do not constitute a live application redeployment.

## Follow-up: PostgreSQL 17 and imported database (2026-10-12)

The operator explicitly authorized replacing the current local dataset with
their downloaded custom-format dump and changing deployment recommendations to
PostgreSQL 17. Earlier PostgreSQL 16 evidence below remains historical, not the
current deployment state.

Source: `chorus-20261012.dump`, 36,920,831 bytes, custom archive version 1.16,
PostgreSQL 17.6 source and pg_dump 17.11. SHA256:
`7fe51e3c70748c0d9d3d3f9ea9a03e35f0e89bdc59ce0645173d36a2ddcdcf95`.
No source row contents, passwords, API keys or identity-provider details are
included in this evidence.

Restore and validation:

- Pulled `postgres:17-alpine`, PostgreSQL **17.11**, manifest digest
  `sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24`.
- Backed up the previous local PG16 database, globals, signing material and
  private configuration. Took a final dump after stopping app writes; verified
  full dump decoding and recorded protected backup checksums.
- Inspected archive/schema: no source functions, triggers, extensions or external
  data-source objects found. Restored into a fresh volume with an isolated
  `--network none` PG17 container, temporary credentials and a non-superuser owner;
  `pg_restore --no-owner --no-privileges --exit-on-error --single-transaction`
  completed without errors. Source roles/ACLs were deliberately not imported.
- Counted source COPY rows without displaying data and compared every restored
  table: **34 tables, 105,238 rows** matched. Key counts: **169 projects, 825 ideas,
  642 proposals, 2,983 tasks, 2,083 documents, 10 users and 3 companies**.
- All **47** source migration checksums matched the running **Chorus 0.22.1**
  image; no pending/source-only migration or failed migration. The image's
  `prisma migrate status` passed against isolated PG17. All constraints validated
  and indexes valid; ANALYZE completed.
- **128 tests passed** across installer/Compose recommendations (69), signing
  secret handling (44) and cookie options (15). Targeted lint, shell syntax,
  bilingual command parity, whitespace and cumulative OpenSpec validation passed;
  the spec mirror's byte-exact roundtrip was verified.
- Independent review reran these suites plus 32 additional secret-check cases:
  **160 tests passed**. Its non-blocking note about the agent-facing stack version
  was addressed by updating `CLAUDE.md` to PostgreSQL 17.

Cutover and current state:

- Recreated only `chorus-local` app/db; the fresh PG17 volume is
  `chorus-local_db-data-pg17-20261012`. Original `chorus-local_db-data` remains
  retained for rollback and was never opened with PG17.
- A private `pg17.yml` selects that external volume; a private `compose.sh` wrapper
  preserves base/local/HTTPS/PG17 overrides. Use
  `bash ~/.config/chorus-self-host/chorus-local/compose.sh ps` for ongoing operations,
  not the earlier two/three-file commands. Do not remove the old volume merely
  because Compose warns that it is retained but no longer selected.
- The database role uses a fresh private password; local bootstrap/admin settings,
  app image, signing key and app-data mount remain unchanged. Connector and
  unrelated container identities/start times were unchanged.
- After startup all 34 table counts still matched the dump. Public health at
  `https://app-dev.chorus-ai.dev/api/health` returned `ok`/`connected`; host binding
  remains `127.0.0.1:18637`, HTTPS cookies and external URL remain configured.
- Admin access without a session returned401; a 60-second synthetic local-admin
  session returned200 and the three restored companies. No persistent test users,
  workspaces or other rows were created. This verifies signed-session reads,
  **not** actual admin-password login or source OIDC E2E.

Protected rollback artifacts and exact rollback instructions are in
`~/.local/state/chorus-pg17-restore-20261012/OPERATIONS.md`. Rollback was documented,
not executed; it restores the old local dataset, so first preserve/reconcile any
new PG17 writes. Never use `down -v` or prune either volume.

The current bootstrap email is absent from the restored users; avoid default-login
as a restore probe because it may create an empty workspace. Use source identities
or the preserved local `/admin` account. Source sessions may require re-login and
the identity provider may need the new hostname's callback allowlisted. Source
signing keys, external attachments/object storage, OIDC, SSE/daemon reconnect and
browser E2E were not supplied or fully validated by this database restore.

## Follow-up: existing connector and public HTTPS (2026-10-12)

The operator created a standalone `chorus-cloudflare` connector on the existing
`chorus-local_default` network, configured the hostname, and confirmed public
reachability. The app was then configured for `https://app-dev.chorus-ai.dev`
with `COOKIE_SECURE=true` using an additional private `https.yml` override in
`$HOME/.config/chorus-self-host/chorus-local/`. The connector was not replaced or
restarted, its token was not inspected, and no DNS/Access settings were changed.

Only the app was recreated with `--no-deps --pull never --force-recreate --wait`.
Before/after checks confirmed identical image ID, mounts, loopback `18637` mapping,
non-HTTPS environment fingerprint and private env-file bytes. Database and
unrelated container IDs/start times and connector start time were unchanged.

Live checks after the change:

- Local and public `/api/health`: `status=ok`, `database=connected`.
- Public default login: HTTP 200; session cookie has Secure, HttpOnly and
  SameSite=Lax attributes. Credentials/cookie values stayed in memory and were
  not printed or placed in command arguments.
- Public cookie-authenticated `/api/session` and `/api/projects`: HTTP 200,
  `cf-cache-status: DYNAMIC` on the observed responses.
- An initial Python HTTPS probe timed out; curl subsequently succeeded. The
  initial cookie-only `/api/auth/me` probe returned 401: that route requires a
  Bearer header, so cookie session verification used `/api/session` instead.

Future app operations must retain the final private override, for example from
the repository root (with no conflicting exported Compose interpolation values):

```bash
docker compose --project-name chorus-local \
  --env-file "$HOME/.config/chorus-self-host/chorus-local/env" \
  -f deploy/self-host/compose.yml \
  -f deploy/self-host/compose.local.yml \
  -f "$HOME/.config/chorus-self-host/chorus-local/https.yml" ps
```

Do not add `compose.tunnel.yml` to this existing standalone-connector setup:
that would manage another connector. Use the public HTTPS hostname for login;
plain HTTP loopback health remains available, but is not the login entrypoint
with secure cookies. This check does not establish browser E2E, SSE/daemon, OIDC,
Access policy, cache-rule completeness or token rotation verification.

## Follow-up: installer port and current deployment (2026-10-12)

At the operator's request, the local installer now defaults to loopback host
port `18637`; explicit `--port` and `CHORUS_PORT` overrides remain supported.
The container port and optional Tunnel origin remain `8637`. Manual Compose
keeps its previous fallback; the bilingual installer examples use `18637`.

The operator's running `chorus-local` deployment, distinct from the earlier
`chorus-guide-20261011` fixture, was moved from `8637` to `18637` by changing only
`CHORUS_PORT` in its existing private env file and running the same project's
local Compose configuration with `up -d --no-deps --pull never --force-recreate
--wait --wait-timeout 180 app`. No reinstall, image pull/build, volume deletion,
credential regeneration or database restart was performed.

Observed at `2026-10-12T04:02:52Z`:

- `http://127.0.0.1:18637/api/health`: `status=ok`, `database=connected`.
- App binding: `127.0.0.1:18637->8637/tcp`; old host port `8637` no longer listened.
- `NEXTAUTH_URL=http://localhost:18637`; HTTP cookie configuration unchanged.
- Saved image reference and app authentication values matched the existing
  private configuration without printing secrets; env file mode remained `0600`.
- Existing volumes: `chorus-local_app-data`, `chorus-local_db-data`.
- Database start time remained `2026-10-12T03:54:53Z`, before this operation;
  unrelated `hardcore_swanson` remained running since `2026-10-09T08:03:56Z`.
- 53 focused tests passed: 43 installer and 10 Compose checks, including default
  pull/build ports, CLI/environment precedence and real Compose port rendering.
  Bash syntax, targeted ESLint, diff whitespace and OpenSpec validation passed.

This is health/configuration verification, not a new browser, public Tunnel,
fresh-image build/pull or full data-restore acceptance run.

## Follow-up: local installer and fixture shutdown (2026-10-11)

At the user's explicit request after initial acceptance, the source fixture's
two containers (`chorus-guide-20261011-app-1` and `chorus-guide-20261011-db-1`)
were stopped successfully, with exit code 0. **They are now stopped**, not
listening on port 18637. Source/restore volumes and protected backups remain;
the unrelated pre-existing `node:22-alpine` container remains running. The
installer tests below did not relaunch the fixture or any new real containers.

`install.sh` now routes AWS/local before AWS prerequisite checks or saved-config
reuse. Its local helper reuses the reviewed Compose configuration and offers
explicit image pull versus current-checkout Dockerfile production build. It
generates private credentials outside the checkout, refuses existing state,
and supports a no-write local dry run and noninteractive inputs. The bilingual
guide's installer section describes the interface and recovery path.

Fresh verification:

- `pnpm exec vitest run src/lib/__tests__/install-local.test.ts src/lib/__tests__/self-host-compose.test.ts src/lib/__tests__/docker-ensure-secret.test.ts src/lib/__tests__/cookie-utils.test.ts`: **108/108 passed**, including 39 new installer tests after the collision-guard correction below.
- Installer tests stub Docker mutation and AWS/CDK command boundaries. They
  check both image-source command sequences, existing AWS ALB/CloudFront
  dry-run routing, no-TTY failures, dry-run non-mutation, private file modes,
  no credential output/argv, inherited-variable isolation, project/config
  collision refusal and failure propagation. One test also sends the generated
  env/config to the **real Compose renderer**, without a running-container action.
- `bash -n install.sh deploy/self-host/install-local.sh`, explicit non-ignored
  ESLint for both deployment test files, and `git diff --check` pass.
- A real invocation of `bash install.sh --target local --image-source build
  --email validation@example.invalid --project guide-installer-dry-run --dry-run`
  printed the production build/PostgreSQL/loopback plan; no config directory or
  Docker resource was created.
- The cumulative `portable-self-host-guide` specification validates with the
  added installer requirement.

Independent review found that a label-only inventory could miss manually
created exact-name volumes. The final helper additionally checks exact generated
volume, network and container names regardless of labels and stops on inventory
errors before image preparation. Nine regression cases cover unlabelled name
collisions, failed lookups and non-colliding similar names. No existing resource
was deleted or relabelled to resolve this issue.

No registry pull, full local Docker build, live AWS call/deploy, or new runtime
installation was executed in this follow-up. Passing command-contract tests
does not certify registry availability or a fresh image build. The initial
runtime evidence and external-validation limitations above remain distinct.
