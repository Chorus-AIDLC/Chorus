# Design: Eliminate the public default JWT signing secret (#559)

## Context

- `src/lib/user-session.ts` and `src/lib/super-admin.ts` read `process.env.NEXTAUTH_SECRET`
  lazily at token sign/verify time and **throw** when it is unset. There is no in-app
  fallback. Super-admin credentials are entirely env-based (`SUPER_ADMIN_EMAIL`,
  `SUPER_ADMIN_PASSWORD_HASH`) — the super-admin auth path has zero database dependency.
- The public fallback lives only in `docker-compose.yml:13`
  (`chorus-docker-secret-change-in-production`) and `docker-compose.local.yml:15`
  (`chorus-local-secret`). Two more placeholders appear in `.env.example` and `docs/DOCKER.md`.
- The production image (`Dockerfile` `production` stage) runs as root, has `openssl`
  installed, and starts via `docker-entrypoint.sh` → `prisma migrate deploy` → `exec node server.js`.
  `/app/data` exists only in the embedded-PGlite branch (`mkdir -p /app/data/pglite`); it does
  **not** exist on the external-Postgres path.
- `docker-compose.local.yml` already mounts `chorus-local-data:/app/data`; `docker-compose.yml`
  mounts nothing on the app service.
- `chorus.mjs#ensureSecret()` (npm launcher) already implements generate-once-and-persist to
  `~/.chorus/.secret`. CDK injects a random value from Secrets Manager.
- `src/instrumentation.ts#register()` runs once per Node process at startup and is the
  natural hook for an app-layer check. `src/middleware.ts` (Edge) does not touch the secret.

## Decision summary

| Topic | Decision |
|---|---|
| Primary fix | **Option F** — entrypoint generates + persists to `/app/data/.secret` |
| Trigger | `NEXTAUTH_SECRET` empty **or** equal to a known public placeholder |
| Placeholder list | 4 values, mirrored in sh + TS, equality-tested |
| Concurrency | `set -C` exclusive create inside a subshell; parent re-reads; **single-replica guarantee only** |
| Empty file | treat as missing → regenerate |
| Unreadable / non-regular file / write failure | fail closed (exit 1); never fall back to a public value |
| App layer | keep throwing when unset; log `error` when placeholder detected; no in-process fallback |
| Toggle env var | none; `NEXTAUTH_SECRET_FILE` / `_POLICY` deferred |
| Secret in DB (Option D) | **rejected** (see below) |

## Architecture

### 1. `docker/ensure-secret.sh` (new, POSIX sh, sourced by the entrypoint)

Kept in a separate file so it can be sourced by tests without executing the entrypoint's
migration/exec logic. Copied into the image next to the entrypoint.

```sh
# docker/ensure-secret.sh — sourced by docker-entrypoint.sh
CHORUS_DATA_DIR="${CHORUS_DATA_DIR:-/app/data}"      # internal; tests point it at a tmp dir
CHORUS_SECRET_FILE="$CHORUS_DATA_DIR/.secret"

# Must stay identical to KNOWN_INSECURE_SECRETS in src/lib/secret-check.ts
CHORUS_KNOWN_INSECURE_SECRETS="chorus-docker-secret-change-in-production
chorus-local-secret
your-secret-key-change-in-production
change-me-to-a-random-secret"

is_known_insecure_secret() {   # $1 = candidate
  printf '%s\n' "$CHORUS_KNOWN_INSECURE_SECRETS" | grep -qxF -- "$1"
}

ensure_nextauth_secret() {
  if [ -n "${NEXTAUTH_SECRET:-}" ] && ! is_known_insecure_secret "$NEXTAUTH_SECRET"; then
    return 0                                   # explicit secure value wins; touch nothing
  fi
  reason="missing"; [ -n "${NEXTAUTH_SECRET:-}" ] && reason="known-insecure"

  mkdir -p "$CHORUS_DATA_DIR" || { echo "ERROR: cannot create $CHORUS_DATA_DIR" >&2; return 1; }

  if [ -e "$CHORUS_SECRET_FILE" ] && [ ! -f "$CHORUS_SECRET_FILE" ]; then
    echo "ERROR: $CHORUS_SECRET_FILE exists but is not a regular file" >&2; return 1
  fi

  existing=""
  if [ -f "$CHORUS_SECRET_FILE" ]; then
    existing=$(cat "$CHORUS_SECRET_FILE" 2>/dev/null) || { echo "ERROR: cannot read $CHORUS_SECRET_FILE" >&2; return 1; }
    existing=$(printf '%s' "$existing" | tr -d '[:space:]')
  fi

  if [ -z "$existing" ]; then
    # Exclusive create in a subshell so umask/noclobber never leak into `exec node server.js`.
    # Failure here is tolerated (another process may have won the race) — we re-read below.
    ( umask 077; set -C; rm -f "$CHORUS_SECRET_FILE" 2>/dev/null; openssl rand -hex 32 > "$CHORUS_SECRET_FILE" ) 2>/dev/null || true
    existing=$(cat "$CHORUS_SECRET_FILE" 2>/dev/null | tr -d '[:space:]') || existing=""
    [ -n "$existing" ] || { echo "ERROR: failed to generate $CHORUS_SECRET_FILE" >&2; return 1; }
    action="generated a new random secret and persisted it to $CHORUS_SECRET_FILE"
  else
    action="reusing the persisted secret from $CHORUS_SECRET_FILE"
  fi

  if is_known_insecure_secret "$existing"; then
    echo "ERROR: persisted secret is a known public placeholder; refusing to start" >&2; return 1
  fi

  NEXTAUTH_SECRET="$existing"; export NEXTAUTH_SECRET      # parent shell — not inside the subshell

  case "$reason" in
    missing)        echo "NEXTAUTH_SECRET not set — $action." ;;
    known-insecure) echo "WARNING: NEXTAUTH_SECRET was set to a publicly known placeholder (see GitHub issue #559). Ignoring it — $action." ;;
  esac
  echo "  Make sure $CHORUS_DATA_DIR is a persistent volume, otherwise the secret rotates (and all sessions are invalidated) on every container recreate."
  echo "  Multi-replica deployments MUST set the same NEXTAUTH_SECRET explicitly on every replica."
}
```

