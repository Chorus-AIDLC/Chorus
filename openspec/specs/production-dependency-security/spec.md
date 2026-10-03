# production-dependency-security Specification

## Purpose
Ensure shipped Chorus applications use patched dependency versions while preserving compatible consumers and making remaining security findings visible to operators.

## Requirements

### Requirement: Patched target dependency resolution

The application and build dependency graph SHALL resolve the target packages to patched versions within the approved major lines and SHALL preserve unaffected consumers using other major lines.

#### Scenario: Frozen install selects patched application and build packages

- **WHEN** the approved manifest and lockfile are installed with the repository's frozen-install command
- **THEN** Next.js, React, PostCSS, nanoid 3.x and sharp resolve to versions outside the reported vulnerable ranges
- **AND** the installation does not rewrite the lockfile

#### Scenario: nanoid 5.x consumers are preserved

- **WHEN** the affected nanoid 3.x resolutions are upgraded
- **THEN** a consumer requiring nanoid 5.x continues to receive a compatible 5.x release

### Requirement: Supported application behavior after dependency updates

The upgraded application SHALL retain production build, CSS rendering, image processing, login and authenticated project access behavior on the supported image architectures.

#### Scenario: Production image smoke verification

- **WHEN** a patched amd64 or arm64 production image starts with a supported database
- **THEN** health and login succeed, authenticated project listing succeeds, and unauthenticated project listing returns 401
- **AND** representative UI, CSS and image-processing checks succeed

### Requirement: Independent and complete security evidence

Security verification SHALL record baseline and patched dependency and final-image results, including globally installed CLI and OS packages, and SHALL distinguish patched target findings from residual findings.

#### Scenario: Scan comparison contains upstream residuals

- **WHEN** a patched image scan still identifies an upstream or OS advisory
- **THEN** the verification record names the package, installed version and advisory with a follow-up
- **AND** the report does not claim an entirely clean image
