# Verification evidence

## Task 1 — application and build dependencies

Task: `b8e36bad-3b99-4688-9865-04de5e67808b`. Date: 2026-10-03 (UTC).
Worktree: `/home/ubuntu/dev/Chorus-security-590-591`.
Branch: `fix/security-dependencies-590-591`; aggregate baseline: `b2e9b2e0`.
Planning documents were subsequently committed by the parent as `9d472792`.
Environment: Node `24.21.0`, pnpm `9.15.0`, Linux x64.
Raw metadata, logs and JSON results: `/tmp/chorus-security-590-591-evidence/task1/`.

### Official constraints and scoped resolution

Package metadata was fetched directly from `https://registry.npmjs.org/<package>/<version>`,
saved as JSON under the evidence directory, and compared with the installed graph
using `pnpm why postcss nanoid sharp --recursive --json` and the smoke script.

| Package | Before | Task 1 resolution | Constraint / decision |
| --- | --- | --- | --- |
| next / eslint-config-next | 15.5.12 | 15.5.27 | Exact direct versions; matching Next ESLint plugin and SWC packages. Next peers accept React/React DOM `^19.0.0`; ESLint config accepts ESLint 9. |
| react / react-dom | 19.2.3 | 19.2.8 | Exact direct versions; React DOM requires React `^19.2.8`. |
| postcss | 8.4.31, 8.5.6, 8.5.8 | 8.5.28 | `postcss@8` override. Next 15.5.27 still declares exactly `8.4.31`; all existing PostCSS consumers stay on 8.x. |
| nanoid 3.x | 3.3.11 | 3.3.19 | `nanoid@3` override. PostCSS 8.5.28 declares `^3.3.18`. |
| nanoid 5.x | 5.1.9 | 5.1.16 | `nanoid@5` override retains docx 9.6.1's compatible `^5.1.3` major/API while fixing its target-package HIGH advisories. No override crosses nanoid major lines. |
| sharp | 0.34.5 | 0.35.5 | Separate `next>sharp` and `astro>sharp` overrides cover the two actual consumers. Next accepts `^0.34.3 \|\| ^0.35.4`. Astro 6.1.4 declares `^0.34.0`, so its intentional override crosses a 0.x minor and is validated by the landing build and image-processing smoke. |
| docx / shiki overrides | 9.6.1 / ^4.1.0 | Unchanged | Existing override entries retained byte-for-byte. |
| Prisma / client / adapter-pg | 7.3.0 | Unchanged | Task 2 owns this update; Task 1 does not edit Dockerfile. |

Sharp 0.35.5 requires Node `>=20.9.0`; Astro requires `>=22.12.0`, matching
the landing manifest and the Node 22 Docker base. The local Node 24 environment
satisfies both. Its native package graph uses libvips package `1.3.4`; the
running library reports libvips `8.18.7` and libheif `1.23.5`.

Official metadata files include `next-15.5.27.json`, `eslint-config-next-15.5.27.json`,
`react-19.2.8.json`, `react-dom-19.2.8.json`, `postcss-8.5.28.json`,
`nanoid-3.3.19.json`, `nanoid-5.1.16.json`, `sharp-0.35.5.json`, `astro-6.1.4.json` and
`docx-9.6.1.json`. The pnpm documentation at
`https://pnpm.io/settings/dependency-resolution#overrides` confirms version
selectors and `parent>dependency` selectors; a copy is retained as
`pnpm-overrides.html`. The requested `9.x/package_json` documentation redirects
to the current package manifest page, so its current pnpm 11 placement advice
was not applied to this pnpm 9 repository.

The lockfile package-record comparison against the aggregate baseline removed
45 records and added 47, exclusively the target packages and required Next /
sharp native or runtime dependencies (`semver@7.8.5` and
`@emnapi/runtime@1.11.3` included). Other resolved versions, including Prisma,
Astro, docx and shiki, are retained. The large textual diff also
reflects React peer-context suffixes and merged PostCSS resolutions.
See `lockfile-package-delta.json` and `why-targets.json`.

### Commands and results

