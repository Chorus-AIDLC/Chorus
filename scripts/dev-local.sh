#!/usr/bin/env bash
set -euo pipefail

PGLITE_DIR="${PGLITE_DIR:-.pglite}"
# Resolve ~ to $HOME (tilde isn't expanded inside quotes)
PGLITE_DIR="${PGLITE_DIR/#\~/$HOME}"
PGLITE_PORT=5433
DATABASE_URL="postgresql://postgres:postgres@localhost:${PGLITE_PORT}/postgres?sslmode=disable"
MAX_RETRIES=30

cleanup() {
  if [ -n "${PGLITE_PID:-}" ]; then
    if [ "${USE_SETSID:-}" = true ]; then
      # Kill the entire process group (setsid gave it its own PGID)
      kill -- -"$PGLITE_PID" 2>/dev/null || true
    else
      # No setsid (macOS) — kill child tree manually
      pkill -TERM -P "$PGLITE_PID" 2>/dev/null || true
      kill "$PGLITE_PID" 2>/dev/null || true
    fi
    wait "$PGLITE_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

# 1. Start pglite-server in background
echo "Starting embedded PostgreSQL (PGlite) on port ${PGLITE_PORT}..."
if command -v setsid >/dev/null 2>&1; then
  USE_SETSID=true
  setsid npx pglite-server --db="${PGLITE_DIR}" --port="${PGLITE_PORT}" --max-connections=10 &
else
  npx pglite-server --db="${PGLITE_DIR}" --port="${PGLITE_PORT}" --max-connections=10 &
fi
PGLITE_PID=$!

# 2. Wait for readiness (pure bash TCP check — no pg_isready dependency)
READY=false
for i in $(seq 1 $MAX_RETRIES); do
  if (echo > /dev/tcp/localhost/${PGLITE_PORT}) 2>/dev/null; then
    READY=true
    break
  fi
  sleep 0.5
done

if [ "$READY" = false ]; then
  echo "" >&2
  echo "ERROR: PGlite failed to start within $((MAX_RETRIES / 2)) seconds." >&2
  echo "" >&2
  echo "Possible causes:" >&2
  echo "  - Port ${PGLITE_PORT} is already in use (run: lsof -i :${PGLITE_PORT})" >&2
  echo "  - Corrupt data in ${PGLITE_DIR}/ (run: rm -rf ${PGLITE_DIR}/)" >&2
  exit 1
fi

echo "PGlite ready on port ${PGLITE_PORT}"

# 3. Apply schema
echo "Applying database schema..."
DATABASE_URL="${DATABASE_URL}" npx prisma db push 2>&1

# 4. Start dev server
echo ""
echo "Starting Next.js dev server..."
echo "  Database: PGlite (embedded, data in ${PGLITE_DIR}/)"
echo "  DB URL:   ${DATABASE_URL}"
echo "  App:      http://localhost:8637"
echo ""
DATABASE_URL="${DATABASE_URL}" PORT=8637 pnpm dev
