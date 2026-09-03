# Design: Automated Docker publish for branches & releases

## Overview

Add one GitHub Actions workflow that publishes multi-arch Docker images to the
existing Docker Hub repo `chorusaidlc/chorus-app`, driven by two event sources:

| Trigger | Tags produced | `latest` updated? | De-dup |
|---|---|---|---|
| `push` to `develop` / `main` | moving branch tag (`:develop` / `:main`) | **No** | cancel-in-progress per ref |
| GitHub Release `published` | release version tag (`:vX.Y.Z`) + `:latest` | **Yes** | never cancelled |

The workflow reuses the repo's `Dockerfile` (`production` target), its multi-arch
build (`linux/amd64` + `linux/arm64`), and `scripts/docker-push.sh`. Elaboration
decisions (round 1) drive every choice above: merged-changes trigger,
branch-only tags, Docker Hub, GitHub-Release-driven release publish, full
multi-arch everywhere, cancel-old de-dup.

## Reusing `scripts/docker-push.sh`

The script today **always** appends `-t ${IMAGE}:latest` and requires an
interactive `docker login` (it greps `docker info` for `Username`). Two small,
backwards-compatible changes make it CI-usable:

1. **`--no-latest` flag** — when passed, `TAGS` is built as `-t ${IMAGE}:${TAG}`
   only, omitting the `:latest` tag. Without the flag, behavior is identical to
   today (`${TAG}` + `latest`).
2. **CI login handling** — the "Not logged in to Docker Hub" guard must not abort
   in CI where `docker/login-action` has already written
   `~/.docker/config.json` (which `docker info` does not always reflect as
   `Username`). Add an opt-out: skip the interactive guard when `CI=true` **or**
   an explicit `--assume-login` flag is passed. The push itself still fails
   loudly if credentials are actually missing, so this only removes a false
   negative.

Default local invocations (`./scripts/docker-push.sh` and
`./scripts/docker-push.sh v1.2.3`) keep producing `TAG` + `latest` with the
login guard intact — no behavior change for humans.

### Resulting invocation matrix

| Context | Command |
|---|---|
| Branch build (CI) | `./scripts/docker-push.sh "$BRANCH" --no-latest` (with `CI=true`) |
| Release build (CI) | `./scripts/docker-push.sh "$RELEASE_TAG"` (with `CI=true`) → `TAG` + `latest` |
| Local release (unchanged) | `./scripts/docker-push.sh v1.2.3` |

## Workflow structure — `.github/workflows/docker-publish.yml`

```yaml
name: Publish Docker image

on:
  push:
    branches: [develop, main]
  release:
    types: [published]

permissions:
  contents: read

jobs:
  branch-image:
    name: Build & push branch image (no latest)
    if: github.event_name == 'push'
    runs-on: ubuntu-latest
    # De-dup: only the newest commit per branch survives; older runs are cancelled.
    concurrency:
      group: docker-branch-${{ github.ref }}
      cancel-in-progress: true
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-qemu-action@v3      # arm64 emulation for multi-arch
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          username: ${{ secrets.DOCKERHUB_USERNAME }}
          password: ${{ secrets.DOCKERHUB_TOKEN }}
      - name: Build & push branch image
        env:
          CI: "true"
        run: ./scripts/docker-push.sh "${GITHUB_REF_NAME}" --no-latest

  release-image:
    name: Build & push release image (+ latest)
    if: github.event_name == 'release'
    runs-on: ubuntu-latest
    # No concurrency cancel — every release image must complete.
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event.release.tag_name }}
      - uses: docker/setup-qemu-action@v3
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          username: ${{ secrets.DOCKERHUB_USERNAME }}
          password: ${{ secrets.DOCKERHUB_TOKEN }}
      - name: Build & push release image + latest
        env:
          CI: "true"
        run: ./scripts/docker-push.sh "${{ github.event.release.tag_name }}"
```

Notes:

- **`GITHUB_REF_NAME`** resolves to `develop` / `main` on the branch job — that
  is the moving branch tag, matching the "branch-only" decision.
- **QEMU** is required because `linux/arm64` is cross-built on amd64 runners; the
  existing script assumes a buildx builder but not QEMU, so the workflow adds
  `setup-qemu-action`. `setup-buildx-action` provides the `docker-container`
  builder the script also tries to create — the script's
  `docker buildx inspect`/`create` is idempotent and tolerates a pre-existing
  builder.
- **Release checkout pins the tag** (like `publish-npm.yml`) so the built image
  matches the immutable release ref rather than the branch head.
- **Concurrency scope**: only `branch-image` cancels older runs; the release job
  has no `concurrency` block, so release builds always finish (matches the
  cancel-old decision, which is explicitly about same-branch rapid commits).

## Precedent / verification

- Existing `publish-npm.yml` establishes the `release: [published]` +
  tag-pinned-checkout pattern to mirror.
- `docker/build-push-action`, `docker/setup-buildx-action`,
  `docker/setup-qemu-action`, `docker/login-action` action **major versions and
  input names** must be verified against the official docs at implementation
  time (do not rely on memory) —
  https://github.com/docker/build-push-action and
  https://docs.docker.com/build/ci/github-actions/multi-platform/.

## Risks & mitigations

- **CI login guard false-negative** — mitigated by the `CI=true` / `--assume-login`
  opt-out; the actual `buildx --push` still fails if creds are wrong.
- **Missing Docker Hub secrets** — the workflow fails fast at `login-action`.
  Documented as an ops prerequisite; must be set before first run.
- **arm64 emulation build time** — cross-building arm64 via QEMU is slower;
  acceptable per the "full multi-arch everywhere" decision. Buildx layer caching
  can be added later if build time becomes a problem (out of scope here).
- **Accidental `latest` clobber from branches** — structurally prevented: the
  branch job always passes `--no-latest`, and only the release job omits it.

## Out of scope

- GHCR mirroring (Docker Hub only, per elaboration).
- SHA / immutable branch tags (branch-only decision).
- Build-cache tuning, image signing, SBOM/provenance attestation.
