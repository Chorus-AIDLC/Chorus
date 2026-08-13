#!/usr/bin/env bash
# Chorus + Kiro CLI one-shot installer
#
# Usage:
#   curl -fsSL "$CHORUS_URL/install-kiro.sh" | bash
#   # or non-interactive:
#   CHORUS_URL=https://... CHORUS_API_KEY=cho_... \
#     bash <(curl -fsSL https://chorus.example.com/install-kiro.sh)
#   # workspace-local (writes <cwd>/.kiro/ instead of ~/.kiro/):
#   bash <(curl -fsSL "$CHORUS_URL/install-kiro.sh") --workspace
#
# What this does (idempotent, safe to re-run):
#   1. Verifies a Kiro CLI (`kiro-cli` or `kiro`) is installed.
#   2. Collects CHORUS_URL + CHORUS_API_KEY (env or TTY prompt) and
#      normalizes the URL to end in exactly one /api/mcp.
#   3. Installs the Chorus `.kiro/` template — the chorus-* skills, the
#      `chorus` main agent + 3 read-only reviewer subagents, and the Chorus
#      steering doc — into ~/.kiro/ (global, default) or <cwd>/.kiro/
#      (--workspace).
#   4. Copies the session-automation hook scripts (+ chorus-api.sh) into
#      <KIRO_DIR>/chorus-bin/, chmod +x, and substitutes the __CHORUS_BIN__
#      placeholder in the installed agents/chorus.json hook commands with
#      the resolved ABSOLUTE chorus-bin path.
#   5. MERGES the `chorus` MCP server into <KIRO_DIR>/settings/mcp.json,
#      preserving any pre-existing user servers, backing the original up to
#      mcp.json.chorus-bak first.
#
# Bash 3.2 compatible (CLAUDE.md pitfall #10): no ${VAR,,}/${VAR^^},
# no `declare -A`, no `readarray`/`mapfile`, no `&>>`, no `|&`.

set -euo pipefail

# ---------- cosmetics ----------
BOLD=$'\033[1m'; DIM=$'\033[2m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; RESET=$'\033[0m'
ok()   { printf "${GREEN}\xe2\x9c\x93${RESET} %s\n" "$*"; }
warn() { printf "${YELLOW}!${RESET} %s\n" "$*" >&2; }
die()  { printf "${RED}\xe2\x9c\x97${RESET} %s\n" "$*" >&2; exit 1; }
hdr()  { printf "\n${BOLD}%s${RESET}\n" "$*"; }

is_tty() { [ -t 0 ] && [ -t 1 ]; }

# ---------- config: the artifact manifest (single source of truth) ----------
# These lists drive BOTH the local copy and the remote download, so the two
# source modes can never diverge.
SKILLS="chorus-idea chorus-proposal chorus-develop chorus-yolo chorus-review chorus-quick-dev chorus-brainstorm chorus-openspec-aware chorus-docs"
REVIEWER_AGENTS="chorus-code-reviewer chorus-proposal-reviewer chorus-task-reviewer"
HOOK_SCRIPTS="on-agent-spawn.sh on-stop.sh on-post-submit-proposal.sh on-post-submit-for-verify.sh on-post-verify-task.sh chorus-api.sh verify-document-roundtrip.sh test-syntax.sh"

CHORUS_URL_DEFAULT="${CHORUS_URL_DEFAULT:-http://localhost:8637/api/mcp}"

# ---------- argument parsing ----------
SCOPE="global"
for arg in "$@"; do
  case "$arg" in
    --workspace) SCOPE="workspace" ;;
    --global)    SCOPE="global" ;;
    -h|--help)
      cat <<'USAGE'
install-kiro.sh — install the Chorus plugin for Kiro CLI.

Options:
  --workspace   Write to <cwd>/.kiro/ (project-local) instead of ~/.kiro/.
  --global      Write to ~/.kiro/ (default).
  -h, --help    Show this help.

Environment:
  CHORUS_URL      Chorus base URL (e.g. https://chorus.example.com). Normalized
                  to end in /api/mcp. Prompted on a TTY if unset.
  CHORUS_API_KEY  Chorus agent API key (starts with cho_). Prompted (echo off)
                  on a TTY if unset; required — no TTY + unset is a hard error.
USAGE
      exit 0
      ;;
    *) die "Unknown argument: $arg (try --help)" ;;
  esac
done

