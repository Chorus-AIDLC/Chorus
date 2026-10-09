## Context

The production stage of `Dockerfile` currently runs:

```dockerfile
ENV PNPM_HOME="/root/.local/share/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN PRISMA_MIGRATION_VERSION="$(cat /tmp/prisma-migration-version)" \
 && test -n "$PRISMA_MIGRATION_VERSION" \
 && pnpm add -g "prisma@$PRISMA_MIGRATION_VERSION" \
 && rm /tmp/prisma-migration-version
```

`docker-entrypoint.sh` calls `prisma migrate deploy` from `/app`, where `prisma.config.ts` and `prisma/` are located. `prisma@7.10.0` depends on `mysql2: 3.15.3` exactly, and `@prisma/config@7.10.0` depends on `deepmerge-ts: 7.1.5` exactly. pnpm's global install has no override mechanism.

## Goals / Non-Goals

**Goals:** Remove the two HIGH advisories from the image's CLI tree without changing the app's dependency graph or the migration behavior.

**Non-Goals:** Upgrading to Prisma 8. Changing `package.json` overrides or the lockfile. Replying on GitHub #604.

## Decisions

1. **Use npm with a dedicated prefix, not pnpm global.** npm `overrides` in a local `package.json` apply to the nested dependencies of `prisma` [3](ref:2fa5a4fb-f791-41f1-8874-ff7c93097bf7). This is the approach the issue reporter tested [1](ref:4782d9ac-6354-409d-ad68-d687a5092d11).
   ```dockerfile
   ENV PATH="/opt/prisma/node_modules/.bin:$PATH"
   RUN PRISMA_MIGRATION_VERSION="$(cat /tmp/prisma-migration-version)" \
    && test -n "$PRISMA_MIGRATION_VERSION" \
    && mkdir -p /opt/prisma && cd /opt/prisma \
    && printf '%s\n' '{"private":true,"overrides":{"mysql2":"3.24.5","deepmerge-ts":"8.0.2"}}' > package.json \
    && npm install --omit=dev --no-audit --no-fund --no-package-lock "prisma@$PRISMA_MIGRATION_VERSION" \
    && npm cache clean --force \
    && rm /tmp/prisma-migration-version
   ```
   The developer must check the exact npm flags and override syntax against the npm docs instead of relying on memory.
2. **Exact override versions, aligned with the app.** Use `mysql2` 3.24.5 and `deepmerge-ts` 8.0.2. The root `package.json` overrides (`mysql2@3: ^3.24.5`, `deepmerge-ts@7: ^8.0.2`) already pin these for the app, so the repo has already verified them with `prisma generate`. Both are outside every known advisory range (mysql2 <3.22.0 and <=3.23.0; deepmerge-ts <8.0.0). Pinning exact versions keeps builds reproducible.
3. **Keep the CLI version source unchanged.** `scripts/prisma-migration-version.mjs` still provides the exact `7.x` pin that matches `@prisma/client` and `@prisma/adapter-pg`.
4. **Add a build-time assertion over every installed copy.** After the install, the build fails if any `mysql2` or `deepmerge-ts` package under `/opt/prisma/node_modules` (including nested, non-deduped copies — e.g. `find /opt/prisma/node_modules -path "*/mysql2/package.json"`) has a version other than its override, or if no copy is found. This keeps a future Prisma bump from silently dropping the fix. `prisma --version` also runs in the same step as a load check. `prisma validate` is not used at build time because `prisma.config.ts` needs `DATABASE_URL`.
5. **Remove `PNPM_HOME`.** Remove it if nothing else in the production stage uses it. `corepack enable` can stay.
6. **Link `prisma` into `/app/node_modules`.** `/app/prisma.config.ts` imports `prisma/config`. Node resolves that from `/app`, not from the CLI's prefix. With the old global pnpm install the package was reachable, but with `/opt/prisma` it is not (the first image build failed `migrate deploy` with `Cannot find module 'prisma/config'`). The install step runs `ln -s /opt/prisma/node_modules/prisma /app/node_modules/prisma` and then checks `require.resolve('prisma/config')` from `/app`, so the build fails if this breaks.

## Risks / Trade-offs

- **`deepmerge-ts` 8 major bump** → `@prisma/config` may behave differently when merging config. Mitigation: run `prisma --version` during the build, and run `migrate deploy` in verification against both external PostgreSQL and the default embedded-PGlite start (no `DATABASE_URL`).
- **Override drift** when Prisma is bumped → handled by the build-time assertion. Remove the overrides once upstream fixes prisma/prisma#30295.
- **Slightly larger build step / npm cache** → clear the npm cache in the same layer.

## Verification Plan

1. Build the image locally (`docker build --target production`).
2. Start it with PostgreSQL (docker compose `db`), confirm that `prisma migrate deploy` succeeds in the entrypoint, `/api/health` returns OK, login works, an authenticated `/api/projects` returns 200, and an unauthenticated request returns 401.
3. Start the image with no `DATABASE_URL` (embedded PGlite mode) and confirm that the entrypoint `prisma migrate deploy` succeeds and `/api/health` returns OK.
4. Run grype (via the `anchore/grype` container if it isn't installed) on the image. Confirm no findings for `mysql2` / `deepmerge-ts` / `source-map-js`, and record the remaining findings with package, version and advisory.
