## Purpose

Keep production database migration tooling stable and compatible with the generated client, preserving operator data during startup upgrades in external and embedded database deployments.

## ADDED Requirements

### Requirement: Matching stable migration tooling

The production migration CLI SHALL use the exact stable 7.x version resolved for the client and adapter during the application build. Invalid or mismatched versions SHALL fail the build.

#### Scenario: Matching versions produce the production CLI

- **WHEN** the installed Prisma CLI, client and PostgreSQL adapter resolve to the same stable version
- **THEN** the production image installs that exact migration CLI version
- **AND** it provides the production migration command

#### Scenario: Mismatched or prerelease versions fail

- **WHEN** the build encounters differing versions or a prerelease version for the migration tooling
- **THEN** the version-export step fails
- **AND** no fallback to an unversioned installation occurs

### Requirement: Compatible startup migrations on supported databases

Patched production images SHALL complete startup migrations for new and existing external PostgreSQL TLS and embedded PGlite databases on amd64 and arm64, retaining seeded data and supporting repeated startup.

#### Scenario: Fresh database startup

- **WHEN** a patched image starts with a new supported database
- **THEN** all pending migrations apply and the application becomes healthy

#### Scenario: Existing database upgrade and repeated startup

- **WHEN** a baseline database containing seeded records starts with a patched image and is subsequently restarted
- **THEN** pending migrations apply without losing seeded records
- **AND** repeated startup completes without reapplying completed migrations

### Requirement: Development and CI database tooling remains usable

The pinned database tooling SHALL preserve client generation and the database schema synchronization command used by CI.

#### Scenario: CI preparation with patched tooling

- **WHEN** CI generates the client and synchronizes an isolated test database
- **THEN** both commands complete successfully with the pinned tooling
