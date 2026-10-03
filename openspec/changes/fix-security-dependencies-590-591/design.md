# Design

## Context

The baseline lockfile resolves Next.js 15.5.12, React 19.2.3 and Prisma 7.3.0. The Docker production stage separately installs Prisma 7.3.0 globally. Startup executes `prisma migrate deploy` for both external PostgreSQL and an embedded PGlite socket server.

Existing evidence confirms Next.js 15.5.27 still pins PostCSS 8.4.31 and accepts sharp `^0.34.3 || ^0.35.4`. [3](ref:c907be29-c9cf-468d-8334-b1f38092663f) Prisma's `latest` tag points to an 8 RC, while 7.10.0 retains `migrate deploy` and requires Node `^20.19 || ^22.12 || >=24.0`. [4](ref:7833d6ac-c5d2-4251-93bc-fa276b1fe38c) [5](ref:35fd1d0d-884e-4dc7-9696-09c2cbb11154)

The reported CVEs and scan improvements are reporter evidence, not independently reproduced results. This run must produce its own audit, build and runtime evidence.

## Goals / Non-Goals

Goals are patched target dependency resolution, matching production migration tooling, stable runtime behavior and reproducible evidence.

This design does not change schema migrations, application authentication or deployment publication. It does not claim that updating the target packages eliminates all image vulnerabilities.

## Decisions

### D1. Patch existing major lines and serialize lockfile changes

Use exact direct versions for Next.js / eslint-config-next 15.5.27, React / React DOM 19.2.8 and the Prisma trio 7.10.0. Regenerate the lockfile with the repository's pnpm version and validate a frozen installation. Do not perform unrelated broad updates.

PostCSS candidates must be at least 8.5.18, nanoid 3.x at least 3.3.18 and sharp at least 0.35.4. Prefer current compatible patches (the issue reports 8.5.28, 3.3.19 and 0.35.5); record actual resolved versions. Confirm package availability and constraints using official package metadata during implementation.

Scope nanoid overrides to the affected 3.x line so `docx` continues to resolve its 5.x dependency. Select sharp override scope after checking its workspace consumers; validate any affected landing build. Retain the existing docx and shiki overrides.

Task 1 and Task 2 execute sequentially because both update the same package manifest and lockfile.

### D2. Derive the migration CLI from the installed build package

After dependency installation in the builder, read `node_modules/prisma/package.json` and the installed client/adapter versions. Require all three to match an exact stable 7.x version, then export that version as a small build artifact. Copy this artifact into production and use it for an explicitly versioned global CLI install.

The artifact avoids regex parsing of YAML peer suffixes and a fourth manually maintained version. A malformed version or mismatch must fail the image build rather than silently install a different CLI. A small executable helper with meaningful mismatch / prerelease failure tests is appropriate if validation would otherwise obscure the Dockerfile.

Correct the comment: the risk is unversioned installation following mutable dist-tags. Later stable 7.x CLIs still support production migrations. Keep production's dotenv module and PGlite dependencies available.

### D3. Verify the actual production path

Use local production images on `linux/amd64` and `linux/arm64`. Emulated arm64 is acceptable for this local verification; identify emulation in the evidence. Existing native CI publication is unchanged.

For both architectures, verify image versions and startup against external PostgreSQL TLS and embedded PGlite. Each database mode needs a new-database path and an existing-database path seeded by the baseline, followed by upgraded startup, migration count / seeded-row checks and a second startup. Temporary credentials, databases, volumes, ports and image tags must be dedicated to this effort.

Verify `prisma generate`, `db push` (used by CI) and `migrate deploy`. Run existing type/lint/test/build checks. Exercise health, login, authenticated and unauthenticated projects requests, representative rendered UI/CSS and sharp image processing.

### D4. Security evidence covers the final image

Capture baseline and updated dependency audit output and scan locally built baseline and updated images with the same scanner and vulnerability database. Record scanner version, database time, image identity and package findings. Image scans must include globally installed Prisma and OS packages.

The acceptance target is removal of the reported HIGH/CRITICAL findings in patched target package ranges. Residual upstream Prisma or OS findings receive package/advisory evidence and a follow-up, not a false zero-findings assertion. If the current feed differs from reporter data, reconcile the difference with ranges and installed package versions.

### D5. Evidence and lifecycle ownership

Chorus task drafts are authoritative; local `tasks.md` mirrors checklist progress. Add `verification.md` to this change folder with commands, exit codes, image digests, runtime matrix, scan comparison and limitations. Small repeatable verification tooling may live under `scripts/`; avoid implementation-mirroring tests for simple version bumps.

Commit only this run's changes to `fix/security-dependencies-590-591`; do not push, merge, publish images or modify production data.

## Module Contracts

- Task 1 owns application version changes and its lockfile update, plus local build/test evidence.
- Task 2 starts after Task 1 verification and owns the Prisma trio, migration-version artifact/helper, Docker wiring and focused failure tests.
- Task 3 starts after Task 2 verification and owns isolated image/database/browser/security integration evidence and any verification harness. Earlier task evidence is reused unless integration changes require reruns.
- Final aggregate review compares the working branch against `b2e9b2e0`, excluding unrelated baseline feature work.

## Risks / Trade-offs

- Dependency overrides can affect workspaces → inspect the resolved graph and run affected workspace builds.
- Prisma upgrades can expose migration or PGlite differences → run fresh / existing / repeated-start paths for both database modes.
- arm64 emulation is slower → run finite-timeout commands with retained logs; do not claim a native test.
- Current scanners can expose unrelated or upstream findings → identify target findings and document residual advisories.
- Global Prisma resolution can differ from the project lockfile transitively → verify exact CLI version and scan the final image.

## Migration Plan

No new application migrations are added. An operator builds the patched image and runs the usual startup migration against a backed-up database. Validate it in isolated copies before rollout. Rollback uses the prior image; existing application migration rollback policy remains unchanged.
