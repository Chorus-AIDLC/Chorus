#!/usr/bin/env bash
set -euo pipefail
set +x

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
SOURCE=""
TARGET=""
BACKUP=""
PASSWORD_FILE=""
DATABASE=chorus
DB_USER=chorus
OFFLINE=""
DRY_RUN=""
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
while [ "$#" -gt 0 ]; do
  case "$1" in
    --source-volume|--target-volume|--backup-dir|--password-file|--database|--db-user)
      [ "$#" -ge 2 ] || fail "$1 requires a value"
      case "$1" in
        --source-volume) SOURCE="$2" ;;
        --target-volume) TARGET="$2" ;;
        --backup-dir) BACKUP="$2" ;;
        --password-file) PASSWORD_FILE="$2" ;;
        --database) DATABASE="$2" ;;
        --db-user) DB_USER="$2" ;;
      esac
      shift 2 ;;
    --writers-stopped) OFFLINE=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --help|-h)
      printf '%s\n' 'Usage: bash deploy/self-host/migrate-pg16-to-17.sh --source-volume OLD --target-volume NEW --backup-dir /private/new-dir --password-file /private/db-password --writers-stopped [--database chorus] [--db-user chorus] [--dry-run]' \
        'Offline, single public-schema database migration using cached postgres:16-alpine and postgres:17-alpine images.' \
        'Stop ALL writers and the old database first; keep them stopped through validation/cutover. Source volume is read-only.' \
        'Copies the old cluster, backs up globals/database, restores into a NEW volume, and compares table counts and sequence state.' \
        'Does not switch Compose, upgrade app schema, migrate roles/ACLs, or delete any volume. Target password must match your app configuration.'
      exit 0 ;;
    *) fail "Unknown option: $1" ;;
  esac
done
for volume in "$SOURCE" "$TARGET"; do
  [[ "$volume" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]] || fail "Explicit source and target volume names are required"
done
[ "$SOURCE" != "$TARGET" ] || fail "Source and target must differ"
for identifier in "$DATABASE" "$DB_USER"; do
  [[ "$identifier" =~ ^[a-z][a-z0-9_]*$ ]] || fail "Database/user must be lowercase SQL identifiers"
