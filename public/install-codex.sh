#!/usr/bin/env bash
# Chorus + Codex CLI one-shot installer
#
# Usage:
#   curl -sSL https://chorus.ai/install-codex.sh | bash
#   # or non-interactive:
#   CHORUS_URL=https://... CHORUS_API_KEY=cho_... \
#     bash <(curl -sSL https://chorus.ai/install-codex.sh)
#
# What this does (idempotent, safe to re-run):
#   1. Verifies `codex` CLI is installed.
#   2. Registers the Chorus plugin marketplace.
#   3. Writes [mcp_servers.chorus] (url + Authorization header) into ~/.codex/config.toml.
#   4. Tells you to finish with `/plugins` → Install Chorus inside the TUI.

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

# Locate the installed plugin version on disk (glob picks the first / newest version).
# If the plugin has not been installed from /plugins yet, we skip this step with a hint.
PLUGIN_CACHE_GLOB="$CODEX_HOME/plugins/cache/chorus-plugins/chorus"
if [ ! -d "$PLUGIN_CACHE_GLOB" ]; then
  warn "Plugin not yet installed — skipping hooks. Run Codex TUI \`/plugins → Install\` first, then re-run this installer."
else
  # Newest installed version directory (lexicographic max; version dirs are semver).
  PLUGIN_VER_DIR="$(ls -1 "$PLUGIN_CACHE_GLOB" 2>/dev/null | sort -V | tail -1)"
  if [ -z "$PLUGIN_VER_DIR" ]; then
    warn "Plugin cache dir is empty — skipping hooks. Finish installing via \`/plugins\` first."
  else
    HOOKS_DIR="$PLUGIN_CACHE_GLOB/$PLUGIN_VER_DIR/hooks"
    if [ ! -d "$HOOKS_DIR" ]; then
      warn "Hooks directory not found at $HOOKS_DIR — skipping."
    else
      HOOKS_JSON="$CODEX_HOME/hooks.json"
      # Only write/overwrite if the file is absent, or is clearly a previous Chorus-owned file.
      if [ -f "$HOOKS_JSON" ] && ! grep -q "chorus-plugins/chorus" "$HOOKS_JSON" 2>/dev/null; then
        warn "Found a non-Chorus $HOOKS_JSON — not overwriting."
        warn "  Add the Chorus hook entries manually (see $HOOKS_DIR/*.sh), or move your existing hooks.json aside and re-run."
      else
        # Write a fresh Chorus hooks.json with absolute paths into the installed plugin cache.
        cat > "$HOOKS_JSON" <<HJSON
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume|clear",
        "hooks": [
          { "type": "command", "command": "$HOOKS_DIR/on-session-start.sh", "timeout": 20, "statusMessage": "Chorus: checkin" }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": ".*chorus_pm_submit_proposal",
        "hooks": [
          { "type": "command", "command": "$HOOKS_DIR/on-post-submit-proposal.sh", "timeout": 10 }
        ]
      },
      {
        "matcher": ".*chorus_submit_for_verify",
        "hooks": [
          { "type": "command", "command": "$HOOKS_DIR/on-post-submit-for-verify.sh", "timeout": 10 }
        ]
      }
    ]
  }
}
HJSON
        ok "Wrote $HOOKS_JSON (pointing at $HOOKS_DIR/*.sh)"
      fi

      # Enable the codex_hooks feature flag in config.toml (idempotent).
      if grep -qE "^\[features\]" "$CONFIG_TOML"; then
        # [features] section already exists; ensure codex_hooks = true is present.
        if ! grep -qE "^codex_hooks\s*=\s*true" "$CONFIG_TOML"; then
          # Insert codex_hooks = true right after the [features] header.
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
    fi
  fi
fi

# ---------- epilogue ----------
hdr "Done."
cat <<NEXT

Last step (install the plugin inside the Codex TUI):

  ${BOLD}codex${RESET}
  > /plugins
  → select "chorus-plugins" → "chorus" → Install

Verify anytime:
  ${BOLD}codex mcp list${RESET}         # 'chorus' row, Auth = 'Bearer token'

Then in Codex type ${BOLD}\$chorus${RESET} (or \$develop, \$review, \$proposal, …) to
activate a skill. To change your API key later, just re-run this installer.

NEXT
