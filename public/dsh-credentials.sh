#!/usr/bin/env bash
# Chorus credential writer for DeepSeek Harness (dsh).
#
# Stores CHORUS_URL + CHORUS_API_KEY in $DSH_HOME/.env (mode 0600) so the Chorus
# dsh plugin and its OpenSpec document-mirror wrapper can read them. dsh
# deliberately scrubs credential-shaped environment variables from tool
# subprocesses, so the wrapper cannot inherit CHORUS_API_KEY from the shell — it
# reads it from $DSH_HOME/.env, dsh's own read-only credential fallback.
#
# Non-interactive (onboarding):
#   CHORUS_URL=https://chorus.example CHORUS_API_KEY=cho_... \
#     bash <(curl -fsSL https://chorus.example/dsh-credentials.sh)
#
# This script only writes credentials; the plugin itself is installed with
# `dsh plugin --profile <name> add @chorus-aidlc/chorus-dsh -w`.
#
# Bash 3.2 compatible (macOS /bin/bash).

set -euo pipefail

BOLD=$'\033[1m'
DIM=$'\033[2m'
GREEN=$'\033[32m'
RED=$'\033[31m'
RESET=$'\033[0m'

ok() { printf "${GREEN}OK${RESET} %s\n" "$*"; }
die() { printf "${RED}ERROR${RESET} %s\n" "$*" >&2; exit 1; }

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
ENV_FILE="$DSH_HOME/.env"

case "${1:-}" in
  "") ;;
  -h|--help)
    cat <<'USAGE'
dsh-credentials.sh - store Chorus credentials in $DSH_HOME/.env (mode 0600).

Environment:
  CHORUS_URL      Chorus base URL, e.g. https://chorus.example.com.
                  A trailing /api/mcp is accepted and normalized away.
  CHORUS_API_KEY  Chorus agent API key beginning with cho_.
  DSH_HOME        Harness home (default: ~/.dsh).

Both values can be entered interactively when a terminal is available.
Existing non-Chorus lines in .env are preserved.
USAGE
    exit 0
    ;;
  *)
    die "Unknown argument: $1 (try --help)"
    ;;
esac

case "$DSH_HOME" in
  *$'\n'*|*$'\r'*) die "DSH_HOME must not contain control characters." ;;
esac

# curl | bash consumes stdin. Reopen a real terminal only when input is needed.
if { [ -z "${CHORUS_URL:-}" ] || [ -z "${CHORUS_API_KEY:-}" ]; } && ! { [ -t 0 ] && [ -t 1 ]; }; then
  if ( : < /dev/tty ) >/dev/null 2>&1; then
    exec < /dev/tty
  fi
fi

if [ -n "${CHORUS_URL:-}" ]; then
  url="$CHORUS_URL"
elif [ -t 0 ]; then
  printf "  Chorus URL ${DIM}[e.g. https://chorus.example.com]${RESET}: "
  read -r url
else
  die "No TTY and CHORUS_URL is unset. Export CHORUS_URL and retry."
fi

if [ -n "${CHORUS_API_KEY:-}" ]; then
  apikey="$CHORUS_API_KEY"
elif [ -t 0 ]; then
  printf "  Chorus API key (starts with cho_): "
  stty -echo 2>/dev/null || true
  read -r apikey
  stty echo 2>/dev/null || true
  printf "\n"
else
  die "No TTY and CHORUS_API_KEY is unset. Export CHORUS_API_KEY and retry."
fi

case "$url" in
  *$'\n'*|*$'\r'*) die "CHORUS_URL must not contain control characters." ;;
  http://*|https://*) ;;
  *) die "CHORUS_URL must start with http:// or https://." ;;
esac
case "$url" in
  */api/mcp/) url="${url%/api/mcp/}" ;;
  */api/mcp) url="${url%/api/mcp}" ;;
esac
while [ "${url%/}" != "$url" ]; do
  url="${url%/}"
done
[ -n "$url" ] || die "CHORUS_URL does not contain a service base URL."

case "$apikey" in
  *$'\n'*|*$'\r'*) die "CHORUS_API_KEY must not contain control characters." ;;
  cho_*) ;;
  *) die "CHORUS_API_KEY must start with cho_." ;;
esac

umask 077
mkdir -p "$DSH_HOME"
chmod 700 "$DSH_HOME" 2>/dev/null || true

TMP="$(mktemp "$DSH_HOME/.env.chorus.XXXXXX")"
trap 'rm -f "$TMP"' EXIT

# Preserve every non-Chorus line; drop any prior CHORUS_URL / CHORUS_API_KEY
# (with an optional `export ` prefix), then append the fresh values.
if [ -f "$ENV_FILE" ]; then
  awk '
    /^[[:space:]]*(export[[:space:]]+)?CHORUS_URL=/ { next }
    /^[[:space:]]*(export[[:space:]]+)?CHORUS_API_KEY=/ { next }
    { print }
  ' "$ENV_FILE" > "$TMP"
else
  : > "$TMP"
fi
printf 'CHORUS_URL=%s\n' "$url" >> "$TMP"
printf 'CHORUS_API_KEY=%s\n' "$apikey" >> "$TMP"
chmod 600 "$TMP"
mv "$TMP" "$ENV_FILE"
trap - EXIT
chmod 600 "$ENV_FILE" 2>/dev/null || true

redacted="cho_..."
case "$apikey" in
  cho_?*) redacted="$(printf '%s' "$apikey" | cut -c1-7)..." ;;
esac
ok "Wrote CHORUS_URL + CHORUS_API_KEY ($redacted) to $ENV_FILE (mode 0600)"
printf "${DIM}The Chorus dsh plugin reads these from %s. Restart dsh to pick them up.${RESET}\n" "$ENV_FILE"
