#!/usr/bin/env bash
set -euo pipefail
set +x

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
NONINTERACTIVE="${CHORUS_INSTALL_NONINTERACTIVE:-}"
DRY_RUN="${CHORUS_INSTALL_DRY_RUN:-}"
IMAGE_SOURCE="${CHORUS_IMAGE_SOURCE:-}"
IMAGE="${CHORUS_IMAGE:-}"
PROJECT="${CHORUS_LOCAL_PROJECT:-chorus-local}"
PORT="${CHORUS_PORT:-18637}"
HTTPS_ENABLED="${CHORUS_LOCAL_HTTPS:-}"
HTTPS_HOST="${CHORUS_HTTPS_HOST:-}"
HTTPS_PORT="${CHORUS_HTTPS_PORT:-18638}"
if [ -n "$HTTPS_HOST" ] && [ -z "$HTTPS_ENABLED" ]; then HTTPS_ENABLED=true; fi
EMAIL="${DEFAULT_USER:-}"
LOGIN_PASSWORD="${DEFAULT_PASSWORD:-}"
ADMIN_EMAIL="${SUPER_ADMIN_EMAIL:-}"
ADMIN_PASSWORD_INPUT="${SUPER_ADMIN_PASSWORD:-}"
PASSWORD_FILE=""
ADMIN_PASSWORD_FILE=""
DEPLOY_CONFIG="${CHORUS_DEPLOY_CONFIG:-$ROOT/default_deploy.sh}"
unset DEFAULT_PASSWORD SUPER_ADMIN_PASSWORD

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --image-source|--image|--project|--port|--email|--admin-email|--password-file|--admin-password-file|--https-host|--https-port)
      [ "$#" -ge 2 ] || fail "$1 requires a value"
      case "$1" in
        --image-source) IMAGE_SOURCE="$2" ;;
        --image) IMAGE="$2" ;;
        --project) PROJECT="$2" ;;
        --port) PORT="$2" ;;
        --email) EMAIL="$2" ;;
        --admin-email) ADMIN_EMAIL="$2" ;;
        --password-file) PASSWORD_FILE="$2" ;;
        --admin-password-file) ADMIN_PASSWORD_FILE="$2" ;;
        --https-host) HTTPS_HOST="$2"; HTTPS_ENABLED=true ;;
        --https-port) HTTPS_PORT="$2" ;;
      esac
      shift 2
      ;;
    --https) HTTPS_ENABLED=true; shift ;;
    --no-https) HTTPS_ENABLED=false; shift ;;
    *) fail "Unknown local option: $1" ;;
  esac
done

