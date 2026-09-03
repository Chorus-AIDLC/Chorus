# Tasks

## 1. Enhance `scripts/docker-push.sh` for CI + opt-in latest
- [ ] Add `--no-latest` flag that omits the `:latest` tag
- [ ] Skip the interactive login guard when `CI=true` or `--assume-login`
- [ ] Preserve default local behavior (tag + latest, login guard)
- [ ] Update the usage comment block

## 2. Add `.github/workflows/docker-publish.yml`
- [ ] `branch-image` job: push to develop/main, branch-only tag, --no-latest, multi-arch, cancel-in-progress
- [ ] `release-image` job: release published, version + latest, multi-arch, tag-pinned checkout, no cancel
- [ ] QEMU + buildx + Docker Hub login via secrets
- [ ] Document DOCKERHUB_USERNAME / DOCKERHUB_TOKEN prerequisite
