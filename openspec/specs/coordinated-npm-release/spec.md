# coordinated-npm-release Specification

## Purpose
TBD - created by archiving change automate-coordinated-npm-releases. Update Purpose after archive.
## Requirements
### Requirement: Release-triggered coordinated publication
The repository SHALL run one coordinated npm publication workflow when a GitHub Release is published, and the workflow MUST process exactly `@chorus-aidlc/chorus`, `@chorus-aidlc/chorus-openclaw-plugin`, and `@chorus-aidlc/chorus-dsh`.

#### Scenario: Published GitHub Release starts publication
- **WHEN** a maintainer publishes a GitHub Release for tag `vX.Y.Z`
- **THEN** the coordinated workflow checks out that tag and prepares all three supported npm packages for version `X.Y.Z`

#### Scenario: Non-release repository activity
- **WHEN** commits or pull requests are created without publishing a GitHub Release
- **THEN** the coordinated npm publication workflow does not publish any package

### Requirement: Lockstep release identity
The workflow MUST verify before any registry write that the release tag is a valid `vX.Y.Z` version and that all three supported package manifests have their expected package names and the exact version `X.Y.Z`.

#### Scenario: All package identities match
- **WHEN** the Release tag and all three package manifests contain the same valid version and expected names
- **THEN** the workflow may continue to package preparation

#### Scenario: A version or package name differs
- **WHEN** any package version differs from the Release tag or any package name differs from the supported manifest
- **THEN** the workflow fails before publishing any package

### Requirement: Tokenless trusted publication
The workflow SHALL authenticate npm publication through GitHub Actions OIDC and npm Trusted Publishing, MUST grant only `contents: read` and `id-token: write` permissions needed by the release job, and MUST NOT require an npm access token in repository or environment secrets.

#### Scenario: Trusted Publisher is correctly configured
- **WHEN** the workflow runs on a GitHub-hosted runner with a supported Node and npm CLI and invokes `npm publish`
- **THEN** npm obtains a short-lived OIDC-backed publishing credential without `NPM_TOKEN` or `NODE_AUTH_TOKEN`

#### Scenario: OIDC trust configuration does not match
- **WHEN** npm rejects the workflow identity because repository, workflow filename, Environment, or allowed action differs from the Trusted Publisher configuration
- **THEN** publication fails and the workflow does not fall back to a stored npm token

### Requirement: Complete pre-publication gate
The workflow MUST complete applicable lint, typecheck, test, build, package-content validation, and tarball creation for all three packages before uploading the first package.

#### Scenario: All package gates pass
- **WHEN** every package passes its required checks and produces a validated tarball
- **THEN** the workflow enters the publication phase using those validated tarballs

#### Scenario: Any package gate fails
- **WHEN** a check, build, package validation, or tarball creation fails for any supported package
- **THEN** the workflow stops before any npm registry write

### Requirement: Deterministic sequential publication
The workflow MUST publish validated tarballs in the fixed order Chorus CLI, OpenClaw plugin, then dsh plugin, and MUST stop attempting later unpublished packages after an upload failure.

#### Scenario: All versions are unpublished
- **WHEN** all three validated package versions are absent from npm
- **THEN** the workflow publishes the three tarballs in the configured order and reports each as published

#### Scenario: A package upload fails
- **WHEN** npm rejects or cannot complete one package upload
- **THEN** the workflow fails immediately and does not attempt later unpublished packages

### Requirement: Idempotent recovery after partial publication
Before each upload, the workflow MUST query the exact package name and version, skip only versions confirmed as already published, and treat lookup errors other than confirmed absence as fatal.

#### Scenario: Rerun after one package succeeded
- **WHEN** the workflow is rerun for the same Release and the first package version already exists while the remaining versions do not
- **THEN** the workflow records the first package as `skipped-already-published` and continues with the remaining packages in order

#### Scenario: Registry lookup is unavailable or unauthorized
- **WHEN** the workflow cannot reliably determine whether a package version exists because of a network, authorization, or rate-limit error
- **THEN** the workflow fails without attempting that package upload

### Requirement: Auditable release result
The workflow MUST expose a final summary containing the Release version and the published or skipped state of every processed package, and MUST avoid logging credentials or OIDC tokens.

#### Scenario: Successful fresh publication
- **WHEN** all three packages are newly published
- **THEN** the job summary identifies all three package names and versions as published

#### Scenario: Successful recovery rerun
- **WHEN** one or more packages are skipped because their exact versions already exist and all remaining packages publish successfully
- **THEN** the job summary distinguishes skipped packages from newly published packages without exposing authentication material
