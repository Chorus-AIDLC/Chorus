#!/usr/bin/env bash
#
# Release script for @chorus-aidlc/chorus-openclaw-plugin.
#
# Orchestrates a safe npm publish:
#   1. pre-flight checks (right dir, npm login, version not already published)
#   2. full gate: clean -> typecheck -> test -> build  (so dist/ is fresh)
#   3. dist sanity check (dist/index.js exists with the right plugin id)
#   4. npm pack --dry-run preview of exactly what ships
#   5. interactive confirm (skip with --yes / FORCE_YES=1)
#   6. npm publish --access public   (scoped package first publish needs this)
#
# `package.json` also has a `prepublishOnly` hook that re-runs clean+typecheck+
# test+build, so a bare `npm publish` is still safe — this script just adds the
# pre-flight, preview, and confirmation around it.
#
# Usage:
#   npm run release                 # interactive
#   npm run release -- --yes        # skip the confirm prompt (CI / non-interactive)
#   npm run release -- --dry-run    # run gate + npm publish --dry-run (publishes nothing)
#
# This script is a maintainer dev tool — it is intentionally NOT in package.json
# `files`, so it is never shipped to npm.

set -euo pipefail

# Resolve the package root (this script lives in <pkg>/bin/).
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PKG_DIR"

# --- arg parsing ---------------------------------------------------------------
ASSUME_YES="${FORCE_YES:-0}"
PUBLISH_DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --yes|-y) ASSUME_YES=1 ;;
    --dry-run) PUBLISH_DRY_RUN=1 ;;
    *) echo "Unknown argument: $arg" >&2; exit 2 ;;
  esac
done

# --- read name + version (no jq dependency) ------------------------------------
PKG_NAME="$(node -p "require('./package.json').name")"
PKG_VERSION="$(node -p "require('./package.json').version")"
echo "==> Releasing ${PKG_NAME}@${PKG_VERSION}"
echo "    package dir: ${PKG_DIR}"
echo ""

# --- pre-flight: npm login -----------------------------------------------------
if ! NPM_USER="$(npm whoami 2>/dev/null)"; then
  echo "✗ Not logged in to npm. Run 'npm login' first, then re-run this script." >&2
  exit 1
fi
echo "==> npm user: ${NPM_USER}"

# --- pre-flight: version not already published ---------------------------------
# `npm view <name>@<version> version` prints the version if it exists, else errors.
if PUBLISHED="$(npm view "${PKG_NAME}@${PKG_VERSION}" version 2>/dev/null)" && [ -n "$PUBLISHED" ]; then
  echo "✗ ${PKG_NAME}@${PKG_VERSION} is already published on npm." >&2
  echo "  Bump the version in package.json before publishing (npm versions are immutable)." >&2
  exit 1
fi
echo "==> ${PKG_VERSION} is not yet published — OK to proceed"
echo ""

# --- gate: clean, typecheck, test, build --------------------------------------
echo "==> Running release gate (clean -> typecheck -> test -> build)..."
npm run clean
npm run typecheck
npm run test
npm run build
echo ""

# --- dist sanity check ---------------------------------------------------------
if [ ! -f dist/index.js ]; then
  echo "✗ dist/index.js missing after build." >&2
  exit 1
fi
if ! grep -q 'id: "chorus-openclaw-plugin"' dist/index.js; then
  echo "✗ dist/index.js does not contain the expected plugin id." >&2
  exit 1
fi
echo "==> dist/index.js OK (plugin id present)"
echo ""

# --- preview exactly what will ship -------------------------------------------
echo "==> Files that will be published:"
npm pack --dry-run
echo ""

# --- confirm -------------------------------------------------------------------
if [ "$PUBLISH_DRY_RUN" -eq 1 ]; then
  echo "==> --dry-run: running 'npm publish --dry-run --access public' (nothing is published)"
  npm publish --dry-run --access public
  echo "✓ Dry run complete. Nothing was published."
  exit 0
fi

if [ "$ASSUME_YES" -ne 1 ]; then
  printf "Publish %s@%s to npm now? [y/N] " "$PKG_NAME" "$PKG_VERSION"
  read -r REPLY
  case "$REPLY" in
    y|Y|yes|YES) ;;
    *) echo "Aborted. Nothing was published."; exit 0 ;;
  esac
fi

# --- publish -------------------------------------------------------------------
echo "==> Publishing ${PKG_NAME}@${PKG_VERSION}..."
npm publish --access public
echo ""
echo "✓ Published ${PKG_NAME}@${PKG_VERSION}"
echo "  Install with: openclaw plugins install npm:${PKG_NAME}"
