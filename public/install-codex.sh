#!/usr/bin/env bash
# Chorus + Codex CLI one-shot installer
#
# Usage:
#   curl -sSL https://raw.githubusercontent.com/Chorus-AIDLC/Chorus/main/public/install-codex.sh | bash
#   # or non-interactive:
#   CHORUS_URL=https://... CHORUS_API_KEY=cho_... \
#     bash <(curl -sSL https://raw.githubusercontent.com/Chorus-AIDLC/Chorus/main/public/install-codex.sh)
#
# What this does (idempotent, safe to re-run):
#   1. Verifies `codex` CLI is installed.
#   2. Registers the Chorus plugin marketplace.
#   3. Writes [mcp_servers.chorus] (url + Authorization header) into ~/.codex/config.toml.
#   4. Registers plugin as INSTALLED_BY_DEFAULT — Codex picks it up on first launch
#      (falls back to one-click `/plugins → Install` if auto-install does not fire).

set -euo pipefail

# ---------- cosmetics ----------
BOLD=$'\033[1m'; DIM=$'\033[2m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; RESET=$'\033[0m'
ok()   { printf "${GREEN}✓${RESET} %s\n" "$*"; }
warn() { printf "${YELLOW}!${RESET} %s\n" "$*" >&2; }
die()  { printf "${RED}✗${RESET} %s\n" "$*" >&2; exit 1; }
hdr()  { printf "\n${BOLD}%s${RESET}\n" "$*"; }

# ---------- config ----------
MARKETPLACE_NAME="chorus-plugins"
MARKETPLACE_SOURCE_DEFAULT="${CHORUS_MARKETPLACE_SOURCE:-https://github.com/Chorus-AIDLC/Chorus}"
CHORUS_URL_DEFAULT="${CHORUS_URL_DEFAULT:-http://localhost:8637/api/mcp}"
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
CONFIG_TOML="$CODEX_HOME/config.toml"

is_tty() { [ -t 0 ] && [ -t 1 ]; }

# If piped through `curl | bash`, stdin is the script body. Re-open from /dev/tty
# so interactive prompts still work — but only if a real TTY is available AND we
# actually need to prompt for input. Both CHORUS_URL and CHORUS_API_KEY being set
# lets us run fully non-interactively (useful in CI or unified-exec sandboxes).
if [ -z "${CHORUS_API_KEY:-}" ] && ! is_tty; then
  if [ -r /dev/tty ] && [ -w /dev/tty ]; then
    exec < /dev/tty
  fi
fi

# ---------- step 1: check codex ----------
hdr "1/5  Checking Codex CLI"
command -v codex >/dev/null 2>&1 || die "codex not found in PATH. Install it first: npm i -g @openai/codex"
ok "Found $(codex --version 2>/dev/null | head -1)"

# ---------- step 2: register marketplace ----------
hdr "2/5  Registering the Chorus plugin marketplace"
if grep -q "^\[marketplaces\.${MARKETPLACE_NAME}\]" "$CONFIG_TOML" 2>/dev/null; then
  ok "Marketplace '${MARKETPLACE_NAME}' already registered"
else
  codex plugin marketplace add "$MARKETPLACE_SOURCE_DEFAULT" >/dev/null
  ok "Added marketplace: $MARKETPLACE_SOURCE_DEFAULT"
fi

# ---------- step 3: collect Chorus URL + API key ----------
hdr "3/5  Configuring the Chorus MCP server"

# URL
if [ -n "${CHORUS_URL:-}" ]; then
  url="$CHORUS_URL"
  ok "Using CHORUS_URL from env: $url"
elif [ -t 0 ]; then
  printf "  Chorus MCP URL ${DIM}[default: $CHORUS_URL_DEFAULT]${RESET}: "
  read -r url
  url="${url:-$CHORUS_URL_DEFAULT}"
else
  url="$CHORUS_URL_DEFAULT"
  warn "No TTY and CHORUS_URL unset — using default: $url"
fi

# API key
if [ -n "${CHORUS_API_KEY:-}" ]; then
  apikey="$CHORUS_API_KEY"
  ok "Using CHORUS_API_KEY from env"
elif [ -t 0 ]; then
  printf "  Chorus API key (starts with cho_): "
  stty -echo 2>/dev/null || true
  read -r apikey
  stty echo 2>/dev/null || true
  printf "\n"
  [ -n "$apikey" ] || die "API key is required"
else
  die "No TTY and CHORUS_API_KEY unset — cannot continue"
fi

# Sanity check: a root URL without a path is almost always wrong — the Chorus
# MCP endpoint is served under a path (e.g. /api/mcp). Warn loudly; don't abort
# so advanced users with a path-less reverse proxy can still proceed.
case "$url" in
  http://*/*|https://*/*)
    # Has a path component — check it's not just a trailing slash.
    path="${url#http*://}"
    path="${path#*/}"
    if [ -z "$path" ]; then
      warn "URL has no path (just a host). MCP endpoints usually live under /api/mcp or similar."
      warn "If /mcp in the TUI shows 'chorus' failing to connect, re-run with the full URL."
    fi
    ;;
  http://*|https://*)
    warn "URL has no path (just a host). MCP endpoints usually live under /api/mcp or similar."
    warn "If /mcp in the TUI shows 'chorus' failing to connect, re-run with the full URL."
    ;;
  *)
    die "URL must start with http:// or https:// — got: $url"
    ;;
