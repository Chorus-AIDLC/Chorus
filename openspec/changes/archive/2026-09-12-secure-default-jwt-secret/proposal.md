# Proposal: Eliminate the public default JWT signing secret (#559)

## Why

[GitHub Issue #559](https://github.com/Chorus-AIDLC/Chorus/issues/559) reports that
`docker-compose.yml` falls back to a **publicly known** `NEXTAUTH_SECRET`
(`chorus-docker-secret-change-in-production`) when the operator does not set one.
That value signs both `user_session` and `admin_session` HS256 JWTs, so anyone who
has read the repository can forge a normal-user **or super-admin** session against
any default Compose deployment that exposes port 8637.

A warning-only fix was evaluated and rejected: as long as the public fallback keeps
shipping in the compose file, every un-configured deployment stays forgeable, and a
startup log line does not change that — most operators never read startup logs.
Removing the fallback without a replacement is not acceptable either: the app throws
`NEXTAUTH_SECRET is not set` at token-signing time, which surfaces as a login 500.

The npm launcher (`chorus.mjs`) already solves this correctly by generating a random
secret once and persisting it to `~/.chorus/.secret`; the CDK path injects a random
value from Secrets Manager. Only the Docker image path is missing the equivalent.

## What Changes

1. **Docker entrypoint auto-generates and persists the secret.** When
   `NEXTAUTH_SECRET` is empty **or equals a known public placeholder**, the
   entrypoint reads `/app/data/.secret` (reusing it if non-empty) or creates it
   exclusively with `openssl rand -hex 32`, then exports the value to the app.
   It never falls back to a public value and never prints the secret.
2. **Known-placeholder list.** A single list of insecure placeholder values —
   `chorus-docker-secret-change-in-production`, `chorus-local-secret`,
   `your-secret-key-change-in-production`, `change-me-to-a-random-secret` —
   is mirrored in the shell entrypoint and in the TypeScript app, with a test
   asserting the two stay identical.
3. **App-layer startup warning (defense in depth).** `src/instrumentation.ts`
   evaluates the effective `NEXTAUTH_SECRET` at process start and logs a
   prominent `error`-level pino message (module `security`,
   `reason: "default_secret"`) when a known placeholder is detected — this
   covers non-Docker deployments and operators who paste a placeholder into
   CDK/env. Behaviour when the variable is unset is unchanged (token issuance
   still throws); safe custom values produce no warning.
4. **Compose files drop the public fallback.** Both compose files switch to
   `NEXTAUTH_SECRET=${NEXTAUTH_SECRET:-}` with a prominent comment block;
   `docker-compose.yml` gains a `chorus-app-data:/app/data` named volume for the
   app service (`docker-compose.local.yml` already mounts `/app/data`).
5. **Documentation and release notes.** `docs/DOCKER.md` gains a
   "JWT secret security" section; `.env.example` and the ARCHITECTURE docs are
   updated; the 0.18.1 CHANGELOG entry is written as a breaking-security
   migration note that **separates** the two compose migration paths.

## What Does NOT Change

- Deployments that already set a non-placeholder `NEXTAUTH_SECRET` behave exactly
  as before — no file is created, no warning is logged.
- No new toggle environment variable. Setting `NEXTAUTH_SECRET` explicitly *is*
  the off switch. `NEXTAUTH_SECRET_FILE` / `NEXTAUTH_SECRET_POLICY` are deferred.
- CDK/ECS path: unchanged (Secrets Manager already injects a random value).
- npm `chorus` launcher and `pnpm dev`: unchanged (do not run the entrypoint).
- Auto-generation guarantees a single replica only. Multi-replica deployments
  MUST inject the same `NEXTAUTH_SECRET` at the deployment layer; a shared volume
  is not advertised as a multi-replica solution.
- The secret is **not** stored in the database (see design.md, rejected
  alternative D).

## Migration impact (must be stated verbatim in the CHANGELOG)

| Deployment | Effect of upgrading to 0.18.1 |
|---|---|
| `docker-compose.local.yml` (embedded PGlite) | `/app/data` is already a volume → the secret is generated once; **all users re-login once**. |
| `docker-compose.yml` (Postgres) with the **updated** compose file | New `chorus-app-data` volume → generated once; **all users re-login once**. |
| `docker-compose.yml` with an **old** compose file (image pulled, file not updated) | No `/app/data` volume → the secret is regenerated on **every container recreate / image upgrade**, forcing a re-login each time, until the operator adds the volume or injects `NEXTAUTH_SECRET`. Secure, but noisy — the startup log says so explicitly. |
| Explicit secure `NEXTAUTH_SECRET`, CDK, npm launcher | No change. |

## Capabilities

- `jwt-secret-bootstrap` — Docker entrypoint secret bootstrap, known-placeholder
  detection, app-layer startup warning, compose/docs contract.

## Impact

- `docker-entrypoint.sh`, new `docker/ensure-secret.sh`, `Dockerfile` (COPY line)
- `src/lib/secret-check.ts` (new), `src/instrumentation.ts`
- `docker-compose.yml`, `docker-compose.local.yml`, `.env.example`
- `docs/DOCKER.md`, `docs/ARCHITECTURE.md`, `docs/ARCHITECTURE.zh.md`, `CHANGELOG.md`
- Tests: `src/lib/__tests__/secret-check.test.ts`,
  `src/lib/__tests__/docker-ensure-secret.test.ts` (spawns `sh` against the
  entrypoint library), instrumentation test.

## References

- https://github.com/Chorus-AIDLC/Chorus/issues/559 — the report
- `chorus.mjs#ensureSecret()` — in-repo precedent for generate-once-and-persist
