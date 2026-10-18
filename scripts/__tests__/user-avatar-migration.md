# Avatar migration verification

Task: `1c0d2bfa-53f8-4d2e-82c8-2a36f792f670`.

## Reproduce

Run from the repository root with installed dependencies and Node.js 24 (native
TypeScript stripping). No extra dependency or package-script change is needed.

```sh
node --test scripts/__tests__/user-avatar-migration.test.mjs
AVATAR_MIGRATION_POSTGRES=1 node --test scripts/__tests__/user-avatar-migration.test.mjs
```

The first command uses only an in-memory PGlite instance. The second runs the same
suite against PGlite and a newly created PostgreSQL 17 Docker container; it requires
Docker access and the already-local `postgres:17-alpine` image (`--pull=never`).
This standalone suite is intentionally not included in the ordinary Vitest run.

## Isolation and real legacy writer

- Never reads an application database URL or imports the application's Prisma
  singleton. Pools explicitly target loopback, ephemeral ports and test credentials.
- PGlite has no disk data directory. PostgreSQL uses a uniquely named
  `chorus-avatar-migration-<pid>-<random>` container and tmpfs data directory.
  Cleanup targets only the container ID returned by this run's `docker create`.
- Full schema migrations are replayed: all 48 migrations preceding
  `20261018042000_user_avatar_seed`, then the actual avatar migration. A fresh
  schema is also rebuilt inside each owned database. No business database is used.
- Generates a real Prisma 7.10.0 client from the full pre-change schema at
  `b3f0097b91971d23e8dbaebdcff39f8cdcc7e798`; the Git object must be available.
  The schema is asserted to contain no `avatarSeed`. Only generator output/module
  settings change so Node can import the temporary TypeScript client directly.
  Temporary files under ignored `.testdata/avatar-migration-*` are removed.
- Uses that generated client through `PrismaPg`/`pg`, including over PGlite's actual
  socket transport, rather than hand-written SQL approximations of old inserts.
  Captured client SQL must include at least 15 User inserts per engine and must
  never reference `avatarSeed`. The repository's generated client is untouched.

## Coverage

Each engine verifies:

1. Injected failure immediately before migration COMMIT rolls back the entire
   transaction, including the new column/backfill; existing rows remain identical
   and old-client OIDC/default/local creation still succeeds.
2. Successful upgrade backfills every legacy row with its UUID, preserving every
   other field, including credentials, session version, soft deletion, identity,
   avatar URL and workspace-admin state.
3. The column is TEXT NOT NULL with the database UUID default. Actual old-client
   OIDC create, default-login upsert and transactional local-invitation create omit
   the field and receive distinct valid UUID seeds. Explicit NULL inserts and
   updates fail with SQLSTATE 23502 without changing data.
4. Explicit saved seeds survive a newly instantiated old client performing OIDC
   profile/subject changes, default-login upsert updates and local-profile/password
   changes. All three old creation shapes still work after this writer rollback.
5. A fresh database applies the full migration chain and accepts all three old
   creation shapes with database-generated seeds.
6. Actual captured generated-client SQL never references the new column.

## Evidence and limitations

Verified on 2026-10-18 with Node.js 24.21.0, Prisma 7.10.0, PGlite PostgreSQL 17.5
(WASM), and Docker PostgreSQL 17.11 (`postgres:17-alpine`). Both-engine execution
passes all 14 Node test-runner checks (12 subtests and two enclosing engine tests).

This is an actual client regenerated from the pinned pre-change schema, not an
archived pre-release client binary. It exercises real old-writer data shapes, not
the login HTTP routes, credential/token issuance, or parent-owned API authorization.
Saved seeds are written directly with SQL to isolate persistence compatibility.
Migration SQL is replayed directly, not through Prisma's migration bookkeeping;
this does not verify `_prisma_migrations` or deployment orchestration.

The installed PGlite socket proxy terminates the connection for parameterized
NOT NULL violations instead of preserving SQLSTATE. Therefore the two negative
constraint assertions use PGlite's native query API; PostgreSQL uses `pg` directly.
All old-client creates, upserts, reads and updates still run through the actual
generated Prisma client and socket/adapter stack on both engines. The deliberately
failing migration uses the socket connection's simple-query protocol and preserves
its SQLSTATE. A single pooled connection avoids known PGlite multiplexer races;
this is not a concurrency, production-scale backfill, or lock-duration benchmark.

Writer rollback retains the additive database column; no down migration is claimed.
Normal success and exception paths close clients/pools/servers, remove the owned
container and delete temporary generated files. An external SIGKILL or host crash
can bypass JavaScript cleanup; only this suite's labeled disposable resources
should ever be removed manually.