Notes:
- `rm -f` before the noclobber write handles the "empty file exists" case (an empty file
  would otherwise block `set -C`). Race: two replicas on a shared volume may both `rm`, but
  the loser's `>` then fails and both re-read — best-effort only, per the single-replica guarantee.
- The value is never echoed. Tests assert the log output does not contain the generated value.
- Trigger position in `docker-entrypoint.sh`: **before** the DATABASE_URL/PGlite branch, so both
  paths get it, and any failure aborts before migrations run:
  ```sh
  . /usr/local/bin/ensure-secret.sh
  ensure_nextauth_secret || exit 1
  ```
- `Dockerfile`: add `COPY docker/ensure-secret.sh /usr/local/bin/` alongside the entrypoint COPY.

### 2. `src/lib/secret-check.ts` (new, pure)

```ts
export const KNOWN_INSECURE_SECRETS = [
  "chorus-docker-secret-change-in-production",
  "chorus-local-secret",
  "your-secret-key-change-in-production",
  "change-me-to-a-random-secret",
] as const;

export type SecretAssessment =
  | { status: "ok" }
  | { status: "missing" }
  | { status: "known_insecure"; matched: string };

export function assessNextAuthSecret(value: string | undefined): SecretAssessment;
```

- `""`/`undefined` → `missing`; an exact match (after trimming surrounding whitespace) → `known_insecure`;
  anything else → `ok`. No length heuristics (explicitly out of scope).
- A test reads `docker/ensure-secret.sh`, extracts the heredoc-style list, and asserts it equals
  `KNOWN_INSECURE_SECRETS` — the two lists cannot drift silently.

### 3. `src/instrumentation.ts`

```ts
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { warnOnInsecureNextAuthSecret } = await import("./lib/secret-check");
    warnOnInsecureNextAuthSecret();   // logs only; never throws
    await import("./services/notification-listener");
  }
}
```

`warnOnInsecureNextAuthSecret()` lives in `secret-check.ts` and uses
`logger.child({ module: "security" })`:

- `known_insecure` → `logger.error({ reason: "default_secret" }, <multi-line message>)`.
  Message content: JWTs (user **and** super-admin sessions) can be forged by anyone who knows the
  public value; run `openssl rand -base64 32` and set `NEXTAUTH_SECRET`; rotating invalidates
  existing sessions; multi-replica must share one value; link to #559.
- `missing` → `logger.warn({ reason: "missing_secret" }, ...)` stating login will fail until set.
  (Behaviour otherwise unchanged — no fallback.)
- `ok` → silent.

Rationale for keeping this even though the entrypoint fixes Docker: it covers non-Docker
starts, operators who paste a placeholder into CDK/ECS env, and any future regression of
the entrypoint.

### 4. Compose files

`docker-compose.yml`:
```yaml
    environment:
      # ── JWT signing secret ───────────────────────────────────────────────
      # Leave empty and the container generates a random secret on first start
      # and persists it in the chorus-app-data volume (single replica only).
      # For production / multi-replica set it explicitly in .env or the env:
      #   openssl rand -base64 32
      # Rotating the secret logs every user out. See docs/DOCKER.md.
      - NEXTAUTH_SECRET=${NEXTAUTH_SECRET:-}
    volumes:
      - chorus-app-data:/app/data
...
volumes:
  chorus-app-data:
```
`docker-compose.local.yml`: same env line + comment; volume already present.

