#!/usr/bin/env bash
# Chorus + OpenCode one-shot plugin installer
#
# Usage:
#   curl -fsSL https://<your-chorus>/install-opencode.sh | bash
#
# What this does (idempotent, safe to re-run):
#   1. Verifies `opencode` CLI is installed.
#   2. Adds "opencode-chorus" to the `plugin` array in
#      ~/.config/opencode/opencode.json. Creates the file if missing.
#      Preserves any existing plugins.
#   3. Sets file permissions to 600.
#
# What this does NOT do:
#   - Write to ~/.bashrc / ~/.zshrc. You must export CHORUS_URL and
#     CHORUS_API_KEY yourself before launching opencode (the plugin reads
#     process.env on startup).
#   - Invoke jq / node / python. Pure POSIX awk/sed/grep only.

set -euo pipefail

# ---------- cosmetics ----------
BOLD=$'\033[1m'; DIM=$'\033[2m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; RESET=$'\033[0m'
ok()   { printf "${GREEN}\xe2\x9c\x93${RESET} %s\n" "$*"; }
warn() { printf "${YELLOW}!${RESET} %s\n" "$*" >&2; }
die()  { printf "${RED}\xe2\x9c\x97${RESET} %s\n" "$*" >&2; exit 1; }
hdr()  { printf "\n${BOLD}%s${RESET}\n" "$*"; }

# ---------- config ----------
PLUGIN_NAME="opencode-chorus"
CONFIG_DIR="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"
CONFIG_FILE="$CONFIG_DIR/opencode.json"
BACKUP_FILE="$CONFIG_FILE.chorus-bak"

# ---------- step 1: check opencode ----------
hdr "1/3  Checking OpenCode CLI"
if command -v opencode >/dev/null 2>&1; then
  ok "Found $(opencode --version 2>/dev/null | head -1)"
else
  warn "opencode not found in PATH — install it first: https://opencode.ai/docs/"
  warn "Proceeding to write the config anyway. OpenCode will pick it up on install."
fi

# ---------- step 2: ensure config dir ----------
hdr "2/3  Updating $CONFIG_FILE"
mkdir -p "$CONFIG_DIR"

# Helper: print the manual instructions and exit 0 (non-fatal).
print_manual_hint() {
  warn "Could not automatically update $CONFIG_FILE."
  warn "Please add \"$PLUGIN_NAME\" to the \"plugin\" array manually:"
  cat >&2 <<HINT

  {
    "\$schema": "https://opencode.ai/config.json",
    "plugin": ["$PLUGIN_NAME"${EXISTING_PLUGIN_HINT:-}]
    ...
  }

HINT
  exit 0
}

# ---------- Case A: file does not exist ----------
if [ ! -f "$CONFIG_FILE" ]; then
  cat > "$CONFIG_FILE" <<JSON
{
  "\$schema": "https://opencode.ai/config.json",
  "plugin": ["$PLUGIN_NAME"]
}
JSON
  chmod 600 "$CONFIG_FILE"
  ok "Created $CONFIG_FILE with $PLUGIN_NAME"
else
  # File exists — back it up once.
  if [ ! -f "$BACKUP_FILE" ]; then
    cp "$CONFIG_FILE" "$BACKUP_FILE"
    chmod 600 "$BACKUP_FILE"
    ok "Backed up original config to $BACKUP_FILE"
  fi

  # Reject JSONC (comments). Presence of // or /* strongly suggests the file
  # is hand-edited JSONC; our line-based awk would mangle it. Bail cleanly.
  if grep -qE '^[[:space:]]*//|/\*' "$CONFIG_FILE"; then
    warn "Detected // or /* in $CONFIG_FILE — looks like JSONC with comments."
    print_manual_hint
  fi

  # Case C1: plugin array already contains opencode-chorus → no-op.
  # Scope the check to the "plugin" array itself: a top-level occurrence of
  # "opencode-chorus" outside that array (e.g. in a "lastInstalled" field)
  # must not trigger the no-op shortcut.
  plugin_contains_self() {
    awk -v plugin="$PLUGIN_NAME" '
      # Track whether we are currently inside the first "plugin" array.
      # State machine:
      #   0 = before the plugin key
      #   1 = inside the plugin array (between its [ and matching ])
      BEGIN { state = 0 }
      state == 0 {
        # Is the "plugin" key on this line?
        if (match($0, /"plugin"[[:space:]]*:[[:space:]]*\[/)) {
          # Consume the rest of the line starting at the [
          rest = substr($0, RSTART + RLENGTH - 1)
          state = 1
          # Fall through to state == 1 handling for this rest.
          $0 = rest
        } else {
          next
        }
      }
      state == 1 {
        # Look for the closing ] on this line (naive — good enough for
        # standard JSON because plugin entries are plain strings).
        close_pos = index($0, "]")
        if (close_pos > 0) {
          chunk = substr($0, 1, close_pos - 1)
        } else {
          chunk = $0
        }
        # Check for the quoted token inside the array chunk only.
        if (index(chunk, "\"" plugin "\"") > 0) {
          print "yes"
          exit 0
        }
        if (close_pos > 0) exit 0
      }
    ' "$CONFIG_FILE"
  }

  if [ "$(plugin_contains_self)" = "yes" ]; then
    ok "$PLUGIN_NAME already present in $CONFIG_FILE — nothing to do"
  else
    # Decide: Case B (no plugin key) vs Case C2 (plugin key exists without this plugin).
    if grep -qE '"plugin"[[:space:]]*:' "$CONFIG_FILE"; then
      # Case C2: insert into existing plugin array.
      # Strategy: find the first "plugin" key, locate its array bracket pair,
      # insert "opencode-chorus" before the closing ].
      #
      # Only handle the common cases where the array is on a single line or
      # a multi-line array that has one entry per line. Otherwise bail to hint.
      tmp="$(mktemp "${TMPDIR:-/tmp}/chorus-opencode.XXXXXX")"
      if awk -v plugin="$PLUGIN_NAME" '
        BEGIN { done = 0 }
        # Single-line empty array: "plugin": []
        !done && /"plugin"[[:space:]]*:[[:space:]]*\[[[:space:]]*\]/ {
          sub(/\[[[:space:]]*\]/, "[\"" plugin "\"]")
          done = 1
          print
          next
        }
        # Single-line non-empty array: "plugin": [ "foo", "bar" ]
        !done && match($0, /"plugin"[[:space:]]*:[[:space:]]*\[[^\]]*\]/) {
          line = $0
          pre  = substr(line, 1, RSTART - 1)
          match_text = substr(line, RSTART, RLENGTH)
          post = substr(line, RSTART + RLENGTH)
          # Insert before the closing ]
          sub(/\][[:space:]]*$/, ", \"" plugin "\"]", match_text)
          # If the match still ends in ] (no trailing whitespace stripped), fall through
          print pre match_text post
          done = 1
          next
        }
        # Multi-line array opener: "plugin": [ (and not on same line closer)
        !done && /"plugin"[[:space:]]*:[[:space:]]*\[[[:space:]]*$/ {
          print
          getline nextline
          # Empty multi-line array: next line is just ]
          if (nextline ~ /^[[:space:]]*\][[:space:]]*,?[[:space:]]*$/) {
            print "    \"" plugin "\""
            print nextline
            done = 1
            next
          }
          # Non-empty multi-line: emit entries verbatim until we hit the ]
          buffer[++bn] = nextline
          while ((getline nextline) > 0) {
            if (nextline ~ /^[[:space:]]*\][[:space:]]*,?[[:space:]]*$/) {
              # Last existing entry may not have trailing comma; add one.
              last = buffer[bn]
              if (last !~ /,[[:space:]]*$/) {
                sub(/[[:space:]]*$/, ",", buffer[bn])
              }
              for (i = 1; i <= bn; i++) print buffer[i]
              # Insert new entry before the closing ]
              # Determine indentation from first buffered entry.
              match(buffer[1], /^[[:space:]]*/)
              indent = substr(buffer[1], 1, RLENGTH)
              print indent "\"" plugin "\""
              print nextline
              done = 1
              bn = 0
              break
            }
            buffer[++bn] = nextline
          }
          next
        }
        { print }
        END {
          if (!done) exit 2
        }
      ' "$CONFIG_FILE" > "$tmp"; then
        mv "$tmp" "$CONFIG_FILE"
        chmod 600 "$CONFIG_FILE"
        ok "Added $PLUGIN_NAME to existing \"plugin\" array"
      else
        rm -f "$tmp"
        warn "The \"plugin\" key exists but I could not safely determine where to insert the new entry."
        EXISTING_PLUGIN_HINT=", ...your existing entries..."
        print_manual_hint
      fi
    else
      # Case B: no plugin key in file → inject it.
      # We look for the first top-level "{" then insert `"plugin": [...]` on the next line.
      # Safer: look for the first line containing just "{" optionally with whitespace.
      tmp="$(mktemp "${TMPDIR:-/tmp}/chorus-opencode.XXXXXX")"
      if awk -v plugin="$PLUGIN_NAME" '
        BEGIN { inserted = 0 }
        !inserted && /^[[:space:]]*\{[[:space:]]*$/ {
          print
          print "  \"plugin\": [\"" plugin "\"],"
          inserted = 1
          next
        }
        { print }
        END { if (!inserted) exit 2 }
      ' "$CONFIG_FILE" > "$tmp"; then
        mv "$tmp" "$CONFIG_FILE"
        chmod 600 "$CONFIG_FILE"
        ok "Added \"plugin\" field with $PLUGIN_NAME to $CONFIG_FILE"
      else
        rm -f "$tmp"
        warn "Could not find a line with just \"{\" to inject the plugin array."
        print_manual_hint
      fi
    fi
  fi
fi

# ---------- step 3: reminders ----------
hdr "3/3  Final reminders"

# Environment check — read-only warning, don't export.
missing_env=""
if [ -z "${CHORUS_URL:-}" ]; then
  missing_env="$missing_env CHORUS_URL"
fi
if [ -z "${CHORUS_API_KEY:-}" ]; then
  missing_env="$missing_env CHORUS_API_KEY"
fi

if [ -n "$missing_env" ]; then
  warn "The following environment variables are not set in this shell:$missing_env"
  warn "The plugin reads them on OpenCode startup. Please export them in your shell rc:"
  cat >&2 <<'HINT'

  export CHORUS_URL="https://<your-chorus-instance>"
  export CHORUS_API_KEY="cho_..."

HINT
  warn "Then re-source your shell rc, or launch opencode from a shell where they are exported."
else
  ok "CHORUS_URL and CHORUS_API_KEY are set in this shell"
fi

hdr "Done."
cat <<'NEXT'
Start OpenCode — Bun will fetch opencode-chorus on first launch:

  opencode

Then in OpenCode, ask the agent:

  check in to chorus

If the plugin fails to load, clear the package cache and retry:

  rm -rf ~/.cache/opencode/packages/opencode-chorus@latest

To roll back this change:
NEXT
printf "  mv %s %s\n\n" "$BACKUP_FILE" "$CONFIG_FILE"