read_password_file() {
  local file="$1" resolved
  [ -f "$file" ] && [ -r "$file" ] && [ ! -L "$file" ] || fail "Password file must be a readable regular file, not a symlink"
  resolved="$(cd "$(dirname "$file")" && pwd -P)/$(basename "$file")"
  case "$resolved" in "$ROOT"|"$ROOT"/*) fail "Password files must stay outside the source checkout and Docker build context" ;; esac
  cat -- "$file"
}
if [ -n "$PASSWORD_FILE" ]; then LOGIN_PASSWORD="$(read_password_file "$PASSWORD_FILE")"; fi
if [ -n "$ADMIN_PASSWORD_FILE" ]; then ADMIN_PASSWORD_INPUT="$(read_password_file "$ADMIN_PASSWORD_FILE")"; fi

if [ ! -t 0 ] || [ -n "${CHORUS_DAEMON_HEADLESS:-}" ]; then
  NONINTERACTIVE=1
fi
if [ -z "$NONINTERACTIVE" ]; then
  if [ -z "$IMAGE_SOURCE" ]; then
    read -rp "Application image source [pull] (pull|build): " IMAGE_SOURCE
  fi
  IMAGE_SOURCE="${IMAGE_SOURCE:-pull}"
  if [ "$IMAGE_SOURCE" = pull ] && [ -z "$IMAGE" ]; then
    read -rp "Existing Chorus image release tag or digest (required): " IMAGE
  fi
  if [ -z "$EMAIL" ]; then
    read -rp "Ordinary login email (required): " EMAIL
  fi
  if [ -z "$ADMIN_EMAIL" ]; then
    read -rp "Super admin email (required): " ADMIN_EMAIL
  fi
  if [ -z "$DRY_RUN" ]; then
    if [ -z "$LOGIN_PASSWORD" ]; then
      IFS= read -rsp "Ordinary login password (hidden): " LOGIN_PASSWORD
      printf '\n'
      IFS= read -rsp "Confirm ordinary login password: " confirmed_password
      printf '\n'
      [ "$LOGIN_PASSWORD" = "$confirmed_password" ] || fail "Ordinary password confirmation does not match"
    fi
    if [ -z "$ADMIN_PASSWORD_INPUT" ]; then
      IFS= read -rsp "Super admin password (hidden): " ADMIN_PASSWORD_INPUT
      printf '\n'
      IFS= read -rsp "Confirm super admin password: " confirmed_password
      printf '\n'
      [ "$ADMIN_PASSWORD_INPUT" = "$confirmed_password" ] || fail "Super admin password confirmation does not match"
    fi
    unset confirmed_password
  fi
  if [ -z "$HTTPS_ENABLED" ]; then
    read -rp "Also enable self-signed LAN HTTPS? [y/N]: " https_answer
    case "$https_answer" in
      y|Y|yes|YES) HTTPS_ENABLED=true ;;
      n|N|no|NO|"") HTTPS_ENABLED=false ;;
      *) fail "HTTPS selection must be yes or no" ;;
    esac
  fi
  if [ "$HTTPS_ENABLED" = true ] && [ -z "$HTTPS_HOST" ]; then
    read -rp "HTTPS certificate hostname or IPv4 address (required): " HTTPS_HOST
  fi
fi
HTTPS_ENABLED="${HTTPS_ENABLED:-false}"
case "$HTTPS_ENABLED" in true|false) ;; *) fail "CHORUS_LOCAL_HTTPS must be true or false" ;; esac
IMAGE_SOURCE="${IMAGE_SOURCE:-pull}"
case "$IMAGE_SOURCE" in pull|build) ;; *) fail "Image source must be pull or build" ;; esac
[[ "$PROJECT" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || fail "Invalid Compose project name"
[[ "$PORT" =~ ^[0-9]{1,5}$ ]] || fail "Port must be an integer from 1 to 65535"
PORT=$((10#$PORT))
[ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || fail "Port must be from 1 to 65535"
if [ "$HTTPS_ENABLED" = true ]; then
  [[ "$HTTPS_PORT" =~ ^[0-9]{1,5}$ ]] || fail "HTTPS port must be an integer from 1 to 65535"
  HTTPS_PORT=$((10#$HTTPS_PORT))
  [ "$HTTPS_PORT" -ge 1 ] && [ "$HTTPS_PORT" -le 65535 ] || fail "HTTPS port must be from 1 to 65535"
  [ "$HTTPS_PORT" -ne "$PORT" ] || fail "HTTP and HTTPS ports must be different"
  [ -n "$HTTPS_HOST" ] && [ "${#HTTPS_HOST}" -le 253 ] || fail "HTTPS requires a hostname or IPv4 address via --https-host"
  if [[ "$HTTPS_HOST" =~ ^[0-9.]+$ ]]; then
    [[ "$HTTPS_HOST" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "Invalid HTTPS IPv4 address"
    IFS=. read -r -a host_parts <<< "$HTTPS_HOST"
    for host_part in "${host_parts[@]}"; do
      [[ "$host_part" =~ ^(0|[1-9][0-9]{0,2})$ ]] && [ "$host_part" -le 255 ] || fail "Invalid HTTPS IPv4 address"
    done
    HTTPS_SAN="IP:$HTTPS_HOST"
  else
    [[ "$HTTPS_HOST" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] || fail "HTTPS host must be a DNS hostname or IPv4 address, not a URL or IPv6 address"
    IFS=. read -r -a host_parts <<< "$HTTPS_HOST"
    for host_part in "${host_parts[@]}"; do
      [ "${#host_part}" -le 63 ] && [[ "$host_part" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$ ]] || fail "Invalid HTTPS hostname label"
    done
    HTTPS_SAN="DNS:$HTTPS_HOST"
  fi
fi
[[ "$EMAIL" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$ ]] || fail "Set a valid bootstrap email with --email or DEFAULT_USER"
[[ "$ADMIN_EMAIL" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$ ]] || fail "Set a valid super admin email with --admin-email or SUPER_ADMIN_EMAIL"
validate_password() {
  local value="$1" label="$2" LC_ALL=C
  [ "${#value}" -ge 8 ] || fail "$label password requires at least 8 bytes"
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || fail "$label password must be a single line"
  if [ "$label" = "Super admin" ]; then
    [ "${#value}" -le 72 ] || fail "Super admin password must not exceed bcrypt's 72-byte limit"
  fi
}
if [ -z "$DRY_RUN" ]; then
  validate_password "$LOGIN_PASSWORD" Ordinary
  validate_password "$ADMIN_PASSWORD_INPUT" "Super admin"
fi
if [ "$IMAGE_SOURCE" = build ] && [ -z "$IMAGE" ]; then
  IMAGE="chorus-local:$PROJECT"
fi
[[ "$IMAGE" =~ ^[A-Za-z0-9][A-Za-z0-9._/:@-]*$ ]] || fail "Set an image reference with --image or CHORUS_IMAGE"
image_tail="${IMAGE##*/}"
[[ "$image_tail" == *:* && "$image_tail" != *: ]] || fail "Image requires an explicit tag or digest"
[[ "$image_tail" != *:latest ]] || fail "Choose an explicit release/digest or local build tag, not latest"
if [ "$IMAGE_SOURCE" = build ] && [[ "$IMAGE" == *@* ]]; then
  fail "A local build requires a tag, not an immutable digest"
