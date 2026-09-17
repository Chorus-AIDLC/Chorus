# Chorus Docker Image

**`chorusaidlc/chorus-app`** — The official Docker image for [Chorus](https://github.com/Chorus-AIDLC/Chorus), an AI Agent & Human collaboration platform implementing the AI-DLC (AI-Driven Development Lifecycle) workflow.

## Quick Start

```bash
docker pull chorusaidlc/chorus-app:latest
```

### Docker Compose — Standalone (Recommended)

No external database needed. The image bundles [PGlite](https://pglite.dev) (embedded PostgreSQL) and starts everything automatically.

Create a `docker-compose.local.yml`:

```yaml
# Standalone Chorus — embedded PGlite, no external PostgreSQL or Redis
services:
  app:
    image: chorusaidlc/chorus-app:latest
    ports:
      - "8637:8637"
    environment:
      # No DATABASE_URL — entrypoint auto-starts embedded PGlite
      - REDIS_URL=
      # Leave empty: a random JWT secret is generated on first start and persisted
      # to /app/data/.secret (see "JWT secret security" below).
      - NEXTAUTH_SECRET=${NEXTAUTH_SECRET:-}
      - COOKIE_SECURE=false
      - DEFAULT_USER=${DEFAULT_USER:-admin@example.com}
      - DEFAULT_PASSWORD=${DEFAULT_PASSWORD:-changeme}
    volumes:
      - chorus-local-data:/app/data

volumes:
  chorus-local-data:
```

Then run:

```bash
docker compose -f docker-compose.local.yml up -d
```

Open http://localhost:8637 and log in with `admin@example.com` / `changeme` (or override via `DEFAULT_USER` / `DEFAULT_PASSWORD` env vars).

The embedded mode:
- Starts PGlite on an internal port (5433), not exposed externally
- Stores data in a Docker volume — persists across container restarts
- Auto-generates the JWT signing secret on first start and keeps it in the same volume (see [JWT secret security](#jwt-secret-security))
- Disables Redis (falls back to in-memory EventBus — single-instance only)
- Runs Prisma migrations automatically on startup

### Production Deployment (PostgreSQL + Redis)

For production with multiple replicas, use Docker Compose with external PostgreSQL and Redis.

Create a `docker-compose.yml`:

```yaml
services:
  app:
    image: chorusaidlc/chorus-app:latest
    ports:
      - "8637:8637"
    environment:
      - DATABASE_URL=postgresql://chorus:chorus@db:5432/chorus
      - REDIS_URL=redis://default:chorus-redis@redis:6379
      # Set a strong random value in .env (openssl rand -base64 32). If left
      # empty, the container generates one and persists it in chorus-app-data —
      # single replica only; multi-replica MUST set it explicitly.
      - NEXTAUTH_SECRET=${NEXTAUTH_SECRET:-}
      - DEFAULT_USER=admin@example.com
      - DEFAULT_PASSWORD=your-password
    volumes:
      - chorus-app-data:/app/data
    depends_on:
      db:
        condition: service_healthy
      redis:
        condition: service_healthy

  redis:
    image: redis:7-alpine
    command: redis-server --requirepass chorus-redis
    volumes:
      - redis-data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "-a", "chorus-redis", "ping"]
      interval: 5s
      timeout: 3s
      retries: 5

  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: chorus
      POSTGRES_PASSWORD: chorus
      POSTGRES_DB: chorus
    volumes:
      - chorus-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U chorus -d chorus"]
      interval: 5s
      timeout: 5s
      retries: 5

volumes:
  chorus-app-data:
  chorus-data:
  redis-data:
```

Then run:

```bash
docker compose up -d
```

Open http://localhost:8637 and log in with the credentials you set in `DEFAULT_USER` / `DEFAULT_PASSWORD`.

> **Multi-replica deployments**: the auto-generated secret only works for a single app container. When running more than one replica, generate one secret (`openssl rand -base64 32`) and set the same `NEXTAUTH_SECRET` on every replica — see [JWT secret security](#jwt-secret-security).

> **Note for HTTP-only deployments**: The default `docker-compose.yml` sets `COOKIE_SECURE=false` to support HTTP-only deployments (e.g., internal network testing). If you're deploying with HTTPS in production, make sure to set `COOKIE_SECURE=true` to enable secure cookies.

### Docker Run (with existing PostgreSQL)

If you already have PostgreSQL and Redis running:

```bash
docker run -d \
  -p 8637:8637 \
  -e DATABASE_URL=postgresql://user:pass@your-db-host:5432/chorus \
  -e REDIS_URL=redis://default:password@your-redis-host:6379 \
  -e NEXTAUTH_SECRET="$(openssl rand -base64 32)" \
  -e COOKIE_SECURE=false \
  -e DEFAULT_USER=admin@example.com \
  -e DEFAULT_PASSWORD=your-password \
  chorusaidlc/chorus-app:latest
```

> The example above generates a fresh secret on every `docker run`, which logs all users out each time you recreate the container. For a stable deployment either store the generated value somewhere persistent and pass that same value on every run, or omit `-e NEXTAUTH_SECRET` and mount a volume at `/app/data` (`-v chorus-app-data:/app/data`) so the container can generate the secret once and reuse it.

## Environment Variables

### Required

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string. Format: `postgresql://user:password@host:port/dbname`. Alternatively, set individual `DB_*` variables (see below). **If omitted**, the entrypoint starts an embedded PGlite instance automatically. |
| `NEXTAUTH_SECRET` | Secret key for signing user and super-admin JWT session tokens. **Auto-generated in Docker when unset** (or set to a known placeholder) and persisted to `/app/data/.secret` — mount a volume at `/app/data` so it survives container recreates. **Must be set explicitly (same value on every replica) for multi-replica deployments.** Generate with `openssl rand -base64 32`. See [JWT secret security](#jwt-secret-security). |

### Database (Alternative to DATABASE_URL)

If `DATABASE_URL` is not set, the entrypoint builds it from these individual variables:

| Variable | Description |
|---|---|
| `DB_HOST` | PostgreSQL host |
| `DB_PORT` | PostgreSQL port (default: `5432`) |
| `DB_USERNAME` | PostgreSQL username |
| `DB_PASSWORD` | PostgreSQL password |
| `DB_NAME` | Database name |

### Redis

| Variable | Description |
|---|---|
| `REDIS_URL` | Full Redis connection string. Format: `redis://username:password@host:port`. Takes precedence over individual variables. |
| `REDIS_HOST` | Redis host (used if `REDIS_URL` is not set) |
| `REDIS_PORT` | Redis port (default: `6379`) |
| `REDIS_USERNAME` | Redis username (default: `default`) |
| `REDIS_PASSWORD` | Redis password |

### Authentication

| Variable | Description |
|---|---|
| `DEFAULT_USER` | Email address for built-in login (bypasses OIDC). Auto-provisions the user and company on first login. |
| `DEFAULT_PASSWORD` | Password for the default user (plain text, compared via bcrypt at runtime). |
| `NEXTAUTH_URL` | Public-facing base URL of the app (default: `http://localhost:8637`). Set this when running behind a reverse proxy. |
| `COOKIE_SECURE` | Set to `"false"` to disable secure cookies for HTTP-only deployments (default: `"false"` in docker-compose). Set to `"true"` when deploying with HTTPS in production. |

### Logging

| Variable | Default | Description |
|---|---|---|
| `LOG_LEVEL` | `info` (production) / `debug` (dev) | Minimum server log level. Accepts: `trace`, `debug`, `info`, `warn`, `error`, `fatal`, `silent`. Set to `info` to suppress Prisma query logs. |
| `NEXT_PUBLIC_LOG_LEVEL` | `warn` (production) / `debug` (dev) | Minimum browser log level. Accepts: `debug`, `info`, `warn`, `error`. |

Production Docker images always output JSON to stdout (ready for CloudWatch / ELK). Colorized pretty output is only available in local development (`pnpm dev`).

> See [Logging Architecture](LOGGING.md) for full details on log levels, output formats, and module structure.

### Super Admin

| Variable | Description |
|---|---|
| `SUPER_ADMIN_EMAIL` | Email for the super admin account (has access to `/admin` panel). |
| `SUPER_ADMIN_PASSWORD_HASH` | Bcrypt hash of the super admin password. Generate with: `node -e "require('bcrypt').hash('password',10).then(console.log)"` |

## Image Details

- **Base image**: `node:22-alpine`
- **Internal port**: `8637`
- **Entrypoint**: Runs Prisma migrations automatically on startup (retries for up to 5 minutes while waiting for the database)
- **Build**: Next.js standalone output for minimal image size
- **Architectures**: `linux/amd64`, `linux/arm64`

## Startup Behavior

1. The entrypoint ensures a secure JWT signing secret: if `NEXTAUTH_SECRET` is unset or a known public placeholder, it reuses `/app/data/.secret` or generates a new one (see [JWT secret security](#jwt-secret-security)). Any failure here aborts startup before touching the database.
2. If `DATABASE_URL` is not set and no `DB_*` variables are provided, the entrypoint starts an embedded PGlite instance on an internal port
3. The entrypoint runs `prisma migrate deploy` to apply any pending database migrations
4. If the database is not ready, it retries every 10 seconds (up to 30 attempts)
5. Once migrations succeed, the Next.js server starts on port 8637

## JWT secret security

### What the secret protects

`NEXTAUTH_SECRET` is the HS256 key that signs **every** Chorus session token: the `user_session` cookie issued to normal users (default-auth and OIDC) **and** the `admin_session` cookie issued to the super admin. Anyone who knows the value can mint a valid token for any user — including a super-admin session — without a password.

### Background: GitHub issue #559

Before 0.18.1 the shipped `docker-compose.yml` fell back to a publicly known value (`chorus-docker-secret-change-in-production`) when the operator did not set `NEXTAUTH_SECRET`, and `docker-compose.local.yml` used `chorus-local-secret`. Because both values are in the public repository, any default Compose deployment that exposed port 8637 was forgeable ([#559](https://github.com/Chorus-AIDLC/Chorus/issues/559)). Since 0.18.1 the compose files ship **no** default and the image bootstraps a random secret instead.

### Auto-generation in the Docker image

On every container start, before database migrations run, `docker-entrypoint.sh` checks `NEXTAUTH_SECRET`:

| `NEXTAUTH_SECRET` at start | Behaviour |
|---|---|
| A value that is **not** a known placeholder | Used as-is. Nothing is read from or written to disk. |
| Unset / empty | Reads `/app/data/.secret`; if it holds a non-empty value it is reused, otherwise a new secret is generated with `openssl rand -hex 32` (64 hex characters), written to `/app/data/.secret` with mode `0600`, and exported to the app. Log: `NEXTAUTH_SECRET not set — generated a new random secret and persisted it to /app/data/.secret.` (or `… — reusing the persisted secret from /app/data/.secret.`) |
| One of the known placeholders below | Ignored and handled exactly like "unset". Log: `WARNING: NEXTAUTH_SECRET was set to a publicly known placeholder (see GitHub issue #559). Ignoring it — …` |

Known public placeholders (the list lives in `docker/ensure-secret.sh` and `src/lib/secret-check.ts`): `chorus-docker-secret-change-in-production`, `chorus-local-secret`, `your-secret-key-change-in-production`, `change-me-to-a-random-secret`.

The entrypoint never prints the secret and never falls back to a public value. If `/app/data/.secret` exists but is not a regular file, cannot be read, or cannot be written — or if the persisted file itself contains a known placeholder — the container exits with an error before running migrations.

As defence in depth, the application also assesses the effective value at process start (all deployment modes, not only Docker) and logs an `error`-level `security` entry with `reason: "default_secret"` if a known placeholder is still in effect, and a `warn`-level `reason: "missing_secret"` entry if the variable is unset (login then fails with `NEXTAUTH_SECRET is not set`, as before).

### Persistence requirement

The generated secret lives in `/app/data/.secret`, so `/app/data` **must be a persistent volume** — otherwise a fresh secret is generated on every container recreate or image upgrade and every user is logged out each time. The startup log reminds you of this whenever a secret is generated or reused:

```
  Make sure /app/data is a persistent volume, otherwise the secret rotates (and all sessions are invalidated) on every container recreate.
  Multi-replica deployments MUST set the same NEXTAUTH_SECRET explicitly on every replica.
```

The shipped compose files already do this: `docker-compose.local.yml` mounts `chorus-local-data:/app/data` and `docker-compose.yml` (since 0.18.1) mounts `chorus-app-data:/app/data`. If you run the image with `docker run` or your own compose file, add the volume yourself (`-v chorus-app-data:/app/data`) or set `NEXTAUTH_SECRET` explicitly.

### Single-replica limit

Auto-generation is guaranteed for a **single app container only**. It uses an exclusive-create on the secret file, which is best-effort on a shared volume and does nothing for replicas with separate volumes — each replica would end up with its own secret and sessions would fail whenever a request lands on a different replica. A shared volume is **not** a supported multi-replica solution.

### Generating and setting a strong value

For production, generate a random secret once and configure it explicitly:

```bash
openssl rand -base64 32
```

Then either put it in a `.env` file next to your compose file (`NEXTAUTH_SECRET=<value>` — Compose substitutes it into `${NEXTAUTH_SECRET:-}`), pass it with `-e NEXTAUTH_SECRET=<value>` to `docker run`, or inject it from your platform's secret store. An explicit, non-placeholder value always wins and disables auto-generation.

### Sharing across replicas

When running more than one app container, every replica **must** receive the **same** `NEXTAUTH_SECRET` from the deployment layer (compose `.env`, Kubernetes Secret, ECS task definition, …). The AWS CDK deployment in `packages/chorus-cdk` already does this by injecting a random value from AWS Secrets Manager into every ECS task.

### Rotation invalidates sessions

Session tokens are verified with the current secret. Changing `NEXTAUTH_SECRET` — whether deliberately, by deleting `/app/data/.secret`, or accidentally by recreating a container without a persistent `/app/data` volume — invalidates every existing `user_session` and `admin_session` cookie, and all users (including the super admin) must log in again. Plan rotations accordingly.

## Automated Publishing (CI)

Images are published automatically by the
[`.github/workflows/docker-publish.yml`](../.github/workflows/docker-publish.yml)
GitHub Actions workflow. Two triggers, two tag policies:

| Trigger | Tags produced | `latest` updated? | De-dup |
|---|---|---|---|
| Push to `develop` / `main` | moving branch tag (`:develop` / `:main`) | **No** | older in-progress build for the same branch is cancelled |
| GitHub Release `published` | release version tag (`:vX.Y.Z`) + `:latest` | **Yes** | never cancelled |

Both triggers build multi-arch (`linux/amd64` + `linux/arm64`) using **native
per-architecture runners** — amd64 on `ubuntu-latest` and arm64 on the free
`ubuntu-24.04-arm` hosted runner — rather than QEMU emulation. Each arch is
built and pushed **by digest** in a matrix `build` job, then a `merge` job
stitches the digests into a single multi-arch tag with `docker buildx imagetools
create`. Native arm64 avoids the slow emulated Next.js build that would otherwise
time out. Branch builds tag only the moving branch name, so day-to-day merges
never clobber the `latest` tag that production consumers depend on; the release
job checks out the immutable release tag ref (not the branch head) and also
updates `:latest`. The tag is resolved and validated in the merge step, and
attacker-influenced inputs (the release tag) are passed via `env` rather than
inlined into a shell command.

`scripts/docker-push.sh` remains available for **local / manual** multi-arch
builds (it uses QEMU + Buildx in a single invocation, which is fine off the
critical CI path). A `workflow_dispatch` trigger is also available to smoke-test
the native build on a branch — on manual dispatch the images are built but never
pushed.

### Prerequisite: Docker Hub repository secrets

The workflow authenticates to Docker Hub with `docker/login-action`, which reads
two **repository secrets** that must be configured before the first run
(Settings → Secrets and variables → Actions):

| Secret | Description |
|---|---|
| `DOCKERHUB_USERNAME` | Docker Hub username with push access to `chorusaidlc/chorus-app`. |
| `DOCKERHUB_TOKEN` | Docker Hub access token (create at Docker Hub → Account Settings → Personal access tokens). Prefer a scoped token over the account password. |

If these secrets are missing, the workflow fails fast at the login step.

## Source Code

https://github.com/Chorus-AIDLC/Chorus
