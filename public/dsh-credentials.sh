#!/usr/bin/env bash
# Chorus credential writer for DeepSeek Harness (dsh) — DEPRECATED.
#
# Chorus setup (credentials + plugin) is now a global install plus a single
# command that configures every supported agent
# (claude / codex / opencode / kiro / openclaw / dsh):
#
#   npm install -g @chorus-aidlc/chorus@0.17.0
#   chorus agents add
#
# This script is still fetched via curl for backward compatibility, but it no
# longer writes credentials itself — it just points you at `chorus agents add`.
#
# Bash 3.2 compatible (macOS /bin/bash): no case-conversion parameter expansion,
# no associative arrays.

set -euo pipefail

BOLD=$'\033[1m'; YELLOW=$'\033[33m'; RESET=$'\033[0m'
INSTALL_CMD="npm install -g @chorus-aidlc/chorus@0.17.0"
INIT_CMD="chorus agents add"

printf "${YELLOW}!${RESET} dsh-credentials.sh is deprecated and writes nothing.\n" >&2
printf "  Chorus setup is now: ${BOLD}%s${RESET} then ${BOLD}%s${RESET}\n" "$INSTALL_CMD" "$INIT_CMD" >&2

# This stub writes nothing. Print the exact commands and exit non-zero so
# both interactive users and automation that piped the old installer notice
# they must install the Chorus CLI globally, then run `chorus agents add`.
printf "\n  Run these to set up Chorus:\n\n    %s\n    %s\n\n" "$INSTALL_CMD" "$INIT_CMD" >&2
exit 1