fi

[ -n "${HOME:-}" ] && [ -d "$HOME" ] || fail "HOME must be an existing directory"
PRIVATE_DIR="$(cd "$HOME" && pwd -P)/.config/chorus-self-host/$PROJECT"
ENV_FILE="$PRIVATE_DIR/env"
if [ -e "$PRIVATE_DIR" ] || [ -L "$PRIVATE_DIR" ]; then
  fail "Private project directory already exists; rerun its saved default_deploy.sh or Compose config. Nothing overwritten."
fi
if [ -e "$DEPLOY_CONFIG" ] || [ -L "$DEPLOY_CONFIG" ]; then
  fail "Deployment script already exists; rerun it or select a new CHORUS_DEPLOY_CONFIG path. Nothing overwritten."
fi
[ -d "$(dirname "$DEPLOY_CONFIG")" ] || fail "Deployment script parent directory must exist"
ancestor="$(dirname "$PRIVATE_DIR")"
while [ ! -e "$ancestor" ] && [ ! -L "$ancestor" ]; do ancestor="$(dirname "$ancestor")"; done
resolved_ancestor="$(cd "$ancestor" && pwd -P)" || fail "Invalid private configuration directory"
case "$resolved_ancestor" in "$ROOT"|"$ROOT"/*) fail "Private configuration must be outside the source checkout" ;; esac

printf 'Local deployment: project=%s source=%s image=%s listen=0.0.0.0:%s\n' "$PROJECT" "$IMAGE_SOURCE" "$IMAGE" "$PORT"
printf 'LAN HTTP access: restrict this port to trusted networks; do not expose it to the public Internet.\n'
if [ "$HTTPS_ENABLED" = true ]; then
  printf 'Optional HTTPS: https://%s:%s (30-day self-signed certificate; manual browser warning acceptance required).\n' "$HTTPS_HOST" "$HTTPS_PORT"
  printf 'Register the exact OIDC callback https://%s:%s/login/callback with your identity provider; keep existing callbacks.\n' "$HTTPS_HOST" "$HTTPS_PORT"
fi
if [ -n "$DRY_RUN" ]; then
  printf 'Dry run: no files, credentials, images or containers will be changed.\n'
  if [ "$IMAGE_SOURCE" = pull ]; then
    printf 'Would pull application image %s\n' "$IMAGE"
  else
    printf 'Would build Dockerfile target production from %s as %s\n' "$ROOT" "$IMAGE"
  fi
  printf 'Would pull postgres:17-alpine, create private config at %s, then start LAN-accessible Compose with --wait.\n' "$ENV_FILE"
  printf 'Would hash the super admin password with bcrypt and generate %s for repeat deployments.\n' "$DEPLOY_CONFIG"
  if [ "$HTTPS_ENABLED" = true ]; then
    printf 'Would generate private TLS material outside the checkout and add lan-https.yml to Compose; Cloudflare origin remains http://app:8637.\n'
  fi
  exit 0
fi

for dependency in docker openssl; do
  command -v "$dependency" >/dev/null 2>&1 || fail "$dependency is required for local deployment"
done
docker compose version >/dev/null
docker info >/dev/null
existing_containers="$(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT")"
existing_volumes="$(docker volume ls -q --filter "label=com.docker.compose.project=$PROJECT")"
existing_networks="$(docker network ls -q --filter "label=com.docker.compose.project=$PROJECT")"
if [ -n "$existing_containers$existing_volumes$existing_networks" ]; then
  fail "Compose project resources already exist; choose another --project. Nothing reused."
fi

reject_existing_names() {
  local kind="$1" names="$2" actual expected
  shift 2
  while IFS= read -r actual; do
    for expected in "$@"; do
      [ "$actual" != "$expected" ] || fail "Existing $kind named $expected, regardless of labels. Nothing reused."
    done
  done <<< "$names"
}

volume_names="$(docker volume ls --format '{{.Name}}')"
reject_existing_names volume "$volume_names" "${PROJECT}_app-data" "${PROJECT}_db-data"
network_names="$(docker network ls --format '{{.Name}}')"
reject_existing_names network "$network_names" "${PROJECT}_default"
container_names="$(docker ps -a --format '{{.Names}}')"
reject_existing_names container "$container_names" \
  "${PROJECT}-app-1" "${PROJECT}-db-1" "${PROJECT}_app_1" "${PROJECT}_db_1"
if [ "$HTTPS_ENABLED" = true ]; then
  reject_existing_names container "$container_names" "${PROJECT}-lan-https-1" "${PROJECT}_lan-https_1"
fi

if [ "$IMAGE_SOURCE" = pull ]; then
  docker pull "$IMAGE"
else
  docker build --target production --file "$ROOT/Dockerfile" --tag "$IMAGE" "$ROOT"
fi
docker pull postgres:17-alpine
docker pull httpd:2.4-alpine
admin_hash="$(printf '%s\n' "$ADMIN_PASSWORD_INPUT" | docker run --rm -i --network none --read-only --cap-drop ALL --security-opt no-new-privileges --entrypoint htpasswd httpd:2.4-alpine -niBC 12 '')"
admin_hash="${admin_hash#:}"
[[ "$admin_hash" =~ ^\$2[aby]\$12\$[./A-Za-z0-9]{53}$ ]] || fail "bcrypt generation returned an invalid hash"
unset ADMIN_PASSWORD_INPUT

database_password="$(openssl rand -hex 32)"
[[ "$database_password" =~ ^[a-f0-9]{64}$ ]] || fail "Secure password generation failed"
umask 077
mkdir -p "$(dirname "$PRIVATE_DIR")"
mkdir -m 700 "$PRIVATE_DIR"
write_private_value() {
  local value="${2//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//\$/\$\$}"
  printf '%s="%s"\n' "$1" "$value"
}
{
  printf 'CHORUS_IMAGE=%s\nPOSTGRES_IMAGE=postgres:17-alpine\n' "$IMAGE"
  printf 'POSTGRES_PASSWORD=%s\nDEFAULT_USER=%s\n' "$database_password" "$EMAIL"
  write_private_value DEFAULT_PASSWORD "$LOGIN_PASSWORD"
  printf 'CHORUS_PORT=%s\nNEXTAUTH_SECRET=\nSUPER_ADMIN_EMAIL=%s\n' "$PORT" "$ADMIN_EMAIL"
  printf "SUPER_ADMIN_PASSWORD_HASH='%s'\n" "$admin_hash"
} > "$ENV_FILE"
unset database_password LOGIN_PASSWORD admin_hash
COMPOSE_FILES=(-f "$ROOT/deploy/self-host/compose.yml" -f "$ROOT/deploy/self-host/compose.local.yml")
if [ "$HTTPS_ENABLED" = true ]; then
  mkdir -m 700 "$PRIVATE_DIR/lan-tls"
  openssl req -x509 -newkey rsa:3072 -sha256 -days 30 -nodes \
    -keyout "$PRIVATE_DIR/lan-tls/server.key" -out "$PRIVATE_DIR/lan-tls/server.crt" \
    -subj '/CN=Chorus LAN' -addext "subjectAltName=$HTTPS_SAN" \
    -addext 'extendedKeyUsage=serverAuth' -addext 'basicConstraints=critical,CA:FALSE'
  {
    printf 'CHORUS_HTTPS_HOST=%s\nCHORUS_HTTPS_PORT=%s\n' "$HTTPS_HOST" "$HTTPS_PORT"
    write_private_value CHORUS_TLS_CERT_FILE "$PRIVATE_DIR/lan-tls/server.crt"
    write_private_value CHORUS_TLS_KEY_FILE "$PRIVATE_DIR/lan-tls/server.key"
  } >> "$ENV_FILE"
  cp "$ROOT/deploy/self-host/compose.lan-https.yml" "$PRIVATE_DIR/lan-https.yml"
  COMPOSE_FILES+=(-f "$PRIVATE_DIR/lan-https.yml")
fi
(
  set -o noclobber
  {
    printf '#!/usr/bin/env bash\nset -euo pipefail\nset +x\nCHORUS_DEPLOY_TARGET=local\n'
    printf 'for option in "$@"; do\n  [ "$option" = --dry-run ] || { printf "ERROR: Saved deployment accepts only --dry-run.\\n" >&2; exit 1; }\ndone\n'
    printf 'ROOT=%q\n' "$ROOT"
    printf 'SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"\n'
    printf 'if [ -f "$SCRIPT_DIR/deploy/self-host/deploy-local.sh" ]; then ROOT="$SCRIPT_DIR"; fi\n'
    printf 'exec bash "$ROOT/deploy/self-host/deploy-local.sh" --project %q --private-dir %q --image-source %q "$@"\n' "$PROJECT" "$PRIVATE_DIR" "$IMAGE_SOURCE"
  } > "$DEPLOY_CONFIG"
)
chmod 700 "$DEPLOY_CONFIG"

compose() (
  unset CHORUS_IMAGE POSTGRES_IMAGE POSTGRES_PASSWORD DEFAULT_USER DEFAULT_PASSWORD
  unset CHORUS_PORT NEXTAUTH_SECRET SUPER_ADMIN_EMAIL SUPER_ADMIN_PASSWORD SUPER_ADMIN_PASSWORD_HASH COMPOSE_FILE COMPOSE_PROJECT_NAME
  unset CHORUS_HTTPS_PORT CHORUS_HTTPS_IMAGE CHORUS_TLS_CERT_FILE CHORUS_TLS_KEY_FILE
  docker compose --project-name "$PROJECT" --env-file "$ENV_FILE" "${COMPOSE_FILES[@]}" "$@"
)
compose config --quiet
if [ "$HTTPS_ENABLED" = true ]; then compose pull lan-https; fi
if ! compose up -d --pull never --wait --wait-timeout 180; then
  printf 'ERROR: Startup failed; retain private config at %s and inspect only this project. No resources were deleted.\n' "$ENV_FILE" >&2
  exit 1
fi
printf 'Ready: http://localhost:%s\n' "$PORT"
printf 'LAN: http://<host-LAN-IP>:%s (listening on 0.0.0.0).\n' "$PORT"
if [ "$HTTPS_ENABLED" = true ]; then
  printf 'HTTPS ready: https://%s:%s (accept only this known local certificate warning; see the guide for renewal).\n' "$HTTPS_HOST" "$HTTPS_PORT"
fi
printf 'Private login/config saved to %s (password not printed).\n' "$ENV_FILE"
printf 'Repeat deployment with: bash %q (reuses saved accounts/data; build mode rebuilds this checkout).\n' "$DEPLOY_CONFIG"
printf 'Manage/stop with: docker compose --project-name %q --env-file %q' "$PROJECT" "$ENV_FILE"
printf ' %q' "${COMPOSE_FILES[@]}"
printf ' stop\n'
printf 'See docs/SELF_HOST.md or docs/SELF_HOST.zh.md for OIDC, optional Tunnel and backups.\n'
