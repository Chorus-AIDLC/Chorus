# Auto-publish Docker images for develop/main (non-latest)

## Why

Today Chorus already auto-publishes npm packages on GitHub Release
(`.github/workflows/publish-npm.yml`), but Docker images are **only** built
manually via `scripts/docker-push.sh`. There is no automated Docker publish at
all — neither for day-to-day branch builds nor for releases.

Teams that deploy Chorus from a container want a fresh, pullable image for the
integration branches (`develop`, `main`) without waiting for a formal release,
and without those frequent branch images ever clobbering the `latest` tag that
production consumers depend on. Releases must keep their current tagging
behavior (immutable version tag + `latest`).

## What Changes

- **Branch images (`develop`, `main`)** — a new GitHub Actions workflow builds
  and pushes a multi-arch image on every push to `develop` or `main`
  (i.e. merged changes). Each branch image is tagged **only** with the moving
  branch name (`chorusaidlc/chorus-app:develop`, `:main`). It **never** updates
  `latest` and does not add a SHA tag.
- **Release images** — the same workflow, triggered on GitHub Release
  `published`, builds a multi-arch image tagged with the release version **and**
  updates `latest`, reusing the current tagging logic.
- **Reuse existing tooling** — the workflow reuses the repo's `Dockerfile`
  (`production` target), its multi-arch (`linux/amd64` + `linux/arm64`) build
  capability, and `scripts/docker-push.sh`. The script gains an opt-in
  `--no-latest` flag and a CI-friendly login mode so branch builds can skip the
  `latest` tag while release builds keep it. Default (local) behavior is
  unchanged.
- **Build de-duplication** — concurrent pushes to the same branch cancel the
  older in-progress build (`concurrency` + `cancel-in-progress`), so only the
  newest commit's image is produced. Release builds are never cancelled.

## Capabilities

- `docker-publish` — automated Docker image build & push for branches and
  releases, with tag policy that protects `latest`.

## Impact

- **New file:** `.github/workflows/docker-publish.yml`.
- **Modified:** `scripts/docker-push.sh` (add `--no-latest` + CI login handling;
  default behavior preserved).
- **Ops prerequisite:** two new repository secrets — `DOCKERHUB_USERNAME` and
  `DOCKERHUB_TOKEN` — must be configured for the workflow to authenticate to
  Docker Hub. The repo currently has no Docker-related secrets.
- **No application/runtime code changes**; no schema changes.
- **Registry:** existing Docker Hub repo `chorusaidlc/chorus-app` (unchanged).