# If piped through `curl | bash`, stdin is the script body. Re-open from
# /dev/tty so interactive prompts still work — but only when a real TTY is
# available AND we actually need to prompt (the key is unset). Both CHORUS_URL
# and CHORUS_API_KEY being set lets us run fully non-interactively (CI /
# sandboxed / unified-exec environments).
if [ -z "${CHORUS_API_KEY:-}" ] && ! is_tty; then
  # Probe that /dev/tty is actually openable before exec'ing onto it. In a
  # detached/headless environment (CI, daemon-spawned) /dev/tty can pass the
  # -r/-w file-mode test yet fail to open ("No such device or address"), and a
  # bare `exec < /dev/tty` would abort the shell with that raw error instead of
  # reaching the explanatory die below. The subshell open-test runs inside an
  # `if` so its failure never trips set -e.
  if ( : < /dev/tty ) >/dev/null 2>&1; then
    exec < /dev/tty
  fi
fi

# ---------- step 1: check Kiro CLI ----------
hdr "1/5  Checking Kiro CLI"
KIRO_BIN=""
if command -v kiro-cli >/dev/null 2>&1; then
  KIRO_BIN="kiro-cli"
elif command -v kiro >/dev/null 2>&1; then
  KIRO_BIN="kiro"
fi
[ -n "$KIRO_BIN" ] || die "No Kiro CLI found in PATH (looked for 'kiro-cli' and 'kiro'). Install it first: https://kiro.dev/docs/cli"
ok "Found $($KIRO_BIN --version 2>/dev/null | head -1 || echo "$KIRO_BIN")"

# ---------- step 2: collect Chorus URL + API key ----------
hdr "2/5  Configuring the Chorus connection"

# URL
if [ -n "${CHORUS_URL:-}" ]; then
  url="$CHORUS_URL"
  ok "Using CHORUS_URL from env: $url"
elif [ -t 0 ]; then
  printf "  Chorus URL ${DIM}[default: $CHORUS_URL_DEFAULT]${RESET}: "
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
  die "No TTY and CHORUS_API_KEY unset — cannot continue. Export CHORUS_API_KEY (create one under Settings -> Agents in the Chorus UI) and re-run."
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
  */api/mcp)  ;;
  */api/mcp/) url="${url%/}" ;;
  */)         url="${url}api/mcp" ;;
  *)          url="${url}/api/mcp" ;;
esac
ok "MCP endpoint: $url"

# The base for fetching static plugin assets is the same origin minus /api/mcp
# (public/ is served at web root, so public/kiro-plugin/... => <base>/kiro-plugin/...).
ASSET_BASE="${url%/api/mcp}"

# ---------- step 3: locate the template source ----------
hdr "3/5  Locating the Chorus .kiro/ template"

# Resolve the directory of this script (only meaningful when run from a file,
# not via `curl | bash`).
SCRIPT_SRC="${BASH_SOURCE:-$0}"
SCRIPT_DIR=""
if [ -f "$SCRIPT_SRC" ]; then
  SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_SRC")" >/dev/null 2>&1 && pwd)"
fi

# Candidate local template roots (script lives in public/, or repo root).
SRC_ROOT=""
if [ -n "$SCRIPT_DIR" ]; then
  for cand in "$SCRIPT_DIR/kiro-plugin" "$SCRIPT_DIR/public/kiro-plugin" "$SCRIPT_DIR/../public/kiro-plugin"; do
    if [ -f "$cand/.kiro/settings/mcp.json" ] && [ -f "$cand/.kiro/agents/chorus.json" ]; then
      SRC_ROOT="$(cd "$cand" >/dev/null 2>&1 && pwd)"
      break
    fi
  done
fi

CLEANUP_SRC=""
if [ -n "$SRC_ROOT" ]; then
  ok "Using local template: $SRC_ROOT"
