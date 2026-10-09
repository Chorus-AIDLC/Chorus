## Why

Issue #604 [1](ref:4782d9ac-6354-409d-ad68-d687a5092d11) reported three fixable HIGH advisories in the v0.21.1 container image. A triage on 2026-10-09 against `main` (v0.22.0) found that one is already fixed and two remain:

- `source-map-js` (GHSA-68fv-2mgg-jv7q) — **fixed** in v0.22.0 by the `"source-map-js@1": "1.2.2"` override.
- `mysql2` 3.15.3 (GHSA-3f6p-5ww8-9rcr, GHSA-rgwj-5xj2-c3m3) — **still present**.
- `deepmerge-ts` 7.1.5 (GHSA-ggr8-5vv4-36mx) — **still present**.

Both remaining packages come only from the Prisma CLI that the production stage installs globally with `pnpm add -g prisma@7.10.0` for `prisma migrate deploy`. Prisma 7.8.0–7.10.0 pin `mysql2: 3.15.3` and `@prisma/config` pins `deepmerge-ts: 7.1.5`. No newer stable Prisma 7.x has been released (npm `latest` is `8.0.0-rc.22`), and the upstream tracker prisma/prisma#30295 is still open [2](ref:755c750b-374e-458d-bb1d-95d411729ebd). `pnpm add -g` cannot apply overrides, so image scanners keep reporting HIGH findings, even though Chorus uses PostgreSQL and never loads `mysql2`.

## What Changes

- The production stage of `Dockerfile` installs the Prisma migration CLI with `npm install` into a dedicated directory (`/opt/prisma`), using a generated `package.json` whose npm `overrides` pin `mysql2` to `3.24.5` and `deepmerge-ts` to `8.0.2` (the same versions the root `package.json` overrides already use for the app). The CLI version is still the exact pin produced by `scripts/prisma-migration-version.mjs`.
- `prisma` stays on `PATH` (via `/opt/prisma/node_modules/.bin`), so `docker-entrypoint.sh` (`prisma migrate deploy`) is unchanged.
- The `pnpm add -g` global Prisma install and its `PNPM_HOME` setup are removed if nothing else needs them.
- Verification: build the image locally, run `prisma migrate deploy` against PostgreSQL, smoke-test health, login and authenticated API, and scan with grype to confirm 0 fixable HIGH/Critical findings for these packages. Residual findings are recorded.
- No comment is posted on GitHub issue #604 (per the user's decision).

## Capabilities

### New Capabilities
_None._

### Modified Capabilities
- `production-dependency-security`: adds a requirement that transitive dependencies of the image's migration CLI resolve to patched versions even when upstream pins vulnerable versions exactly.

## Impact

- `Dockerfile` (production stage only). App runtime dependencies, `package.json` and `pnpm-lock.yaml` are unchanged.
- Image build path: adds an `npm install` step (npm ships with `node:22-alpine`).
- Risk: `deepmerge-ts` 8 is a new major used by `@prisma/config` to merge `prisma.config.ts`. The issue reporter ran `migrate deploy` successfully with it, and we re-verify that here.
- Follow-up: remove the overrides once Prisma ships a release that resolves prisma/prisma#30295.
