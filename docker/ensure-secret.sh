#!/bin/sh
# docker/ensure-secret.sh — sourced by docker-entrypoint.sh (POSIX sh / BusyBox ash).
#
# Bootstraps NEXTAUTH_SECRET when it is unset, empty, or equal to a publicly
# known placeholder (GitHub issue #559). The secret is generated once with
# `openssl rand -hex 32` and persisted to "$CHORUS_DATA_DIR/.secret" so that it
# survives container recreates as long as /app/data is a persistent volume.
#
# Rules:
#   - An explicit, non-placeholder NEXTAUTH_SECRET always wins; the filesystem is untouched.
#   - Any failure (unreadable / non-regular file, generator or write failure, malformed
#     output, persisted placeholder) fails CLOSED: the function returns non-zero and
#     nothing is exported. A generated value is accepted only if openssl exits 0 AND
#     the output is exactly 64 lowercase hex characters.
#   - The secret value is never printed.
#
# CHORUS_DATA_DIR is INTERNAL (tests point it at a tmp dir); it defaults to /app/data.

CHORUS_DATA_DIR="${CHORUS_DATA_DIR:-/app/data}"
CHORUS_SECRET_FILE="$CHORUS_DATA_DIR/.secret"

# Must stay identical to KNOWN_INSECURE_SECRETS in src/lib/secret-check.ts
CHORUS_KNOWN_INSECURE_SECRETS="chorus-docker-secret-change-in-production
chorus-local-secret
your-secret-key-change-in-production
change-me-to-a-random-secret"

# is_known_insecure_secret <candidate> — exit 0 when the candidate is a known placeholder.
is_known_insecure_secret() {
  printf '%s\n' "$CHORUS_KNOWN_INSECURE_SECRETS" | grep -qxF -- "$1"
}

