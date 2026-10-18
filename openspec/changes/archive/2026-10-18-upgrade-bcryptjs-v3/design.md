## Context

The root application uses `import bcrypt from "bcryptjs"` for async `hash`/`compare`. CDK uses `import * as bcrypt from 'bcryptjs'` with `hashSync(..., 10)`. Local credentials use cost 12 and an explicit UTF-8 72-byte maximum. Current login tests generate hashes with the installed library, which alone cannot prove old-hash compatibility.

Official npm 3.0.3 metadata exposes separate import/require entrypoints and declarations (`index.js`/`index.d.ts`, `umd/index.js`/`umd/index.d.ts`). Its manifest declares neither dependencies nor a Node engines restriction; absence of an engines declaration is not a runtime test. The published README documents pure JavaScript, ESM with UMD fallback, and a 72-byte limit not enforced by the library itself. Preserve application validation.

Sources: https://registry.npmjs.org/bcryptjs/3.0.3 and https://registry.npmjs.org/bcryptjs/-/bcryptjs-3.0.3.tgz (published README/source/types). The GitHub raw README was unavailable during preparation; published artifacts are the version-specific evidence.

## Goals / Non-Goals

Goals: upgrade both consumers; retain old credentials; preserve factors/validation/packaging; remove redundant type dependencies. Non-goals: authentication redesign, native bcrypt/Argon2, hash migration, cost tuning, supported Node/platform changes, unrelated dependency updates.

## Decisions

1. Use `^3.0.3` in both manifests and lock the resolved release in pnpm, matching the confirmed caret policy. Do not globally update workspace dependencies.
2. Use shipped declarations. Keep imports unchanged unless compilation proves an adjustment is necessary. Both published artifacts retain `hash`, `compare`, `hashSync` and `getRounds`; 3.x retains Promise forms and cryptographic RNG (Web Crypto with Node crypto fallback). Its generated prefix changes from `$2a$` to `$2b$`, while existing `$2a$` hashes remain readable. Do not promise byte-identical newly salted hashes. Root bundler imports and CDK CommonJS namespace imports require no production source changes.
3. Generate fixed synthetic fixtures with the pre-upgrade 2.4.3 library and a fixed public salt; record version, plaintext and generation recipe. Include cost 12 local credentials and cost 10 deployment credentials, ASCII and multibyte/72-byte boundary coverage. Never use production hashes or retain 2.x as a test dependency.
4. Exercise real bcrypt in local-user and workspace login tests and a dedicated super-admin compatibility test (existing super-admin unit tests mock bcrypt). Assert correct password succeeds and a wrong password fails. Test new cost-12 hashes and cost-10 CDK-style sync hashes through real comparison; assert work factors rather than hash prefixes. Preserve >72-byte rejection coverage.
5. Keep implementation in one cohesive task: dependency upgrade and its compatibility evidence are inseparable. Independent proposal/task/aggregate reviewers provide the YOLO gates.

## Validation

- Targeted Vitest: local-user, workspace-local-auth, bcrypt compatibility, super-admin suites; include unchanged password boundary tests.
- Full `pnpm test` (bounded worker concurrency if required by this host).
- Root `pnpm exec tsc --noEmit`, `pnpm build:local`, and `pnpm --filter @chorus/cdk run build`; run Node import and require smoke checks from each package context with real hash/compare.
- Check official source/declarations plus compiled CDK behavior for sync/CJS compatibility. No AWS deploy or real credentials required.
- Inspect lockfile for unrelated churn, absence of bcryptjs 2.x/@types/bcryptjs, and no native/transitive bcrypt dependency. Run frozen-lockfile install check. Existing five-platform npm packaging is unchanged; local checks do not claim execution on all five operating systems.
- When a broad check fails, reproduce on an isolated unmodified baseline if necessary and preserve evidence. Fix only upgrade-induced failures; unresolved relevant failures block acceptance. Document unrelated baseline failures explicitly.

## Risks / Rollback

Major-version type overloads can expose mocked-test casts or import differences. Compile both bundler and CJS configurations and test real runtime entrypoints. CPU-heavy bcrypt tests can time out when all suites compete; cap workers without weakening assertions. If regression occurs, revert this scoped manifest/lockfile/test change; no stored data migration needs reversing.

## Verification Results (2026-10-18)

- Lockfile resolves 3.0.3 for both consumers; its diff only changes bcryptjs and removes `@types/bcryptjs`. `pnpm install --frozen-lockfile --ignore-scripts` passed; no native bcrypt or new transitive dependency.
- Three targeted files passed all 174 tests. Full `pnpm run test --maxWorkers=2` passed 483 files / 11,372 tests, with 11 files / 245 tests skipped by existing integration-test gates (340.85 seconds). Super-admin's existing mock suite is also included in the full run.
- Root `pnpm exec tsc --noEmit` passed before and after upgrade, including final new tests; CDK `pnpm --filter @chorus/cdk run build` passed.
- `pnpm build:local` passed in an isolated working-tree copy, preserving the live workspace's `.next`. Existing lint and optional rate-limiter adapter warnings were nonfatal; no source changes were needed.
- Real import/require smoke checks passed in both root/CDK contexts on Node 24.21.0 and temporary Node 22.23.3: asynchronous cost 12, synchronous cost 10, correct/wrong comparison and legacy comparison.
- Project-configured CDK entrypoint (`ts-node --prefer-ts-exts bin/chorus.ts`) synthesized cloudfront mode with `--no-lookups` and synthetic credentials. The synthesized secret's hash had cost 10 and passed correct/wrong comparisons. No AWS deployment occurred. An initial optional direct invocation of compiled `bin/chorus.js` failed to resolve `source-map-support/register`; using the project's configured entrypoint succeeded without any unrelated dependency change.
- All fixed fixtures were independently reproduced from the published 2.4.3 tarball. A rollback smoke check also confirmed 2.4.3 reads a newly generated 3.0.3 `$2b$` hash correctly.
- `git diff --check`, OpenSpec validation and byte-exact Chorus document mirror verification passed. Tests are excluded by the existing ESLint configuration, so their ignored-file lint warnings are not counted as a lint pass.
- These are local Linux checks, not claims of execution on all five distribution platforms. Production source, password policy, stored hashes, Node/platform policy and packaging mechanisms are unchanged. No commits, pushes or merges.