esac

# ---------- step 4: write config.toml ----------
hdr "4/5  Writing ~/.codex/config.toml"
mkdir -p "$CODEX_HOME"
[ -f "$CONFIG_TOML" ] || touch "$CONFIG_TOML"

# Back up once
if [ ! -f "$CONFIG_TOML.chorus-bak" ]; then
  cp "$CONFIG_TOML" "$CONFIG_TOML.chorus-bak"
  ok "Backed up original config to ${CONFIG_TOML}.chorus-bak"
fi

# Remove any existing [mcp_servers.chorus] and [mcp_servers.chorus.*] sub-tables
# (idempotent — old rotated keys / headers are wiped, then fresh section appended).
# Pure awk so we do not require Python on the user's machine.
tmp="$(mktemp "${TMPDIR:-/tmp}/chorus-config.XXXXXX")"
awk '
  # A TOML table header line. Match [mcp_servers.chorus] and any
  # [mcp_servers.chorus.<subtable>], set a flag that suppresses lines
  # until the next [section] header appears.
  /^\[mcp_servers\.chorus(\..*)?\][[:space:]]*$/ { skip = 1; next }
  /^\[/                                             { skip = 0 }
  skip != 1                                          { print }
' "$CONFIG_TOML" > "$tmp"
mv "$tmp" "$CONFIG_TOML"

# Ensure user-owned file mode 600 (contains secret).
chmod 600 "$CONFIG_TOML"

# Append [mcp_servers.chorus] with literal URL + Authorization header.
# (Codex does NOT expand ${VAR}; the token is a literal string in the header.)
cat >> "$CONFIG_TOML" <<TOML

[mcp_servers.chorus]
url = "${url}"

[mcp_servers.chorus.http_headers]
Authorization = "Bearer ${apikey}"
TOML

ok "Wrote [mcp_servers.chorus] → ${CONFIG_TOML}"

# ---------- step 5: install hooks ----------
hdr "5/5  Installing Chorus hooks"

# Install a tiny wrapper that lazily resolves the newest plugin cache at
# hook-run time. This lets us write hooks.json BEFORE `/plugins → Install`
# has materialized the plugin cache — first-run UX becomes truly one-shot.
WRAPPER_DIR="$CODEX_HOME/hooks/chorus"
WRAPPER="$WRAPPER_DIR/run-hook.sh"
mkdir -p "$WRAPPER_DIR"
cat > "$WRAPPER" <<'WRAP'
#!/usr/bin/env bash
# Chorus hook wrapper (installed by public/install-codex.sh).
# Resolves the newest installed Chorus plugin version at runtime and execs
# the named hook script from its hooks/ directory. Exits 0 (no-op) if the
# plugin has not been installed yet, so Codex sessions still start cleanly.
set -eu
HOOK_NAME="${1:-}"
if [ -z "$HOOK_NAME" ]; then
  echo '{}' ; exit 0
fi
shift
CODEX_HOME_RESOLVED="${CODEX_HOME:-$HOME/.codex}"
PLUGIN_ROOT="$CODEX_HOME_RESOLVED/plugins/cache/chorus-plugins/chorus"
if [ ! -d "$PLUGIN_ROOT" ]; then
  echo '{}' ; exit 0
fi
VER="$(ls -1 "$PLUGIN_ROOT" 2>/dev/null | sort -V | tail -1)"
if [ -z "$VER" ]; then
  echo '{}' ; exit 0
fi
SCRIPT="$PLUGIN_ROOT/$VER/hooks/$HOOK_NAME"
if [ ! -x "$SCRIPT" ]; then
  if [ -f "$SCRIPT" ]; then
    chmod +x "$SCRIPT" 2>/dev/null || true
  else
    echo '{}' ; exit 0
  fi
fi
exec "$SCRIPT" "$@"
WRAP
chmod +x "$WRAPPER"
ok "Installed hook wrapper → $WRAPPER"

HOOKS_JSON="$CODEX_HOME/hooks.json"
if [ -f "$HOOKS_JSON" ] && ! grep -q "hooks/chorus/run-hook.sh\|chorus-plugins/chorus" "$HOOKS_JSON" 2>/dev/null; then
  warn "Found a non-Chorus $HOOKS_JSON — not overwriting."
  warn "  Add Chorus hook entries manually (command = $WRAPPER on-session-start.sh | on-post-submit-proposal.sh | on-post-submit-for-verify.sh)."
else
  cat > "$HOOKS_JSON" <<HJSON
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume|clear",
        "hooks": [
          { "type": "command", "command": "$WRAPPER on-session-start.sh", "timeout": 20, "statusMessage": "Chorus: checkin" }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": ".*chorus_pm_submit_proposal",
        "hooks": [
          { "type": "command", "command": "$WRAPPER on-post-submit-proposal.sh", "timeout": 10 }
        ]
      },
      {
        "matcher": ".*chorus_submit_for_verify",
        "hooks": [
          { "type": "command", "command": "$WRAPPER on-post-submit-for-verify.sh", "timeout": 10 }
        ]
      }
    ]
  }
}
HJSON
  ok "Wrote $HOOKS_JSON (routing through $WRAPPER)"
