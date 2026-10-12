#!/usr/bin/env bash
set -euo pipefail
set +x

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
PROJECT=""
PRIVATE_DIR=""
IMAGE_SOURCE=""
DRY_RUN=""
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --project|--private-dir|--image-source)
      [ "$#" -ge 2 ] || fail "$1 requires a value"
      case "$1" in
        --project) PROJECT="$2" ;;
        --private-dir) PRIVATE_DIR="$2" ;;
        --image-source) IMAGE_SOURCE="$2" ;;
      esac
      shift 2
      ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) fail "Unknown deployment option: $1" ;;
  esac
done

[[ "$PROJECT" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || fail "Invalid Compose project name"
case "$IMAGE_SOURCE" in pull|build) ;; *) fail "Image source must be pull or build" ;; esac
[[ "$PRIVATE_DIR" = /* ]] || fail "Private directory must be absolute"
ENV_FILE="$PRIVATE_DIR/env"
[ -f "$ENV_FILE" ] || fail "Saved private env is missing; no credentials will be regenerated"
IMAGE=""
POSTGRES_IMAGE=""
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    CHORUS_IMAGE=*) [ -z "$IMAGE" ] || fail "Duplicate CHORUS_IMAGE"; IMAGE="${line#*=}" ;;
    POSTGRES_IMAGE=*) [ -z "$POSTGRES_IMAGE" ] || fail "Duplicate POSTGRES_IMAGE"; POSTGRES_IMAGE="${line#*=}" ;;
  esac
done < "$ENV_FILE"
unset line
for image_value in "$IMAGE" "$POSTGRES_IMAGE"; do
  [[ "$image_value" =~ ^[A-Za-z0-9][A-Za-z0-9._/:@-]*$ ]] || fail "Saved image references must be explicit, unquoted tags/digests"
  image_tail="${image_value##*/}"
  [[ "$image_tail" == *:* && "$image_tail" != *: && "$image_tail" != *:latest ]] || fail "Saved images need explicit tags/digests, not latest"
done
if [ "$IMAGE_SOURCE" = build ] && [[ "$IMAGE" == *@* ]]; then
  fail "Build mode requires a mutable local image tag"
fi
COMPOSE_FILES=(-f "$ROOT/deploy/self-host/compose.yml" -f "$ROOT/deploy/self-host/compose.local.yml")
for override in https.yml pg17.yml; do
  if [ -f "$PRIVATE_DIR/$override" ]; then
    COMPOSE_FILES+=(-f "$PRIVATE_DIR/$override")
  fi
done
compose() (
  unset CHORUS_IMAGE POSTGRES_IMAGE POSTGRES_PASSWORD DEFAULT_USER DEFAULT_PASSWORD
  unset CHORUS_PORT NEXTAUTH_SECRET SUPER_ADMIN_EMAIL SUPER_ADMIN_PASSWORD SUPER_ADMIN_PASSWORD_HASH COMPOSE_FILE COMPOSE_PROJECT_NAME
  docker compose --project-name "$PROJECT" --env-file "$ENV_FILE" "${COMPOSE_FILES[@]}" "$@"
)

printf 'Redeploy project=%s source=%s image=%s using existing private configuration.\n' "$PROJECT" "$IMAGE_SOURCE" "$IMAGE"
if [ -n "$DRY_RUN" ]; then
  printf 'Dry run: would %s the application, ensure the saved database image, then Compose up --pull never --wait; no changes.\n' "$IMAGE_SOURCE"
  printf 'Compose files:'
  printf ' %q' "${COMPOSE_FILES[@]}"
  printf '\n'
  exit 0
fi
docker compose version >/dev/null
docker info >/dev/null
compose config --quiet
if [ "$IMAGE_SOURCE" = build ]; then
  docker build --target production --file "$ROOT/Dockerfile" --tag "$IMAGE" "$ROOT"
else
  docker pull "$IMAGE"
fi
if ! docker image inspect "$POSTGRES_IMAGE" >/dev/null 2>&1; then
  docker pull "$POSTGRES_IMAGE"
fi
compose up -d --pull never --wait --wait-timeout 180
printf 'Deployment ready; existing credentials, volumes and private overrides retained.\n'