else
  # Remote mode: download the manifest from the Chorus instance's static assets.
  command -v curl >/dev/null 2>&1 || die "No local template found and 'curl' is unavailable — cannot download the plugin. Run this from a Chorus checkout, or install curl."
  SRC_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/chorus-kiro.XXXXXX")"
  CLEANUP_SRC="$SRC_ROOT"
  ok "Downloading template from ${ASSET_BASE}/kiro-plugin/"

  fetch() {
    # fetch <relpath-under-kiro-plugin> <dest-abs-path>
    local rel="$1" dest="$2"
    mkdir -p "$(dirname "$dest")"
    curl -fsSL "${ASSET_BASE}/kiro-plugin/${rel}" -o "$dest" \
      || die "Failed to download kiro-plugin/${rel} from ${ASSET_BASE}. Is CHORUS_URL correct and reachable?"
  }

  fetch ".kiro/settings/mcp.json" "$SRC_ROOT/.kiro/settings/mcp.json"
  fetch ".kiro/steering/chorus.md" "$SRC_ROOT/.kiro/steering/chorus.md"
  fetch ".kiro/agents/chorus.json" "$SRC_ROOT/.kiro/agents/chorus.json"
  fetch ".kiro/agents/chorus.md" "$SRC_ROOT/.kiro/agents/chorus.md"
  for a in $REVIEWER_AGENTS; do
    fetch ".kiro/agents/${a}.json" "$SRC_ROOT/.kiro/agents/${a}.json"
  done
  for s in $SKILLS; do
    fetch ".kiro/skills/${s}/SKILL.md" "$SRC_ROOT/.kiro/skills/${s}/SKILL.md"
  done
  for b in $HOOK_SCRIPTS; do
    fetch "bin/${b}" "$SRC_ROOT/bin/${b}"
  done
fi

# Clean up any downloaded temp on exit (no-op for local mode).
cleanup() { [ -n "$CLEANUP_SRC" ] && rm -rf "$CLEANUP_SRC" 2>/dev/null || true; }
trap cleanup EXIT

# ---------- step 4: determine KIRO_DIR + write skills / agents / steering / hooks ----------
if [ "$SCOPE" = "workspace" ]; then
  KIRO_DIR="$(pwd)/.kiro"
else
  KIRO_DIR="$HOME/.kiro"
fi
CHORUS_BIN_ABS="$KIRO_DIR/chorus-bin"

hdr "4/5  Installing into $KIRO_DIR (scope: $SCOPE)"
mkdir -p "$KIRO_DIR/skills" "$KIRO_DIR/agents" "$KIRO_DIR/steering" "$KIRO_DIR/chorus-bin" "$KIRO_DIR/settings"

# Skills (chorus-* only — never touches a user's own skills).
for s in $SKILLS; do
  mkdir -p "$KIRO_DIR/skills/$s"
  cp "$SRC_ROOT/.kiro/skills/$s/SKILL.md" "$KIRO_DIR/skills/$s/SKILL.md"
done
ok "Installed skills: $SKILLS"

# Reviewer subagents (raw copy) + the main-agent prompt sidecar.
for a in $REVIEWER_AGENTS; do
  cp "$SRC_ROOT/.kiro/agents/$a.json" "$KIRO_DIR/agents/$a.json"
done
cp "$SRC_ROOT/.kiro/agents/chorus.md" "$KIRO_DIR/agents/chorus.md"
ok "Installed agents: chorus (main) + $REVIEWER_AGENTS"

# Steering (Chorus platform-overview / AI-DLC context).
cp "$SRC_ROOT/.kiro/steering/chorus.md" "$KIRO_DIR/steering/chorus.md"
ok "Installed steering: chorus.md"

# Hook scripts -> chorus-bin/ (executable). Copying them INTO the Kiro dir keeps
# the install self-contained and removable.
for b in $HOOK_SCRIPTS; do
  cp "$SRC_ROOT/bin/$b" "$CHORUS_BIN_ABS/$b"
  chmod +x "$CHORUS_BIN_ABS/$b"
done
ok "Installed hook scripts -> $CHORUS_BIN_ABS/ (chmod +x)"

# Main agent: substitute the __CHORUS_BIN__ placeholder in the hook `command`
# strings with the resolved ABSOLUTE chorus-bin path. The repo copy keeps the
# placeholder; only this installed copy is concretized. Absolute paths are
# scope-independent and survive Kiro being launched from any cwd.
# (Use '|' as the sed delimiter since the replacement is a filesystem path.)
sed "s|__CHORUS_BIN__|$CHORUS_BIN_ABS|g" \
  "$SRC_ROOT/.kiro/agents/chorus.json" > "$KIRO_DIR/agents/chorus.json"

# Fail loudly if the placeholder survived (it must not).
if grep -q '__CHORUS_BIN__' "$KIRO_DIR/agents/chorus.json" 2>/dev/null; then
  die "Internal error: __CHORUS_BIN__ placeholder was not fully substituted in agents/chorus.json"
fi
ok "Wrote agents/chorus.json (hook commands -> $CHORUS_BIN_ABS)"

# ---------- step 5: merge the chorus MCP server into settings/mcp.json ----------
hdr "5/5  Wiring the Chorus MCP server into settings/mcp.json"

