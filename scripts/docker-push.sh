#!/usr/bin/env bash
set -euo pipefail

# ─── Config ──────────────────────────────────────────────────────────────────
IMAGE="chorusaidlc/chorus-app"
PLATFORMS="linux/amd64,linux/arm64"
BUILDER_NAME="chorus-multiarch"

# ─── Resolve tag ─────────────────────────────────────────────────────────────
# Usage:
#   ./scripts/docker-push.sh              → tags: latest + git short SHA
#   ./scripts/docker-push.sh v1.2.3       → tags: v1.2.3 + latest
#   ./scripts/docker-push.sh --no-push    → build only, don't push
#   ./scripts/docker-push.sh --no-latest  → tag ONLY :${TAG}, omit :latest
#   ./scripts/docker-push.sh --assume-login → skip the interactive Docker Hub
#                                             login guard (also skipped when
#                                             CI=true). buildx --push still
#                                             fails loudly on bad credentials.
NO_PUSH=false
NO_LATEST=false
ASSUME_LOGIN=false
TAG=""

for arg in "$@"; do
  case "$arg" in
    --no-push)     NO_PUSH=true ;;
    --no-latest)   NO_LATEST=true ;;
    --assume-login) ASSUME_LOGIN=true ;;
    *)             TAG="$arg" ;;
  esac
done

GIT_SHA=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
GIT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")

if [ -z "$TAG" ]; then
  TAG="$GIT_SHA"
fi

# Validate the tag against Docker's tag grammar
# ([A-Za-z0-9_][A-Za-z0-9_.-]{0,127}). This rejects shell metacharacters
# ($(), backticks, ;, spaces, …) so a hostile branch/release tag can never
# smuggle a command into the build invocation. Defense-in-depth: the build
# is also run via an argv array (no eval), so nothing is word-split anyway.
if ! printf '%s' "$TAG" | grep -Eq '^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$'; then
  echo "Invalid image tag: '${TAG}' (allowed: [A-Za-z0-9_][A-Za-z0-9_.-]{0,127})" >&2
  exit 1
fi

# Build the tag arguments as an array (never a word-split string).
TAG_ARGS=(-t "${IMAGE}:${TAG}")
if [ "$NO_LATEST" != true ]; then
  TAG_ARGS+=(-t "${IMAGE}:latest")
fi

echo "============================================"
echo "  Chorus Docker Multi-Arch Build & Push"
echo "============================================"
echo "  Image:      ${IMAGE}"
echo "  Tag:        ${TAG}"
echo "  Platforms:  ${PLATFORMS}"
echo "  Git SHA:    ${GIT_SHA}"
echo "  Git Branch: ${GIT_BRANCH}"
echo "  Push:       $( [ "$NO_PUSH" = true ] && echo 'NO' || echo 'YES' )"
echo "============================================"
echo ""

# ─── Ensure buildx builder exists ───────────────────────────────────────────
if ! docker buildx inspect "$BUILDER_NAME" &>/dev/null; then
  echo "Creating buildx builder: ${BUILDER_NAME} ..."
  docker buildx create --name "$BUILDER_NAME" --driver docker-container --use
else
  echo "Using existing builder: ${BUILDER_NAME}"
  docker buildx use "$BUILDER_NAME"
fi

# Bootstrap the builder (pulls the buildkit image if needed)
docker buildx inspect --bootstrap

# ─── Build & Push ────────────────────────────────────────────────────────────
echo ""
echo "Building for platforms: ${PLATFORMS} ..."

# Build the buildx argument vector as an array. Running docker directly with
# "${BUILD_ARGS[@]}" (no `eval`, no string interpolation) means the tag and
# every other value are passed as literal argv elements — a tag containing
# shell syntax cannot be interpreted as a command.
BUILD_ARGS=(
  buildx build
  --platform "${PLATFORMS}"
  --target production
  --label "org.opencontainers.image.source=https://github.com/chorusaidlc/chorus-app"
  --label "org.opencontainers.image.revision=${GIT_SHA}"
  --label "org.opencontainers.image.created=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  "${TAG_ARGS[@]}"
)

if [ "$NO_PUSH" = true ]; then
  # --load only works for single platform; for multi-arch without push, use --output
  echo "(--no-push mode: building without pushing)"
  docker "${BUILD_ARGS[@]}" --output type=image,push=false .
else
  # Ensure logged in — but skip the guard in CI or when explicitly assured.
  # docker/login-action writes ~/.docker/config.json which does not always
  # surface as "Username" in `docker info`, so the guard would false-positive.
  # buildx --push still fails loudly if the credentials are actually invalid.
  if [ "${CI:-}" = true ] || [ "$ASSUME_LOGIN" = true ]; then
    echo "(skipping interactive login guard: CI/--assume-login)"
  elif ! docker info 2>/dev/null | grep -q "Username"; then
    echo "Not logged in to Docker Hub. Run 'docker login' first."
    exit 1
  fi
  docker "${BUILD_ARGS[@]}" --push .
fi

echo ""
echo "Done! Image: ${IMAGE}:${TAG}"
if [ "$NO_PUSH" = false ]; then
  if [ "$NO_LATEST" = true ]; then
    echo "Pushed: ${IMAGE}:${TAG}"
  else
    echo "Pushed: ${IMAGE}:${TAG} and ${IMAGE}:latest"
  fi
  echo ""
  echo "Pull with:"
  echo "  docker pull ${IMAGE}:${TAG}"
fi
