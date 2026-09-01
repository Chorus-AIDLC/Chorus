## 1. Coordinated Release Automation

- [x] 1.1 Implement the non-interactive release manifest and scripts that validate the GitHub Release version against all three package identities, run every package's applicable quality and package-content gates, create deterministic tarballs before publication, and publish them in fixed order with strict registry-error classification and idempotent skip behavior.
- [x] 1.2 Add `.github/workflows/publish-npm.yml` with GitHub Release triggering, GitHub-hosted Node/npm setup, minimal OIDC permissions, no npm token references, full prepare-before-publish orchestration, and an auditable package result summary.

## 2. Verification and Release Integration

- [x] 2.1 Add automated tests for version/name drift, all-three prepare gating, exact package order, already-published recovery, lookup and publish failure stopping, workflow permission/token invariants, tarball contents, and dry-run behavior.
- [x] 2.2 Update release and plugin-maintenance guidance so release preparation synchronizes all three package versions, documents the exact Trusted Publisher workflow contract, and explains GitHub Actions rerun recovery; execute the complete three-package dry-run and record verification evidence.