# ensure_nextauth_secret — exports a non-placeholder NEXTAUTH_SECRET or returns non-zero.
ensure_nextauth_secret() {
  if [ -n "${NEXTAUTH_SECRET:-}" ] && ! is_known_insecure_secret "$NEXTAUTH_SECRET"; then
    return 0 # explicit secure value wins; touch nothing
  fi

  _ens_reason="missing"
  if [ -n "${NEXTAUTH_SECRET:-}" ]; then
    _ens_reason="known-insecure"
  fi

  if ! mkdir -p "$CHORUS_DATA_DIR" 2>/dev/null; then
    echo "ERROR: cannot create data directory $CHORUS_DATA_DIR for NEXTAUTH_SECRET persistence" >&2
    return 1
  fi

  if [ -e "$CHORUS_SECRET_FILE" ] && [ ! -f "$CHORUS_SECRET_FILE" ]; then
    echo "ERROR: $CHORUS_SECRET_FILE exists but is not a regular file" >&2
    return 1
  fi

  _ens_existing=""
  if [ -f "$CHORUS_SECRET_FILE" ]; then
    if ! _ens_existing=$(cat "$CHORUS_SECRET_FILE" 2>/dev/null); then
      echo "ERROR: cannot read $CHORUS_SECRET_FILE" >&2
      return 1
    fi
    _ens_existing=$(printf '%s' "$_ens_existing" | tr -d '[:space:]')
  fi

  if [ -z "$_ens_existing" ]; then
    # 1. Generate into a PRIVATE temp file in the same directory. `umask 077`
    #    lives inside the subshell so it never leaks into `exec node server.js`.
    #    The result is accepted only if openssl exited 0 AND the content is
    #    exactly 64 lowercase hex chars — a partial write (disk full, killed
    #    generator) must never become the JWT signing key.
    #    The temp name comes from `mktemp` (BusyBox-compatible template), NOT
    #    from `$$`: the entrypoint is PID 1 in every container (exec-form
    #    ENTRYPOINT), so a `$$` suffix is identical across containers sharing a
    #    volume and two concurrent first starts would truncate each other's
    #    temp file. mktemp failure fails closed.
    _ens_tmp=""
    if ! _ens_tmp=$(umask 077; mktemp "$CHORUS_DATA_DIR/.secret.tmp.XXXXXX" 2>/dev/null) || [ -z "$_ens_tmp" ]; then
      echo "ERROR: failed to generate and persist a secret at $CHORUS_SECRET_FILE (cannot create a temp file in $CHORUS_DATA_DIR)" >&2
      unset _ens_tmp
      return 1
    fi
    _ens_new=""
    if ( umask 077; openssl rand -hex 32 > "$_ens_tmp" ) 2>/dev/null \
      && _ens_new=$(tr -d '[:space:]' < "$_ens_tmp" 2>/dev/null) \
      && printf '%s\n' "$_ens_new" | grep -qxE '[0-9a-f]{64}'; then
      :
    else
      rm -f "$_ens_tmp" 2>/dev/null
      echo "ERROR: failed to generate and persist a secret at $CHORUS_SECRET_FILE (openssl failed or produced malformed output)" >&2
      unset _ens_tmp _ens_new
      return 1
    fi

    # 2. Install atomically and EXCLUSIVELY with `ln tmp target`, which fails if
    #    the target already exists — so a concurrent starter that already
    #    installed a valid secret wins and we re-read its value below. There is
    #    deliberately NO blanket `rm -f`: only a file re-verified as empty /
    #    whitespace-only (stale remnant of an interrupted write) is removed
    #    first. Guarantee: single-replica correctness; same-volume concurrent
    #    first starts converge on one value on a best-effort basis (the check-
    #    then-remove window on an empty file is the residual race). Multi-
    #    replica deployments must inject NEXTAUTH_SECRET explicitly.
    if [ -f "$CHORUS_SECRET_FILE" ] && [ -z "$(tr -d '[:space:]' < "$CHORUS_SECRET_FILE" 2>/dev/null)" ]; then
      rm -f "$CHORUS_SECRET_FILE" 2>/dev/null
    fi
    ln "$_ens_tmp" "$CHORUS_SECRET_FILE" 2>/dev/null || true
    rm -f "$_ens_tmp" 2>/dev/null
    unset _ens_tmp _ens_new

    # 3. Re-read in the PARENT shell (exporting inside a subshell would be lost).
    if ! _ens_existing=$(cat "$CHORUS_SECRET_FILE" 2>/dev/null); then
      echo "ERROR: failed to generate and persist a secret at $CHORUS_SECRET_FILE (cannot read back)" >&2
      return 1
    fi
    _ens_existing=$(printf '%s' "$_ens_existing" | tr -d '[:space:]')
    if [ -z "$_ens_existing" ]; then
      echo "ERROR: failed to generate and persist a secret at $CHORUS_SECRET_FILE (installed file is empty)" >&2
      return 1
    fi
    _ens_action="generated a new random secret and persisted it to $CHORUS_SECRET_FILE"
  else
    _ens_action="reusing the persisted secret from $CHORUS_SECRET_FILE"
  fi

  if is_known_insecure_secret "$_ens_existing"; then
    echo "ERROR: the secret persisted at $CHORUS_SECRET_FILE is a publicly known placeholder; refusing to start" >&2
    return 1
  fi

  # Parent shell — NOT inside the subshell above.
  NEXTAUTH_SECRET="$_ens_existing"
  export NEXTAUTH_SECRET

  case "$_ens_reason" in
    missing)
      echo "NEXTAUTH_SECRET not set — $_ens_action."
      ;;
    known-insecure)
      echo "WARNING: NEXTAUTH_SECRET was set to a publicly known placeholder (see GitHub issue #559). Ignoring it — $_ens_action."
      ;;
  esac
  echo "  Make sure $CHORUS_DATA_DIR is a persistent volume, otherwise the secret rotates (and all sessions are invalidated) on every container recreate."
  echo "  Multi-replica deployments MUST set the same NEXTAUTH_SECRET explicitly on every replica."

  unset _ens_reason _ens_existing _ens_action
  return 0
}
