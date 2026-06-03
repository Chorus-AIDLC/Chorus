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
#   2. Registers (or upgrades) the Chorus plugin marketplace.
#   3. Writes [mcp_servers.chorus] (url + Authorization header) and
#      [plugins."chorus@chorus-plugins"] enabled = true into ~/.codex/config.toml,
#      so Codex auto-enables the plugin on first launch (falls back to one-click
#      `/plugins → Install` if auto-install does not fire).
#   4. Enables Codex lifecycle hooks. Chorus hook scripts are bundled in the
#      plugin manifest and loaded by Codex after the plugin is installed/enabled.

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

clean_legacy_chorus_hooks_json() {
  local hooks_json="$1"
  local tmp backup removed

  tmp="$(mktemp "${TMPDIR:-/tmp}/chorus-hooks.XXXXXX")"
  backup="${hooks_json}.chorus-legacy-bak"
  cp "$hooks_json" "$backup"

  if command -v node >/dev/null 2>&1; then
    removed="$(node - "$hooks_json" "$tmp" <<'NODE'
const fs = require("fs");
const input = process.argv[2];
const output = process.argv[3];
let removed = 0;

function isLegacyCommand(value) {
  return typeof value === "string" && value.indexOf("hooks/chorus/run-hook.sh") !== -1;
}

function clean(value, parentKey) {
  if (Array.isArray(value)) {
    return value
      .map((item) => clean(item, parentKey))
      .filter((item) => item !== undefined);
  }

  if (value && typeof value === "object") {
    if (isLegacyCommand(value.command)) {
      removed += 1;
      return undefined;
    }

    const hadHooksArray = Array.isArray(value.hooks);
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      const cleaned = clean(child, key);
      if (cleaned === undefined) continue;
      if (Array.isArray(cleaned) && cleaned.length === 0 && (key === "hooks" || parentKey === "hooks")) continue;
      out[key] = cleaned;
    }

    if (hadHooksArray && (!Array.isArray(out.hooks) || out.hooks.length === 0)) {
      return undefined;
    }
    return out;
  }

  return value;
}

let data = JSON.parse(fs.readFileSync(input, "utf8"));
data = clean(data, "") || {};
if (data.hooks && typeof data.hooks === "object" && !Array.isArray(data.hooks)) {
  for (const key of Object.keys(data.hooks)) {
    if (Array.isArray(data.hooks[key]) && data.hooks[key].length === 0) {
      delete data.hooks[key];
    }
  }
  if (Object.keys(data.hooks).length === 0) {
    delete data.hooks;
  }
}
fs.writeFileSync(output, JSON.stringify(data, null, 2) + "\n");
process.stdout.write(String(removed));
NODE
    )" || {
      rm -f "$tmp"
      warn "Could not parse $hooks_json with node; leaving legacy hooks unchanged."
      warn "Backup created at $backup"
      return 1
    }
  elif command -v python3 >/dev/null 2>&1; then
    removed="$(python3 - "$hooks_json" "$tmp" <<'PY'
import json
import sys

input_path = sys.argv[1]
output_path = sys.argv[2]
removed = 0

def is_legacy_command(value):
    return isinstance(value, str) and "hooks/chorus/run-hook.sh" in value

def clean(value, parent_key=""):
    global removed
    if isinstance(value, list):
        return [item for item in (clean(child, parent_key) for child in value) if item is not None]
    if isinstance(value, dict):
        if is_legacy_command(value.get("command")):
            removed += 1
            return None
        had_hooks_array = isinstance(value.get("hooks"), list)
        out = {}
        for key, child in value.items():
            cleaned = clean(child, key)
            if cleaned is None:
                continue
            if isinstance(cleaned, list) and not cleaned and (key == "hooks" or parent_key == "hooks"):
                continue
            out[key] = cleaned
        if had_hooks_array and (not isinstance(out.get("hooks"), list) or not out["hooks"]):
            return None
        return out
    return value

