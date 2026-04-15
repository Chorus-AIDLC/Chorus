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
      - "8637:3000"
    environment:
      # No DATABASE_URL — entrypoint auto-starts embedded PGlite
      - REDIS_URL=
      - NEXTAUTH_SECRET=${NEXTAUTH_SECRET:-chorus-local-secret}
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
      - "8637:3000"
    environment:
      - DATABASE_URL=postgresql://chorus:chorus@db:5432/chorus
      - REDIS_URL=redis://default:chorus-redis@redis:6379
      - NEXTAUTH_SECRET=change-me-to-a-random-secret
      - DEFAULT_USER=admin@example.com
      - DEFAULT_PASSWORD=your-password
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
  chorus-data:
  redis-data:
```

Then run:

```bash
docker compose up -d
```

Open http://localhost:8637 and log in with the credentials you set in `DEFAULT_USER` / `DEFAULT_PASSWORD`.

> **Note for HTTP-only deployments**: The default `docker-compose.yml` sets `COOKIE_SECURE=false` to support HTTP-only deployments (e.g., internal network testing). If you're deploying with HTTPS in production, make sure to set `COOKIE_SECURE=true` to enable secure cookies.

### Docker Run (with existing PostgreSQL)

If you already have PostgreSQL and Redis running:

```bash
docker run -d \
  -p 8637:3000 \
  -e DATABASE_URL=postgresql://user:pass@your-db-host:5432/chorus \
  -e REDIS_URL=redis://default:password@your-redis-host:6379 \
  -e NEXTAUTH_SECRET=change-me-to-a-random-secret \
  -e COOKIE_SECURE=false \
  -e DEFAULT_USER=admin@example.com \
  -e DEFAULT_PASSWORD=your-password \
  chorusaidlc/chorus-app:latest
```

## Environment Variables

### Required

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string. Format: `postgresql://user:password@host:port/dbname`. Alternatively, set individual `DB_*` variables (see below). **If omitted**, the entrypoint starts an embedded PGlite instance automatically. |
| `NEXTAUTH_SECRET` | Secret key for signing JWT session tokens. Use a random string (e.g., `openssl rand -base64 32`). |

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
| `NEXTAUTH_URL` | Public-facing base URL of the app (default: `http://localhost:3000`). Set this when running behind a reverse proxy. |
| `COOKIE_SECURE` | Set to `"false"` to disable secure cookies for HTTP-only deployments (default: `"false"` in docker-compose). Set to `"true"` when deploying with HTTPS in production. |

### Super Admin

| Variable | Description |
|---|---|
| `SUPER_ADMIN_EMAIL` | Email for the super admin account (has access to `/admin` panel). |
| `SUPER_ADMIN_PASSWORD_HASH` | Bcrypt hash of the super admin password. Generate with: `node -e "require('bcrypt').hash('password',10).then(console.log)"` |

## Image Details

- **Base image**: `node:22-alpine`
- **Internal port**: `3000` (mapped to `8637` externally by default)
- **Entrypoint**: Runs Prisma migrations automatically on startup (retries for up to 5 minutes while waiting for the database)
- **Build**: Next.js standalone output for minimal image size
- **Architectures**: `linux/amd64`, `linux/arm64`

## Startup Behavior

1. If `DATABASE_URL` is not set and no `DB_*` variables are provided, the entrypoint starts an embedded PGlite instance on an internal port
2. The entrypoint runs `prisma migrate deploy` to apply any pending database migrations
3. If the database is not ready, it retries every 10 seconds (up to 30 attempts)
4. Once migrations succeed, the Next.js server starts on internal port 3000 (mapped to 8637 externally)

## Source Code

https://github.com/Chorus-AIDLC/Chorus