done
[ "$DATABASE" != postgres ] && [ "$DATABASE" != template0 ] && [ "$DATABASE" != template1 ] || fail "Select an application database"
[[ "$BACKUP" = /* && "$PASSWORD_FILE" = /* ]] || fail "Backup directory and password file must be absolute paths"
[ -n "$OFFLINE" ] || fail "Stop all writers and the source DB, then pass --writers-stopped"
CLONE="${TARGET}-source16"
OLD_CONTAINER="${TARGET}-source16"
NEW_CONTAINER="${TARGET}-target17"
[ "$SOURCE" != "$CLONE" ] || fail "Source conflicts with the working volume name"
if [ -n "$DRY_RUN" ]; then
  printf 'Plan only: read-only copy of %s into %s; dump %s; restore into new PG17 volume %s; validate; no automatic cutover.\n' "$SOURCE" "$CLONE" "$DATABASE" "$TARGET"
  exit 0
fi
[ -f "$PASSWORD_FILE" ] && [ -r "$PASSWORD_FILE" ] && [ ! -L "$PASSWORD_FILE" ] || fail "Password file must be readable, regular and not a symlink"
PASSWORD_FILE="$(cd "$(dirname "$PASSWORD_FILE")" && pwd -P)/$(basename "$PASSWORD_FILE")"
BACKUP="$(cd "$(dirname "$BACKUP")" && pwd -P)/$(basename "$BACKUP")"
for private_path in "$PASSWORD_FILE" "$BACKUP"; do
  case "$private_path" in "$ROOT"|"$ROOT"/*) fail "Private files must be outside the checkout/build context" ;; esac
  [[ "$private_path" != *$'\n'* && "$private_path" != *,* ]] || fail "Private paths cannot contain newlines or commas"
done
[ ! -e "$BACKUP" ] && [ ! -L "$BACKUP" ] || fail "Backup directory already exists; nothing overwritten"
permissions="$(stat -c %a "$PASSWORD_FILE")"
(( (8#$permissions & 077) == 0 )) || fail "Password file must not grant group/other access (use chmod 600)"
password="$(cat "$PASSWORD_FILE")"
[ -n "$password" ] && [[ "$password" != *$'\n'* && "$password" != *$'\r'* ]] || fail "Password must be nonempty and single-line"
unset password
docker info >/dev/null
for image in postgres:16-alpine postgres:17-alpine; do
  docker image inspect "$image" >/dev/null 2>&1 || fail "First pull the required image: $image"
done
volume_names="$(docker volume ls --format '{{.Name}}')"
container_names="$(docker ps -a --format '{{.Names}}')"
has_name() { printf '%s\n' "$1" | grep -Fxq -- "$2"; }
has_name "$volume_names" "$SOURCE" || fail "Source volume does not exist"
for name in "$TARGET" "$CLONE"; do
  if has_name "$volume_names" "$name"; then fail "Volume already exists: $name; choose a new target"; fi
done
for name in "$OLD_CONTAINER" "$NEW_CONTAINER"; do
  if has_name "$container_names" "$name"; then fail "Container already exists: $name"; fi
done
assert_offline() {
  local running
  running="$(docker ps --filter "volume=$SOURCE" --format '{{.ID}}')"
  [ -z "$running" ] || fail "Source volume is mounted by a running container; stop it first"
}
assert_offline
version="$(docker run --rm --pull never --network none --mount "type=volume,src=$SOURCE,dst=/source,readonly" --entrypoint sh postgres:16-alpine -c 'cat /source/PG_VERSION')"
[ "$version" = 16 ] || fail "Source must be PG16, not $version"
umask 077
mkdir -m 700 "$BACKUP"
cp "$PASSWORD_FILE" "$BACKUP/target-password"
chmod 600 "$BACKUP/target-password"
OLD_CREATED=""
NEW_CREATED=""
cleanup() {
  local result=$?
  trap - EXIT
  if [ -n "$OLD_CREATED" ]; then docker stop "$OLD_CONTAINER" >/dev/null || result=1; fi
  if [ -n "$NEW_CREATED" ]; then docker stop "$NEW_CONTAINER" >/dev/null || result=1; fi
  if [ "$result" -ne 0 ]; then
    printf 'Migration incomplete. Keep source offline until inspected. Original volume retained; diagnostics/backups: %s. No cutover.\n' "$BACKUP" >&2
  fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
printf 'Copying offline source; all data/logs stay in the private backup directory.\n'
create_volume() {
  docker volume create --label "chorus.pg-upgrade=$BACKUP" "$1" >/dev/null
  local owner
  owner="$(docker volume inspect --format '{{index .Labels "chorus.pg-upgrade"}}' "$1")"
  [ "$owner" = "$BACKUP" ] || fail "Volume ownership changed; refusing to mount $1"
}
create_volume "$CLONE"
assert_offline
docker run --rm --pull never --network none --mount "type=volume,src=$SOURCE,dst=/source,readonly" --mount "type=volume,src=$CLONE,dst=/clone" --entrypoint sh postgres:16-alpine -c 'cp -a /source/. /clone/' >"$BACKUP/copy.log" 2>&1
assert_offline
docker create --name "$OLD_CONTAINER" --network none --mount "type=volume,src=$CLONE,dst=/var/lib/postgresql/data" postgres:16-alpine >"$BACKUP/source-container-id"
OLD_CREATED=1
docker start "$OLD_CONTAINER" >/dev/null
wait_ready() {
  local container="$1" attempt
  for attempt in {1..60}; do
    if docker exec --user postgres "$container" pg_isready -h 127.0.0.1 -U "$DB_USER" -d "$DATABASE" >/dev/null 2>&1; then return; fi
    sleep 1
  done
  docker logs "$container" >"$BACKUP/$container.log" 2>&1
  fail "Database did not become ready; inspect protected logs"
}
sql() { docker exec -i --user postgres "$1" psql -X -qAt -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DATABASE"; }
wait_ready "$OLD_CONTAINER"
unsupported="$(sql "$OLD_CONTAINER" <<'SQL'
SELECT count(*) FROM pg_namespace WHERE nspname NOT IN ('public','information_schema') AND nspname !~ '^pg_';
SELECT count(*) FROM pg_extension WHERE extname <> 'plpgsql';
SELECT count(*) FROM pg_foreign_table;
SELECT count(*) FROM pg_class WHERE relkind IN ('r','p','m') AND relrowsecurity;
SQL
)"
[ "$unsupported" = $'0\n0\n0\n0' ] || fail "Only public-schema databases without extra extensions, foreign tables or RLS are supported; use a DBA-assisted migration"
docker exec --user postgres "$OLD_CONTAINER" pg_dumpall -U "$DB_USER" --globals-only >"$BACKUP/globals.sql" 2>"$BACKUP/globals.log"
docker exec --user postgres "$OLD_CONTAINER" pg_dump -U "$DB_USER" -d "$DATABASE" -Fc >"$BACKUP/database.dump" 2>"$BACKUP/dump.log"
snapshot() {
  sql "$1" <<'SQL'
SELECT format('SELECT %L || ''|'' || count(*)::text FROM %I.%I;', 'table:' || schemaname || '.' || tablename, schemaname, tablename) FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename
\gexec
SELECT format('SELECT %L || ''|'' || last_value::text || ''|'' || is_called::text FROM %I.%I;', 'sequence:' || schemaname || '.' || sequencename, schemaname, sequencename) FROM pg_sequences WHERE schemaname = 'public' ORDER BY sequencename
\gexec
SQL
}
snapshot "$OLD_CONTAINER" >"$BACKUP/source-counts-sequences.txt"
create_volume "$TARGET"
docker create --name "$NEW_CONTAINER" --network none --mount "type=volume,src=$TARGET,dst=/var/lib/postgresql/data" --mount "type=bind,src=$BACKUP/target-password,dst=/run/secrets/db-password,readonly" -e "POSTGRES_USER=$DB_USER" -e "POSTGRES_DB=$DATABASE" -e POSTGRES_PASSWORD_FILE=/run/secrets/db-password postgres:17-alpine >"$BACKUP/target-container-id"
NEW_CREATED=1
docker start "$NEW_CONTAINER" >/dev/null
wait_ready "$NEW_CONTAINER"
docker exec -i --user postgres "$NEW_CONTAINER" pg_restore -U "$DB_USER" -d "$DATABASE" --no-owner --no-privileges --exit-on-error --single-transaction <"$BACKUP/database.dump" >"$BACKUP/restore.log" 2>&1
snapshot "$NEW_CONTAINER" >"$BACKUP/target-counts-sequences.txt"
cmp -s "$BACKUP/source-counts-sequences.txt" "$BACKUP/target-counts-sequences.txt" || fail "Table counts or sequence state differ; do not cut over"
sql "$NEW_CONTAINER" >"$BACKUP/analyze.log" 2>&1 <<'SQL'
ANALYZE;
SQL
assert_offline
(cd "$BACKUP" && sha256sum database.dump globals.sql > SHA256SUMS)
printf 'Validated PG16 -> PG17: %s -> %s. Table counts and sequence states match.\n' "$SOURCE" "$TARGET"
printf 'Backups: %s\nHelpers will be stopped; all volumes retained. No Compose switch performed.\n' "$BACKUP"
printf 'Keep writers stopped; follow docs/POSTGRES_UPGRADE.md to validate the application and cut over.\n'