with open(input_path, "r", encoding="utf-8") as f:
    data = json.load(f)

data = clean(data) or {}
if isinstance(data.get("hooks"), dict):
    for key in list(data["hooks"].keys()):
        if isinstance(data["hooks"][key], list) and not data["hooks"][key]:
            del data["hooks"][key]
    if not data["hooks"]:
        del data["hooks"]

with open(output_path, "w", encoding="utf-8") as f:
    json.dump(data, f, indent=2)
    f.write("\n")

print(removed, end="")
PY
    )" || {
      rm -f "$tmp"
      warn "Could not parse $hooks_json with python3; leaving legacy hooks unchanged."
      warn "Backup created at $backup"
      return 1
    }
  else
    rm -f "$tmp"
    warn "Cannot auto-clean $hooks_json because neither node nor python3 is available."
    warn "Backup created at $backup"
    return 1
  fi

  if [ "${removed:-0}" = "0" ]; then
    rm -f "$tmp"
    warn "No legacy Chorus hook entries were removed from $hooks_json."
    warn "Backup created at $backup"
    return 1
  fi

  if grep -q '[^[:space:]{}]' "$tmp" 2>/dev/null; then
    mv "$tmp" "$hooks_json"
    ok "Removed $removed legacy Chorus hook entr$( [ "$removed" = "1" ] && printf 'y' || printf 'ies' ) from $hooks_json"
  else
    rm -f "$tmp" "$hooks_json"
    ok "Removed $removed legacy Chorus hook entr$( [ "$removed" = "1" ] && printf 'y' || printf 'ies' ) and deleted now-empty $hooks_json"
  fi
  ok "Backup saved at $backup"
}

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
# Extract the currently registered source (if any) for chorus-plugins.
# awk scoped between the matching [marketplaces.<name>] header and the next [section].
existing_source=""
if [ -f "$CONFIG_TOML" ]; then
  existing_source="$(awk -v name="$MARKETPLACE_NAME" '
    $0 ~ "^\\[marketplaces\\." name "\\][[:space:]]*$" { in_block=1; next }
    in_block && /^\[/              { in_block=0 }
    in_block && /^source[[:space:]]*=/ {
      sub(/^source[[:space:]]*=[[:space:]]*/, "")
      gsub(/^"|"$/, "")
      print
      exit
    }
  ' "$CONFIG_TOML" 2>/dev/null || true)"
fi

if [ -z "$existing_source" ]; then
  codex plugin marketplace add "$MARKETPLACE_SOURCE_DEFAULT" >/dev/null
  ok "Added marketplace: $MARKETPLACE_SOURCE_DEFAULT"
elif [ "$existing_source" = "$MARKETPLACE_SOURCE_DEFAULT" ]; then
  # Same source — pull the latest plugin manifest/version.
  if codex plugin marketplace upgrade "$MARKETPLACE_NAME" >/dev/null 2>&1; then
    ok "Upgraded marketplace '${MARKETPLACE_NAME}' to latest"
  else
    warn "Marketplace '${MARKETPLACE_NAME}' already registered; upgrade skipped"
  fi
else
  # Source changed — remove the stale registration and re-add.
  warn "Marketplace '${MARKETPLACE_NAME}' points at a different source; re-registering"
  warn "  old: $existing_source"
  warn "  new: $MARKETPLACE_SOURCE_DEFAULT"
  codex plugin marketplace remove "$MARKETPLACE_NAME" >/dev/null 2>&1 || true
  codex plugin marketplace add "$MARKETPLACE_SOURCE_DEFAULT" >/dev/null
  ok "Re-added marketplace: $MARKETPLACE_SOURCE_DEFAULT"
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

# Must be http(s).
case "$url" in
  http://*|https://*) ;;
  *) die "URL must start with http:// or https:// — got: $url" ;;
esac

