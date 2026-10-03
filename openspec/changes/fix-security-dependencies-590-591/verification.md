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