fi

# Enable the codex_hooks feature flag in config.toml (idempotent).
if grep -qE "^\[features\]" "$CONFIG_TOML"; then
  if ! grep -qE "^codex_hooks\s*=\s*true" "$CONFIG_TOML"; then
    tmp="$(mktemp "${TMPDIR:-/tmp}/chorus-features.XXXXXX")"
    awk '
      /^\[features\][[:space:]]*$/ { print; print "codex_hooks = true"; inserted=1; next }
      { print }
    ' "$CONFIG_TOML" > "$tmp" && mv "$tmp" "$CONFIG_TOML"
    ok "Added codex_hooks = true under existing [features]"
  else
    ok "codex_hooks feature flag already enabled"
  fi
else
  cat >> "$CONFIG_TOML" <<'TFEAT'

[features]
codex_hooks = true
TFEAT
  ok "Appended [features] codex_hooks = true"
fi

# ---------- epilogue ----------
hdr "Done."
cat <<NEXT

Start Codex — the plugin is registered as INSTALLED_BY_DEFAULT so it
should activate on first launch:

  ${BOLD}codex${RESET}

If /plugins does not show "chorus" as installed on first launch, open it
and click Install once (Codex has no \`plugin install\` CLI command yet,
so one manual click is the fallback path).

Verify anytime:
  ${BOLD}codex mcp list${RESET}         # 'chorus' row, Auth = 'Bearer token'
  ${BOLD}codex features list${RESET}    # codex_hooks + plugins both true

Then in Codex type ${BOLD}\$chorus${RESET} (or \$develop, \$review, \$proposal, …) to
activate a skill. To change your API key later, just re-run this installer.

NEXT
