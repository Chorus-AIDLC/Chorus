# docker-publish

## ADDED Requirements

### Requirement: Branch image auto-publish without `latest`

The system SHALL automatically build and push a multi-arch Docker image to
`chorusaidlc/chorus-app` on every push to the `develop` or `main` branch. Each
such image SHALL be tagged only with its moving branch name and SHALL NOT update
the `latest` tag or add any commit-SHA tag.

#### Scenario: Push to develop publishes a branch-tagged image

- **WHEN** a commit is pushed (including via merged PR) to the `develop` branch
- **THEN** a `linux/amd64` + `linux/arm64` image is built from the `Dockerfile`
  `production` target and pushed as `chorusaidlc/chorus-app:develop`
- **AND** the `chorusaidlc/chorus-app:latest` tag is NOT modified
- **AND** no commit-SHA tag is pushed

#### Scenario: Push to main publishes a branch-tagged image

- **WHEN** a commit is pushed to the `main` branch
- **THEN** a multi-arch image is pushed as `chorusaidlc/chorus-app:main`
- **AND** the `latest` tag is NOT modified

### Requirement: Release image auto-publish with `latest`

The system SHALL automatically build and push a multi-arch Docker image when a
GitHub Release is published, tagged with the release version AND updating the
`latest` tag, reusing the existing release tagging logic.

#### Scenario: Publishing a GitHub Release publishes version + latest

- **WHEN** a GitHub Release with tag `vX.Y.Z` is published
- **THEN** the workflow checks out the immutable release tag ref
- **AND** a multi-arch image is pushed as `chorusaidlc/chorus-app:vX.Y.Z`
- **AND** the `chorusaidlc/chorus-app:latest` tag is updated to the same image

### Requirement: Same-branch build de-duplication

The system SHALL ensure that only the newest commit's image is produced when
multiple pushes to the same branch occur in quick succession, by cancelling any
older in-progress branch build. Release builds SHALL NOT be cancelled.

#### Scenario: Rapid pushes to the same branch cancel the stale build

- **WHEN** a second commit is pushed to `develop` while the previous `develop`
  image build is still running
- **THEN** the older in-progress branch build is cancelled
- **AND** only the newest commit's image is built and pushed

#### Scenario: Release builds always complete

- **WHEN** a release image build is in progress and another workflow event fires
- **THEN** the release build is NOT cancelled and runs to completion

### Requirement: Reuse existing build tooling with opt-in tag control

The Docker publish flow SHALL reuse the repository's `Dockerfile`, multi-arch
build capability, and `scripts/docker-push.sh`. The script SHALL support an
opt-in `--no-latest` mode that omits the `latest` tag, and SHALL not abort its
login guard in a CI environment. Its default (local, no-flag) behavior SHALL
remain unchanged — producing the resolved tag plus `latest`.

#### Scenario: Script omits latest when --no-latest is passed

- **WHEN** `scripts/docker-push.sh <tag> --no-latest` is invoked
- **THEN** the image is tagged only `<tag>` and the `latest` tag is not pushed

#### Scenario: Script preserves default behavior without the flag

- **WHEN** `scripts/docker-push.sh v1.2.3` is invoked without `--no-latest`
- **THEN** the image is tagged `v1.2.3` AND `latest`, as before

#### Scenario: Login guard does not block CI

- **WHEN** the script runs with `CI=true` (or `--assume-login`) after an external
  `docker login` has authenticated the runner
- **THEN** the interactive "not logged in" guard does not abort the build
- **AND** the push still fails loudly if the credentials are actually invalid