All commands ran from the worktree above. Environment values for the disposable
database are injected programmatically; neither passwords nor full URLs are
written here. `DATABASE_URL=<task1-url>` means the dedicated database
`chorus_security_task1_b8e36bad` on the parent's disposable PostgreSQL 16 at
`127.0.0.1:55442`, with `sslmode=disable`.

| Command | Exit | Result / evidence |
| --- | --- | --- |
| `CI=true pnpm install --lockfile-only --ignore-scripts --prefer-offline` | 0 | Targeted lockfile update; `lockfile-update.log`. Existing dsh release-candidate peer mismatches were reported; those workspace versions were not changed. |
| `CI=true pnpm install --frozen-lockfile` | 0 | Lockfile unchanged; `frozen-install.log`, `frozen-install-result.json`. |
| `DATABASE_URL=postgresql://task1@127.0.0.1:1/task1?sslmode=disable CI=true pnpm exec prisma generate` | 0 | Generates existing 7.3.0 client; no DB connection; `prisma-generate.log`. |
| `pnpm exec tsc --noEmit` | 0 | 55.64 seconds; `typecheck.log`, `typecheck-result.json`. |
| `pnpm lint` | 0 | 0 errors, 152 warnings; `lint.log`, `lint-result.json`. |
| `CI=true pnpm test` | 0 | 436 files / 9,717 tests passed; 10 files / 237 tests skipped (opt-in or intentional). Run before the subsequent compatible nanoid 5.x patch; `vitest.log`, `vitest-result.json`. |
| `DATABASE_URL=<task1-url> CI=true pnpm exec prisma db push` | 0 | Creates schema only in dedicated Task 1 database; `db-push.log`, `db-push-result.json`. |
| `RESEARCH_DATABASE_URL=<task1-url> CI=true pnpm test:coverage` | 1 | Initial 55442 attempt rejected by existing Research / operation HTTP test port guards; also two 5-second UI test timeouts under concurrent build/test load. Retained as `before-nanoid5-coverage.log` and `before-nanoid5-coverage-result.json`. Corrected full rerun uses the forwarding setup below without a concurrent build. |
| `RESEARCH_DATABASE_URL=<task1-url-via-local-forward> CI=true pnpm test:coverage` | 0 | Corrected run after nanoid 5.x patch: 438 files / 9,828 tests passed, 8 files / 126 tests skipped (remaining opt-in or intentional suites); 174.76 seconds; `coverage.log`, `coverage-result.json`. |
| `RESEARCH_DATABASE_URL=<task1-url-via-local-forward> CI=true pnpm exec vitest run src/services/__tests__/research.database.integration.test.ts` | 0 | 97/97 DB tests passed through the forward, before nanoid 5.x patch; `research-integration.log`. |
| `CI=true NEXT_TELEMETRY_DISABLED=1 pnpm build:local` | 0 | Refreshed after nanoid 5.x patch, including Prisma generation, compilation, lint/type checks and standalone generation; 83.35 seconds; `standalone-build.log`, `standalone-build-result.json`. Initial passing build (264.77 seconds) retained with `before-nanoid5-` prefix. |
| `CI=true ASTRO_TELEMETRY_DISABLED=1 pnpm landing:build` | 0 | 66 pages; 16.13 seconds overall; `landing-build.log`, `landing-build-result.json`. |
| `pnpm why postcss nanoid sharp --recursive --json` | 0 | Installed graph captured in `why-targets.json`. |
| `node /tmp/chorus-security-590-591-evidence/task1/target-smoke.cjs` | 0 | Exact direct/Prisma versions, PostCSS parse/transform/stringify, nanoid 3.3.19 / 5.1.16 generation, docx 9.6.1 document packing, Next and Astro sharp PNG/WebP/AVIF resize/encode/decode; `target-smoke.log`. |
| `pnpm audit --json` | 1 | No findings for any target package; residual 94 HIGH / 1 CRITICAL findings outside this patch; `application-updated-audit.json`, `audit-comparison.json`, `audit-result.json`. |
| `git diff --check` | 0 | No whitespace errors. |

