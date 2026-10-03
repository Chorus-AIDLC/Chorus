# Tasks

## 1. Application and build dependency remediation

- [x] 1.1 Upgrade approved direct versions and scoped transitive overrides; verify patched resolutions, retained nanoid 5.x consumers and a frozen install.
- [x] 1.2 Run type/lint/test, standalone and affected workspace builds; retain command results for later integration review.

## 2. Prisma and Docker migration consistency

- [x] 2.1 Pin the Prisma trio and regenerate the lockfile/client; verify installed versions, generation and CI schema synchronization.
- [x] 2.2 Export a validated installed migration version and wire the Docker production CLI; verify matching, mismatch and prerelease behavior with focused tests.

## 3. Production integration and security evidence

- [ ] 3.1 Build and inspect amd64/arm64 production images; verify external PostgreSQL TLS and PGlite fresh, baseline-data upgrade and repeated-start paths.
- [ ] 3.2 Verify health/login/projects, representative browser CSS and sharp processing; record audit/image scan comparisons, residual advisories and exact verification limits.