### 5. Documentation

- `docs/DOCKER.md`: replace placeholder values in examples with `${NEXTAUTH_SECRET:-}` / omit;
  new section **"JWT secret security"**: what the secret protects, auto-generation behaviour and
  its single-replica limit, how to generate/set a value, `.env` usage, persistence requirement,
  multi-replica sharing, rotation ⇒ session invalidation, the #559 background.
- `.env.example`: comment above `NEXTAUTH_SECRET` explaining placeholder detection.
- `docs/ARCHITECTURE.md` / `.zh.md`: compose snippet + env table row.
- `CHANGELOG.md` `[0.18.1]` → `### Security` entry with the migration table from proposal.md.

## Testing

| Test | Covers |
|---|---|
| `src/lib/__tests__/secret-check.test.ts` | missing / each placeholder / whitespace-padded placeholder / safe value; list parity with `docker/ensure-secret.sh`; `warnOnInsecureNextAuthSecret` logs error for placeholder, warn for missing, nothing for ok; never throws |
| `src/lib/__tests__/instrumentation.test.ts` | `register()` calls the warning under `NEXT_RUNTIME=nodejs` and skips it otherwise (mock the notification-listener import) |
| `src/lib/__tests__/docker-ensure-secret.test.ts` | spawns `sh` with `CHORUS_DATA_DIR=<tmp>` and sources `docker/ensure-secret.sh`; asserts for: unset env → file created (mode 600), exported value non-empty & not a placeholder; explicit `chorus-docker-secret-change-in-production` → generated, value ≠ constant; each other placeholder → generated; safe env → no file created, value unchanged; existing non-empty file → reused, unchanged; empty / whitespace-only file → regenerated; secret file is a directory → exit 1, no export; unreadable read (simulated via a stub `cat` on PATH returning 1) → exit 1; stdout never contains the value; `umask` in the parent shell unchanged after the call |

Vitest is the runner for the sh test (no new dev dependency); it skips gracefully when `sh` or
`openssl` is unavailable (Windows dev boxes) with an explicit `it.skipIf`.

## Rejected alternatives

### A. Warning only (original Idea text)
Keeps shipping the public value in the compose file; every un-configured deployment remains
forgeable. Rejected by all three reviewing agents and the owner.

### B. In-process random fallback in the app
Rotates on every restart, replicas never agree, and it hides mis-configuration in non-Docker
paths where the current throw is the right behaviour.

### C. Boolean toggle env var (`AUTO_GENERATE_SECRET`)
Default `false` = no fix for the vulnerable population; default `true` = the toggle is
redundant because an explicit `NEXTAUTH_SECRET` already disables generation. Adds a
"toggle vs secret precedence" matrix for no benefit.

### D. Store the secret in the database (upsert-then-read after `prisma migrate deploy`)
Attractive because it needs no volume and shares across replicas, but rejected:
1. **Trust-boundary escalation.** Super-admin auth is env-only today; DB read access cannot
   forge `admin_session`. A DB-stored key turns "can query the DB" into "can forge a super-admin
   session" — the same consequence as #559 with a different precondition.
2. **Default compose exposes the DB.** `docker-compose.yml` maps Postgres to host `:5433` with
   the public `chorus/chorus` credentials, so "can query the DB" is a network-reachable condition
   for exactly the population this fix targets.
3. **Backups and cross-environment leakage.** `pg_dump`, read replicas and prod→staging restores
   would carry the signing key. Rails/Django/Grafana all keep the signing key out of the DB for
   this reason.
4. **Patch footprint.** New Prisma model + migration + a bootstrap script; the standalone image
   has no independently `require`-able Prisma client (`src/generated/prisma` is bundled) and the
   global `prisma` CLI cannot return query results to the shell, so a pg driver would have to be
   added to the image.

### E. `NEXTAUTH_SECRET_FILE` / `NEXTAUTH_SECRET_POLICY=require`
Both useful (Docker/K8s secrets convention; fail-fast for multi-replica ops) but not required
to fix #559. Deferred to a follow-up idea to keep the 0.18.1 patch small.

## Risks

- **Old compose file + new image** → secret rotates on every recreate. Mitigated by the
  unconditional persistence hint in the startup log and the split CHANGELOG entry.
- **Concurrent first start on a shared volume** → best-effort only; documented as unsupported.
- **Placeholder list drift** between sh and TS → parity test.
- **Entrypoint exit on failure** → `set -e` semantics preserved; the function returns non-zero
  and the entrypoint exits 1 with a clear stderr line before running migrations.
