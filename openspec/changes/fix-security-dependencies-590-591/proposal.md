# Dependency security and production migration compatibility

## Why

The checked-in lockfile and Docker migration CLI retain the dependency versions reported in Chorus #590 and #591. Operators need patched application and build dependencies while preserving production startup, database upgrades and the supported embedded database path. [1](ref:876ac293-e474-457b-8dcb-e8bc01458565) [2](ref:cacbd37d-1940-4b6f-b77f-a34691e142b3)

## What Changes

- Upgrade Next.js and its ESLint configuration to 15.5.27 and React / React DOM to 19.2.8, staying within the existing major versions.
- Update vulnerable PostCSS, nanoid 3.x and sharp resolutions using scoped overrides where needed. Preserve nanoid 5.x consumers and the existing docx / shiki overrides.
- Pin Prisma, its client and its PostgreSQL adapter together at 7.10.0. Derive the image migration CLI version from the package resolved during the build, and correct the Docker comment about unversioned installs.
- Verify frozen installs, application and affected workspace builds, existing tests, CSS / image functionality, both supported image architectures and both external PostgreSQL TLS and embedded PGlite.
- Deliver before/after dependency and final-image scan evidence, with upstream and OS findings explicitly separated from the remediated packages.

The human selected runtime and build dependencies, both database paths, and implementation after proposal approval. YOLO authorization permits autonomous lifecycle gates; publishing or merging remains outside this run.

## Capabilities

### New Capabilities

- `production-dependency-security`: patched dependency resolution without downgrading unaffected major versions, and transparent security verification for shipped images.
- `database-migration-runtime`: stable, matching migration tooling and compatible startup upgrades for external and embedded databases.

### Modified Capabilities

None. The existing `docker-publish` behavior and registry/tag policy remain intact.

## Impact

`package.json`, `pnpm-lock.yaml`, `Dockerfile`, focused migration-version validation, security verification documentation and OpenSpec artifacts. There are no intended API or database schema changes. Validation uses isolated databases, containers and local image tags.

Working tree: `/home/ubuntu/dev/Chorus-security-590-591`

Aggregate review base: `b2e9b2e0`
