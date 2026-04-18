#!/usr/bin/env bash
set -euo pipefail

# Publish @chorus-aidlc/chorus to npm
# Usage:
#   ./scripts/npm-publish.sh           # publish current version
#   ./scripts/npm-publish.sh --dry-run # test without publishing

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

DRY_RUN=false
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
fi

PKG_NAME=$(node -e "console.log(require('./package.json').name)")
PKG_VERSION=$(node -e "console.log(require('./package.json').version)")

echo "========================================="
echo "  Publishing ${PKG_NAME}@${PKG_VERSION}"
echo "========================================="
echo ""

# --- 1. Pre-flight checks ---

echo "[1/4] Pre-flight checks..."

if ! command -v npm &>/dev/null; then
  echo "ERROR: npm not found" >&2
  exit 1
fi

if [[ "$DRY_RUN" == false ]]; then
  if ! npm whoami &>/dev/null; then
    echo "ERROR: Not logged in to npm. Run 'npm login' first." >&2
    exit 1
  fi
  NPM_USER=$(npm whoami)
  echo "  npm user: ${NPM_USER}"
fi

# Check for uncommitted changes
if [[ -n "$(git status --porcelain)" ]]; then
  echo "WARNING: Uncommitted changes detected."
  echo "  Consider committing before publishing."
  if [[ "$DRY_RUN" == false ]]; then
    read -rp "  Continue anyway? [y/N] " confirm
    if [[ "${confirm}" != "y" && "${confirm}" != "Y" ]]; then
      echo "Aborted."
      exit 1
    fi
  fi
fi

echo "  version: ${PKG_VERSION}"
echo ""

# --- 2. Pack (triggers prepack: build + dereference + copy static) ---

echo "[2/4] Packing tarball (runs prepack automatically)..."
TARBALL=$(npm pack --pack-destination /tmp/ 2>&1 | tail -1)
TARBALL_PATH="/tmp/${TARBALL}"
TARBALL_SIZE=$(du -h "$TARBALL_PATH" | cut -f1)
echo "  tarball: ${TARBALL}"
echo "  size:    ${TARBALL_SIZE}"
echo ""

# --- 3. Smoke test ---

echo "[3/4] Smoke test..."
INSTALL_DIR=$(mktemp -d)
npm install --prefix "$INSTALL_DIR" "$TARBALL_PATH" --no-save 2>/dev/null

CHORUS_BIN="${INSTALL_DIR}/node_modules/.bin/chorus"
if [[ ! -x "$CHORUS_BIN" ]]; then
  echo "ERROR: chorus binary not found after install" >&2
  rm -rf "$INSTALL_DIR"
  exit 1
fi

INSTALLED_VERSION=$("$CHORUS_BIN" --version 2>/dev/null)
if [[ "$INSTALLED_VERSION" != "$PKG_VERSION" ]]; then
  echo "ERROR: Version mismatch. Expected ${PKG_VERSION}, got ${INSTALLED_VERSION}" >&2
  rm -rf "$INSTALL_DIR"
  exit 1
fi

echo "  chorus --version: ${INSTALLED_VERSION} ✓"
rm -rf "$INSTALL_DIR"
echo ""

# --- 4. Publish ---

echo "[4/4] Publishing..."
if [[ "$DRY_RUN" == true ]]; then
  echo "  DRY RUN — skipping actual publish"
  echo ""
  echo "  To publish for real:"
  echo "    ./scripts/npm-publish.sh"
  echo ""
  echo "  Or manually:"
  echo "    npm publish --access public"
else
  npm publish --access public
  echo ""
  echo "========================================="
  echo "  Published ${PKG_NAME}@${PKG_VERSION}"
  echo "========================================="
  echo ""
  echo "  Install:  npm install -g ${PKG_NAME}"
  echo "  Run:      chorus"
  echo "  npx:      npx ${PKG_NAME}"
fi

# Cleanup
rm -f "$TARBALL_PATH"