The frozen-install lockfile SHA-256 was identical before and after:
`906facb927672cccd434691a0b1f6b99ec93f25ca083bfa625290d7148c2b0df`.
The initial install before the compatible nanoid 5.x patch also preserved its
lockfile hash (`9ba4a90e07960f695d18facb94a2e4ea48fb825fe16de3531579455d41e6253a`);
the initial evidence is retained with the `before-nanoid5-` prefix.

The parent created container `chorus-security-590-591-test-pg`; Task 1 created
only its named database using `pg`. The password is read from the parent's
`runtime-private.json` without printing it. Research's existing test checks
for the literal `:5435/` before connecting; the operation HTTP DB suite also
requires port 5435. To retain those checks without editing
source, `python3 /tmp/chorus-security-590-591-evidence/task1/test-pg-forward.py`
forwards `127.0.0.1:5435` to `127.0.0.1:55442`. The corrected coverage URL
selects the same dedicated database through this local forward. No other
database is modified.

The corrected full coverage run includes all 97 Research database tests,
all 14 operation HTTP database tests and all 43 tracker-action UI tests
(including the two previously timed-out cases). Coverage thresholds passed:
lines 97.68% (required 95%), statements 96.35% (95%), branches 90.62% (85%),
functions 97.62% (93%). Retained machine-readable results:
`coverage-summary.json` and `coverage-thresholds.json`.
The Task 1 forward was stopped after the coverage run; its script remains
available for the parent's final checks. The dedicated database is retained
in the parent's disposable container for inspection / cleanup.

The final standalone inspection confirms `.next/standalone/server.js`,
3 compiled CSS files totaling 147,983 bytes and traced Next 15.5.27,
React / React DOM 19.2.8, PostCSS 8.5.28, nanoid 3.3.19 and sharp 0.35.5.
The lockfile hash still matches the final frozen-install hash after all checks.
See `standalone-inspection.json`. Generated package manifest stubs without
versions are ignored by that metadata inspection.

Early ad-hoc version smoke attempts used the non-exported `package.json`
subpath for Prisma's adapter and sharp and exited 1. The retained repeatable
script reads installed Prisma metadata from disk and uses `sharp.versions`;
the corrected smoke passes. This was a verification-script issue, not an
application regression.

### Dependency audit comparison and scope

The baseline audit is the parent's
`/tmp/chorus-security-590-591-evidence/baseline-audit.json`.
The updated audit is application-only, before Task 2 upgrades Prisma and
before any final-image scan.

| Severity | Baseline | Initial application update before nanoid 5.x patch | Final Task 1 |
| --- | --- | --- | --- |
| Critical | 3 | 1 | 1 |
| High | 118 | 96 | 94 |
| Moderate | 129 | 112 | 112 |
| Low | 28 | 26 | 26 |

These are pnpm's vulnerability totals, not a claim that the whole image is
clean. No remaining advisory in the final Task 1 audit targets the resolved
Next, React, React DOM, PostCSS, sharp, nanoid 3.3.19 or nanoid 5.1.16 packages.

The initial application-only audit identified two HIGH findings for nanoid
5.1.9: `GHSA-28wg-ghj8-5hjv` (`>=4.0.0 <5.1.16`, first patched 5.1.16)
and `GHSA-xwg4-73v4-xw9w` (`>=4.0.0 <5.1.11`, first patched 5.1.11).
The official GitHub advisory API responses
(`https://api.github.com/advisories/<GHSA-ID>`) are retained under their IDs.
The user clarified that preserving 5.x consumers means their compatible
major/API, not the vulnerable exact patch. The official registry lists
5.1.16 as the latest 5.1 patch; its mutable `latest` tag points to 6.0.1,
which is deliberately not used. `nanoid@5: 5.1.16` is compatible with docx
9.6.1's `^5.1.3` and resolves both advisories without changing docx or its
major/API. Direct nanoid 5.x generation and docx document packing are included
in the refreshed smoke.
Other residual dependencies and OS/global-CLI findings belong in Task 3's
final-image comparison; Task 1 does not build Docker images or set up scanners.