# Normalize: the Chorus MCP endpoint lives under /api/mcp. If the user gave us
# just a host (or a host with trailing slash, or any path that doesn't already
# end in /api/mcp), append it so the MCP handshake hits the right route.
case "$url" in
  */api/mcp) ;;
  */api/mcp/) url="${url%/}" ;;
  */) url="${url}api/mcp" ;;
  *)  url="${url}/api/mcp" ;;
esac
ok "MCP endpoint: $url"

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
  # [mcp_servers.chorus.<subtable>], plus [plugins."chorus@chorus-plugins"],
  # and suppress lines until the next [section] header appears.
  /^\[mcp_servers\.chorus(\..*)?\][[:space:]]*$/           { skip = 1; next }
  /^\[plugins\."chorus@chorus-plugins"\][[:space:]]*$/      { skip = 1; next }
  /^\[/                                                      { skip = 0 }
  skip != 1                                                   { print }
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

[plugins."chorus@chorus-plugins"]
enabled = true
TOML

ok "Wrote [mcp_servers.chorus] and [plugins.\"chorus@chorus-plugins\"] → ${CONFIG_TOML}"

# ---------- step 5: enable hooks ----------
hdr "5/5  Enabling Codex lifecycle hooks"

HOOKS_JSON="$CODEX_HOME/hooks.json"
if [ -f "$HOOKS_JSON" ] && grep -q "hooks/chorus/run-hook.sh" "$HOOKS_JSON" 2>/dev/null; then
  warn "Found legacy copied Chorus hook entries in $HOOKS_JSON."
  warn "These can duplicate the plugin-bundled Chorus hooks now loaded by Codex."
  warn "Legacy entries:"
  grep -n "hooks/chorus/run-hook.sh" "$HOOKS_JSON" 2>/dev/null | sed 's/^/    /' >&2 || true

  if [ -r /dev/tty ] && [ -w /dev/tty ]; then
    printf "  Clean legacy Chorus entries from %s now? [y/N]: " "$HOOKS_JSON" > /dev/tty
    read -r clean_legacy_hooks_answer < /dev/tty
    case "$clean_legacy_hooks_answer" in
      y|Y|yes|YES|Yes)
        clean_legacy_chorus_hooks_json "$HOOKS_JSON" || true
        ;;
      *)
        warn "Keeping legacy hooks unchanged. Use /hooks to disable them or remove matching entries manually to avoid duplicates."
        ;;
    esac
  else
    warn "No interactive TTY available; keeping legacy hooks unchanged."
    warn "Re-run this installer in a terminal to auto-clean them, or remove matching entries manually."
  fi
fi

# Keep the current canonical feature key. `codex_hooks` is a deprecated alias;
# remove any old hook feature setting from [features] before writing `hooks = true`
# so reruns do not create duplicate TOML keys.
if grep -qE "^\[features\]" "$CONFIG_TOML"; then
  tmp="$(mktemp "${TMPDIR:-/tmp}/chorus-features.XXXXXX")"
  awk '
    /^\[features\][[:space:]]*$/ {
      in_features = 1
      print
      print "hooks = true"
      next
    }
    /^\[/ {
      in_features = 0
    }
    in_features && /^[[:space:]]*(hooks|codex_hooks)[[:space:]]*=/ {
      next
    }
    { print }
  ' "$CONFIG_TOML" > "$tmp" && mv "$tmp" "$CONFIG_TOML"
  ok "Set [features] hooks = true"
else
  cat >> "$CONFIG_TOML" <<'TFEAT'

[features]
hooks = true
TFEAT
  ok "Appended [features] hooks = true"
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
  ${BOLD}codex features list${RESET}    # hooks + plugins both true
  ${BOLD}/hooks${RESET}                 # review/trust bundled Chorus hooks after launch

Then in Codex type ${BOLD}\$chorus${RESET} (or \$develop, \$review, \$proposal, …) to
activate a skill. To change your API key later, just re-run this installer.

NEXT
