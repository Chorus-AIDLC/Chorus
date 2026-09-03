# Tasks

## 1. Enhance `scripts/docker-push.sh` for CI + opt-in latest
- [x] Add `--no-latest` flag that omits the `:latest` tag
- [x] Skip the interactive login guard when `CI=true` or `--assume-login`
- [x] Preserve default local behavior (tag + latest, login guard)
- [x] Update the usage comment block

## 2. Add `.github/workflows/docker-publish.yml`
- [x] `branch-image` job: push to develop/main, branch-only tag, --no-latest, multi-arch, cancel-in-progress
- [x] `release-image` job: release published, version + latest, multi-arch, tag-pinned checkout, no cancel
- [x] QEMU + buildx + Docker Hub login via secrets
- [x] Document DOCKERHUB_USERNAME / DOCKERHUB_TOKEN prerequisite