MCP_JSON="$KIRO_DIR/settings/mcp.json"
# Seed a valid empty document if the file is missing so the merge has a target.
if [ ! -f "$MCP_JSON" ]; then
  printf '%s\n' '{"mcpServers":{}}' > "$MCP_JSON"
fi

# Back up ONCE (idempotent — a second run keeps the single original backup).
if [ ! -f "$MCP_JSON.chorus-bak" ]; then
  cp "$MCP_JSON" "$MCP_JSON.chorus-bak"
  ok "Backed up original to ${MCP_JSON}.chorus-bak"
fi

# The chorus server object. BOTH the URL and the API key stay ${...} references
# (not baked literals) so Kiro CLI interpolates them from the environment at
# runtime — this is what makes a single daemon serving MULTIPLE agents work: each
# woken Kiro child inherits that agent's own CHORUS_URL / CHORUS_API_KEY, so the
# same mcp.json resolves to the right server + key per agent. The API key is never
# written to disk. Single-quote both refs so the shell never expands ${...} here.
URL_REF='${CHORUS_URL}/api/mcp'
AUTH_REF='Bearer ${env:CHORUS_API_KEY}'

merged=""
if command -v jq >/dev/null 2>&1; then
  # Build the server object, then set only .mcpServers.chorus (in place if it
  # already exists — preserving position and every other user server).
  server_json="$(jq -n --arg url "$URL_REF" --arg auth "$AUTH_REF" \
    '{type:"http", url:$url, headers:{Authorization:$auth}, disabled:false}')"
  merged="$(jq --argjson srv "$server_json" \
    '(.mcpServers // {}) as $m | .mcpServers = ($m + {chorus:$srv})' "$MCP_JSON")" \
    || die "Failed to merge mcp.json with jq (is $MCP_JSON valid JSON?)"
elif command -v node >/dev/null 2>&1; then
  merged="$(CHORUS_MCP_URL="$URL_REF" CHORUS_MCP_AUTH="$AUTH_REF" node - "$MCP_JSON" <<'NODE'
const fs = require("fs");
const file = process.argv[2];
let data = {};
try { data = JSON.parse(fs.readFileSync(file, "utf8")) || {}; }
catch (e) { console.error("mcp.json is not valid JSON: " + e.message); process.exit(1); }
if (typeof data !== "object" || Array.isArray(data)) data = {};
if (typeof data.mcpServers !== "object" || data.mcpServers === null || Array.isArray(data.mcpServers)) data.mcpServers = {};
data.mcpServers.chorus = {
  type: "http",
  url: process.env.CHORUS_MCP_URL,
  headers: { Authorization: process.env.CHORUS_MCP_AUTH },
  disabled: false,
};
process.stdout.write(JSON.stringify(data, null, 2) + "\n");
NODE
)" || die "Failed to merge mcp.json with node (is $MCP_JSON valid JSON?)"
else
  die "Cannot merge mcp.json safely: neither jq nor node is available. Install one (e.g. 'brew install jq') and re-run."
fi

printf '%s\n' "$merged" > "$MCP_JSON"
ok "Merged the 'chorus' server into $MCP_JSON (other servers preserved)"

# ---------- epilogue ----------
hdr "Done."
if [ "$SCOPE" = "workspace" ]; then
  scope_note="this project ($KIRO_DIR)"
else
  scope_note="every directory (global $KIRO_DIR)"
fi
cat <<NEXT

The Chorus plugin is installed for ${scope_note}.

Make sure CHORUS_URL and CHORUS_API_KEY stay exported in your shell (Kiro
reads \${env:CHORUS_API_KEY} at runtime — add them to ~/.bashrc / ~/.zshrc):

  ${BOLD}export CHORUS_URL="${ASSET_BASE}"${RESET}
  ${BOLD}export CHORUS_API_KEY="cho_..."${RESET}

Then, in ${BOLD}${KIRO_BIN}${RESET}:

  * Type ${BOLD}/chorus-idea${RESET} (or /chorus-proposal, /chorus-develop, /chorus-yolo,
    /chorus-review, /chorus-quick-dev, ...) to activate a workflow skill.
  * Launch the full-automation main agent with session hooks + reviewer
    subagents:  ${BOLD}${KIRO_BIN} --agent chorus${RESET}

Live in-Kiro activation is your manual verification step — see docs/CONNECT_KIRO.md.
To change your API key or URL later, just re-run this installer.

NEXT
