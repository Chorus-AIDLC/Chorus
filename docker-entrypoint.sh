#!/bin/sh
set -e

# Build DATABASE_URL from individual env vars if not already set
if [ -n "$DB_HOST" ] && [ -z "$DATABASE_URL" ]; then
  export DATABASE_URL="postgresql://${DB_USERNAME}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}"
fi

# If no database configured at all, start embedded PGlite
if [ -z "$DATABASE_URL" ]; then
  PGLITE_DIR="/app/data/pglite"
  PGLITE_PORT=5433
  export DATABASE_URL="postgresql://postgres:postgres@localhost:${PGLITE_PORT}/postgres?sslmode=disable"

  echo "No DATABASE_URL configured. Starting embedded PGlite..."
  mkdir -p "$PGLITE_DIR"
  node node_modules/@electric-sql/pglite-socket/dist/scripts/server.js \
    --db="$PGLITE_DIR" --port="$PGLITE_PORT" --max-connections=10 &

  # Wait for readiness (sh-compatible, no /dev/tcp in alpine)
  echo "Waiting for PGlite to be ready..."
  READY=false
  for i in $(seq 1 30); do
    if node -e "require('net').connect($PGLITE_PORT,'localhost').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))" 2>/dev/null; then
      READY=true
      break
    fi
    sleep 0.5
  done

  if [ "$READY" = false ]; then
    echo "ERROR: PGlite failed to start within 15 seconds." >&2
    exit 1
  fi

  echo "PGlite ready on port ${PGLITE_PORT}."
fi

# Run database migrations (same path for external PG and embedded PGlite)
echo "Running database migrations (will retry for ~5 minutes while waiting for DB)..."
MAX_RETRIES=30
RETRY_INTERVAL=10
RETRY_COUNT=0
until prisma migrate deploy; do
  RETRY_COUNT=$((RETRY_COUNT + 1))
  if [ "$RETRY_COUNT" -ge "$MAX_RETRIES" ]; then
    echo "Migration failed after ${MAX_RETRIES} retries. Exiting."
    exit 1
  fi
  echo "Migration failed (attempt ${RETRY_COUNT}/${MAX_RETRIES}). Retrying in ${RETRY_INTERVAL}s..."
  sleep "$RETRY_INTERVAL"
done
echo "Migration completed successfully."

echo "Starting application..."
exec "$@"