The remaining workspace CRITICAL is `astro@6.1.4` at
`packages/landing > astro@6.1.4`, `GHSA-26w7-cxv4-gfx2` ("Remote code execution
through AVIF image optimization"), feed range `<7.2.8`, patched version
`>=7.2.8`. Astro's major is retained as requested; its sharp dependency is
patched, but this does not establish that the separately reported Astro
advisory is removed or unreachable. Track the Astro major upgrade separately,
and distinguish workspace audit scope from packages actually present in the
final application image during integration.

### Handoff and final-graph requirement

Task 1 owns only `package.json`, `pnpm-lock.yaml`, this evidence file and the
Task 1 entries in `tasks.md`. The parent owns independent review and admin
verification; Task 2 may continue the shared lockfile after that verification.

Task 1's three acceptance criteria self-check as passed: target resolutions
and retained overrides; compatible nanoid 5.x consumers / explicit sharp scope
and unchanged frozen lockfile; successful required type/lint/Vitest/coverage
and both affected builds, with the corrected environment attempts documented.
No application or test source was changed. Tests added only to temporary
verification scripts are smoke exercises of real package behavior.

Proposal reviewer note N1 is accepted: **final lint, Vitest and coverage must
be repeated after Task 2's Prisma upgrade on the completed dependency graph**.
These Task 1 checks do not substitute for that final validation. Browser,
production database startup, amd64/arm64 images and image scans remain Task 3
integration evidence.


## Task 2 — Prisma migration version consistency

The application CLI, generated client and PostgreSQL adapter are all pinned to
7.10.0. `pnpm install --frozen-lockfile` passed without changing the final lockfile
SHA-256 (`b145f49b85c7c6582ad4c85ce0d7b1fbad93c24d8c348b95abf5c1d772309374`).
`pnpm db:generate` and `pnpm exec tsc --noEmit` both passed after the upgrade.
Separate disposable PostgreSQL databases successfully completed `prisma db push`
and `prisma migrate deploy` (all 45 migrations). Logs are retained under
`/tmp/chorus-security-590-591-evidence/task2/`.

The new `scripts/prisma-migration-version.mjs` reads the three direct installed
package metadata files through pnpm's links, validates exact stable 7.x manifest
pins, installed/pinned equality and cross-package equality, and prints one version.
Reading the files directly avoids Prisma's private `package.json` exports and its
CLI-only root export. An initial attempt to resolve those private exports failed;
the corrected implementation and installed-package check both pass.

Docker exports this version in the builder and installs the production migration
CLI from that artifact. A missing/empty artifact fails the `RUN` step; there is no
unversioned fallback. The comment now correctly distinguishes mutable dist-tags
from stable Prisma 7.x, which still supports `migrate deploy`. The baseline image
reports Node v22.23.3; Prisma 7.10 requires Node >=20.19 / >=22.12 / >=24.0.
The installed CLI's `migrate deploy --help` succeeds. Actual final-image versions,
both architectures and both database runtime paths are verified in Task 3.

`node --test scripts/__tests__/prisma-migration-version.test.mjs` passed 11 tests:
matching/current and later stable 7.x pins, installed mismatch, cross-package
mismatch, prerelease/range/latest/new-major/leading-zero/injection inputs and a
missing installed dependency. Fixtures block package metadata exports and throw
from their entrypoints, so successful cases establish the helper does not import
private exports or execute the packages. CI runs the focused tests and the real
installed-package helper immediately after the frozen install. Focused ESLint
passed with 0 errors and one existing-style console warning in the CLI error path.
The Docker context excludes generated coverage, browser output and tsbuildinfo.

Required final lint, full Vitest and coverage remain Task 3 checks on this final
dependency graph; Task 1's Prisma 7.3 results are not substituted for them.


## Task 3 — final production integration

All results below come from the completed Prisma 7.10 dependency graph.
Public JSON evidence is retained in `verification-evidence/`; raw commands,
logs, full SBOM/Grype output and protected fixture state remain under
`/tmp/chorus-security-590-591-evidence`. The public checksum manifest records
the raw artifacts' SHA-256 values. Credentials, cookies and tokens are not
committed. Repeatable scripts are in `scripts/security-verification/`.

### Images and platform conditions

Both production targets were actually built and executed locally. amd64 is
native; arm64 uses QEMU on this amd64 host. Both images report Node v22.23.3,
Prisma CLI/client 7.10.0, application Next 15.5.27, React/React DOM 19.2.8,
PostCSS 8.5.28, nanoid 3.3.19 and sharp 0.35.5. Prisma's separately installed
global CLI also brings React/React DOM 19.3.0; these are distinguished from
the application's pinned versions in the image metadata and scan scope.
The adapter is bundled into server chunks: builder validation establishes
its 7.10.0 installed version, and real Prisma-backed requests verify it.

The baseline and both patched builds use the same resolved Node Alpine
image index `sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402`.
These are local Docker `Id` values (no image or branch was pushed):

| Image | Platform | Local Docker Id |
| --- | --- | --- |
| baseline-amd64 | linux/amd64 | `sha256:5dc866a0752b5def828f9ed6f7bd89efaa5befa43e4513e50c31882763c2ccd3` |
| patched-amd64 | linux/amd64 | `sha256:72dee29b0fb8bfb0436797875db2425617ecdf2863e5ca31f0b3ad855a40f474` |
| patched-arm64 | linux/arm64 | `sha256:7fe520ac226cb4e4e565a1d5fbbbe4958634ff73baab419eefb2df4819dd7916` |

Build commands: `docker build --platform linux/amd64|arm64 --target production
-t chorus-security:patched-<arch> .` (one actual command per platform).
Image checks use the committed `image-smoke.mjs` mounted read-only and
`docker run --rm --entrypoint prisma <image> --version` with a dummy
`DATABASE_URL` for config loading. The image smoke actually produces resized
12×9 PNG, WebP and AVIF output on both architectures, then decodes metadata.

### Startup, upgrade and restart matrix

The historical fixtures were initialized with the baseline image's 7.3 CLI
and the 42 real migrations at `a994ef48`, overriding the baseline's current
migration directory. Baseline current code is `b2e9b2e0`; its remaining three
migrations are applied by the patched image:
`20261001053611_add_private_project_access`,
`20261001143700_add_project_group_access`,
`20261002160000_add_daemon_turn_wake_error`.
Each historical fixture contains a marker company and project. The arm64
PGlite fixture was seeded through the baseline amd64 image; compatibility of
this fixture is verified by the actual arm64 upgrade/restart, rather than
a separate old arm64 baseline build.

| Platform | Database | Data | Final migrations | Failed | Seed retained / restart | Result |
| --- | --- | --- | --- | --- | --- | --- |
| amd64 | pg | fresh | 45 | 0 | same user + unchanged row counts | PASS |
| amd64 | pg | upgrade | 45 | 0 | marker company/project + same user | PASS |
| amd64 | pglite | fresh | 45 | 0 | same user + unchanged row counts | PASS |
| amd64 | pglite | upgrade | 45 | 0 | marker company/project + same user | PASS |
| arm64 | pg | fresh | 45 | 0 | same user + unchanged row counts | PASS |
| arm64 | pg | upgrade | 45 | 0 | marker company/project + same user | PASS |
| arm64 | pglite | fresh | 45 | 0 | same user + unchanged row counts | PASS |
| arm64 | pglite | upgrade | 45 | 0 | marker company/project + same user | PASS |

Every combination passes health, default login, authenticated projects,
unauthenticated projects 401, twelve concurrent project requests and a second
startup. All databases finish with 45 applied migrations and zero failed
migrations; the second startup reports no pending migrations. Every external
PostgreSQL app connection is verified as TLS using `pg_stat_ssl`; the service
requires TLS for all remote connections. Fixtures use `DB_HOST` configuration
to exercise the existing SSL path. Embedded fixtures use the image's default
no-database-config path without injecting `CHORUS_USE_PGLITE`.
No new schema migration is added by this security fix.

### Browser and final graph checks

Real Chromium 153.0.8010.12 validates both native upgraded
database modes. Login loads three stylesheets, with nonzero button dimensions
and 8px/16px padding. Theme storage uses `chorus-theme`; light/dark backgrounds
are rgb(250,248,245) / rgb(33,30,28). The default login follows the product's
onboarding “Skip for now” action, enters `/projects`, expands Ungrouped and
shows the historical marker project. Both runs report zero page errors.
Screenshots are retained under `.playwright-mcp/security-590-591/{postgresql,pglite}`;
representative project/CSS screenshots were visually inspected. The Playwright
MCP was unavailable, so programmatic Playwright 1.63.0 drove the real browser.

Final frozen/generation/type/CLI helper checks are recorded in Task 2. The
required final complete-graph lint and full Vitest with coverage also pass;
they do not reuse Task 1's Prisma 7.3 results. Host test Node is v24.21.0;
the actual production runtime is Node v22.23.3. The full suite is run with the
CI-style isolated `RESEARCH_DATABASE_URL` forwarded from localhost:5435 to
the dedicated PostgreSQL service on 55442, after QEMU image compilation.
Schema synchronization uses a separate disposable final-test database.

| Final command | Exit | Seconds |
| --- | --- | --- |
| `docker exec chorus-security-590-591-test-pg psql -U postgres -v ON_ERROR_STOP=1 -c CREATE DATABASE "chorus_security_final_vitest";` | 0 | 0.09 |
| `pnpm exec prisma db push` | 0 | 3.73 |
| `pnpm lint` | 0 | 8.57 |
| `pnpm test:coverage` | 0 | 140.88 |

Coverage: statements 96.35%, branches 90.62%, functions 97.62%, lines 97.68%; all configured thresholds pass.
Full test/file totals and intentional skips are retained verbatim in
`final-checks/coverage.log`; skips are not reported as executed tests.

### Security comparison and exact residuals

Syft 1.54.0 and Grype 0.119.0 use the identical frozen database built
`2026-10-02T06:31:53Z`, schema v6.1.9. [Database source](ref:8f85d213-c758-4ef8-ba10-d6aa3830b912)
[Syft source](ref:211ece2a-edf6-49ae-8c10-d20409b0dbab)
[Grype source](ref:347ae609-e616-47b6-aa09-2179b1353240)
`GRYPE_DB_AUTO_UPDATE=false` prevents feed drift between the scans.
The SBOM scope is the final image filesystem, including global Prisma,
package-manager caches and Alpine OS packages. These are scanner matches,
not unique advisory totals and not an exploitability assessment.

| Image | High | Critical | Total High/Critical | Target package High/Critical |
| --- | --- | --- | --- | --- |
| baseline-amd64 | 67 | 3 | 70 | 20 |
| patched-amd64 | 44 | 1 | 45 | 0 |
| patched-arm64 | 44 | 1 | 45 | 0 |

The reproduced baseline differs from the reporter's 29-finding count because
this run uses its own current frozen feed, image and counting scope. It does
not substitute the issue author's scan for independent evidence.

| Workspace lockfile audit | High | Critical | Target advisories |
| --- | --- | --- | --- |
| baseline-audit | 118 | 3 | 37 |
| final-audit | 92 | 1 | 0 |

The final workspace audit has no advisory for the selected Next/React/
React DOM/PostCSS/nanoid/sharp/Prisma package names. Audit exit 1 is retained
because other dependencies remain affected. The workspace's remaining
CRITICAL is `astro@6.1.4`, `GHSA-26w7-cxv4-gfx2`, affected `<7.2.8`, fixed
`>=7.2.8`; this requires the separately scoped Astro major upgrade. Patching
Astro's sharp does not prove that advisory is removed or unreachable.

The exact detected High/Critical residuals below are taken from the patched
amd64 image; the machine-readable comparison includes both architectures and
full paths. None is dismissed as unreachable. `No feed fix` means the frozen
feed supplies no fixed version, not that mitigation is impossible.

| Package/version | Advisory | Severity | Location scope | Feed fix version |
| --- | --- | --- | --- | --- |
| glob 10.4.5 | GHSA-5j98-mcp5-4vw2 | High | bundled pnpm cache | 10.5.0 |
| pnpm 9.15.0 | GHSA-2phv-j68v-wwqx | High | bundled pnpm cache | 10.27.0 |
| cross-spawn 7.0.3 | GHSA-3xgq-45jj-v275 | High | bundled pnpm cache | 7.0.5 |
| tar 6.2.1 | GHSA-23hp-3jrh-7fpw | Critical | bundled pnpm cache | 7.5.19 |
| ip-address 10.1.0 | GHSA-mwp4-54f8-5fhr | High | Node image npm | 10.3.1 |
| ip-address 9.0.5 | GHSA-mwp4-54f8-5fhr | High | bundled pnpm cache | 10.3.1 |
| tar 6.2.1 | GHSA-8x88-c5mf-7j5w | High | bundled pnpm cache | 7.5.18 |
| brace-expansion 2.0.1 | GHSA-rgw5-rvv9-x895 | High | bundled pnpm cache | 2.1.4 |
| brace-expansion 2.0.2 | GHSA-rgw5-rvv9-x895 | High | Node image npm | 2.1.4 |
| tar 6.2.1 | GHSA-34x7-hfp2-rc4v | High | bundled pnpm cache | 7.5.7 |
| brace-expansion 2.0.1 | GHSA-mh99-v99m-4gvg | High | bundled pnpm cache | 2.1.3 |
| brace-expansion 2.0.2 | GHSA-mh99-v99m-4gvg | High | Node image npm | 2.1.3 |
| pacote 19.0.2 | GHSA-w4pp-8pjf-rmxw | High | Node image npm | 21.5.1 |
| pacote 20.0.1 | GHSA-w4pp-8pjf-rmxw | High | Node image npm | 21.5.1 |
| pnpm 9.15.0 | GHSA-vq4v-j7r6-jq4m | High | bundled pnpm cache | 10.34.5 |
| zlib 1.3.2-r0 | CVE-2026-85091 | High | Alpine OS | No feed fix |
| pnpm 9.15.0 | GHSA-c59q-g84q-2gj5 | High | bundled pnpm cache | 10.34.5 |
| minimatch 9.0.5 | GHSA-7r86-cg39-jmmj | High | bundled pnpm cache | 9.0.7 |
| minimatch 9.0.5 | GHSA-3ppc-4f35-3m26 | High | bundled pnpm cache | 9.0.6 |
| pnpm 9.15.0 | GHSA-hwx4-2j3j-g496 | High | bundled pnpm cache | 10.34.0 |
| deepmerge-ts 7.1.5 | GHSA-ggr8-5vv4-36mx | High | global Prisma CLI | 8.0.0 |
| tar 6.2.1 | GHSA-r292-9mhp-454m | High | bundled pnpm cache | 7.5.21 |
| minimatch 9.0.5 | GHSA-23c5-xmqv-rm74 | High | bundled pnpm cache | 9.0.7 |
| picomatch 4.0.3 | GHSA-c2c7-rcm5-vvqj | High | Node image npm | 4.0.4 |
| pnpm 9.15.0 | GHSA-7vhp-vf5g-r2fw | High | bundled pnpm cache | 10.26.0 |
| pnpm 9.15.0 | GHSA-rxhj-4m44-96r4 | High | bundled pnpm cache | 10.34.0 |
| tar 6.2.1 | GHSA-qffp-2rhf-9h96 | High | bundled pnpm cache | 7.5.10 |
| tar 6.2.1 | GHSA-8qq5-rm4j-mr97 | High | bundled pnpm cache | 7.5.3 |
| brace-expansion 2.0.1 | GHSA-6j4f-fj2g-mc7p | High | bundled pnpm cache | 2.1.5 |
| brace-expansion 2.0.2 | GHSA-6j4f-fj2g-mc7p | High | Node image npm | 2.1.5 |
| brace-expansion 2.0.1 | GHSA-qhr7-859c-m2p7 | High | bundled pnpm cache | 2.1.6 |
| brace-expansion 2.0.2 | GHSA-qhr7-859c-m2p7 | High | Node image npm | 2.1.6 |
| brace-expansion 2.0.1 | GHSA-3jxr-9vmj-r5cp | High | bundled pnpm cache | 2.1.2 |
| brace-expansion 2.0.2 | GHSA-3jxr-9vmj-r5cp | High | Node image npm | 2.1.2 |
| pnpm 9.15.0 | GHSA-w466-c33r-3gjp | High | bundled pnpm cache | 10.34.2 |
| tar 6.2.1 | GHSA-r6q2-hw4h-h46w | High | bundled pnpm cache | 7.5.4 |
| tar 6.2.1 | GHSA-83g3-92jg-28cx | High | bundled pnpm cache | 7.5.8 |
| tar 6.2.1 | GHSA-9ppj-qmqm-q256 | High | bundled pnpm cache | 7.5.11 |
| pnpm 9.15.0 | GHSA-gj8w-mvpf-x27x | High | bundled pnpm cache | 10.34.2 |
| sigstore 3.1.0 | GHSA-52v5-jr5w-gjxr | High | Node image npm | 4.1.1 |
| pnpm 9.15.0 | GHSA-5wx6-mg75-v57r | High | bundled pnpm cache | 10.34.2 |
| mysql2 3.15.3 | GHSA-3f6p-5ww8-9rcr | High | global Prisma CLI | 3.22.0 |
| pnpm 9.15.0 | GHSA-72r4-9c5j-mj57 | High | bundled pnpm cache | 10.34.4 |
| pnpm 9.15.0 | GHSA-fr4h-3cph-29xv | High | bundled pnpm cache | 10.34.4 |
| pnpm 9.15.0 | GHSA-qrv3-253h-g69c | High | bundled pnpm cache | 10.34.4 |

Follow up the pnpm 9.15 bundled tar/package-manager findings (including
CRITICAL `GHSA-23hp-3jrh-7fpw`), npm's bundled dependencies, global Prisma's
`deepmerge-ts@7.1.5` / `mysql2@3.15.3` and Alpine `zlib@1.3.2-r0` separately.
Root project overrides do not rewrite the independently installed global
CLI or the Node image's package-manager caches. The whole image is not
reported as vulnerability-free.

### Corrected attempts and verification limits

- The initial arm64 runtime attempt exited 125 because it reached that image
  before its build completed. `runtime-matrix-attempt1.json` preserves it;
  the passed amd64 cases were reused and all four arm64 cases were actually
  executed after the image existed. Missing images are not counted as passes.
- Early image smoke assumed an unbundled adapter manifest and root-level
  sharp; the corrected smoke reads traced package locations and distinguishes
  bundled code from separate installed metadata. Image encodings on both architectures
  are actually exercised. The committed smoke uses ESM and passes focused lint.
- The first CLI-output assertion assumed fixed column spacing; retained
  successful output confirms 7.10.0 and is parsed by field with flexible whitespace.
- The first browser attempt waited directly for `/projects` and timed out
  on expected onboarding. The corrected real UI flow follows the skip button.
- Initial project screenshots caught the expand/entrance animation before
  the project row appeared, despite passing DOM/data checks. The committed
  browser harness now waits for ancestor opacity and clipping to settle.
  After the first cleanup, equivalent native historical 42→45 fixtures were
  recreated for this screenshot correction; both final screenshots visibly
  show the marker project. The original eight-case matrix remains intact.
  Additional fixture preparation and cleanup are recorded separately.
- arm64 verification is emulated, not native. Browser checks use native amd64
  images in both database modes; all arm64 auth/database/image checks are
  actual emulated execution. Remote GitHub CI has not been triggered because
  this branch and the local images have not been pushed.
- Dedicated fixture resources are cleaned after evidence capture; local
  images, source branch, public artifacts and protected raw evidence remain
  available. No generic Docker prune or unrelated-resource operation is used.
