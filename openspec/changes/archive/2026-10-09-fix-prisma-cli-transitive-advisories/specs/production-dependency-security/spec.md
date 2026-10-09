## ADDED Requirements

### Requirement: Patched migration CLI transitive dependencies

The production image SHALL install its Prisma migration CLI so that the CLI's transitive dependencies resolve to versions outside reported vulnerable ranges, even when the upstream CLI pins a vulnerable version exactly. The CLI version SHALL remain the exact stable Prisma 7.x pin that matches the application's Prisma client and PostgreSQL adapter.

#### Scenario: Pinned vulnerable CLI dependencies are overridden

- **WHEN** the production image is built with a Prisma CLI that pins `mysql2` 3.15.3 and `deepmerge-ts` 7.1.5
- **THEN** the installed CLI tree contains only `mysql2` 3.24.5 and `deepmerge-ts` 8.0.2, including any nested copies
- **AND** the build fails if either resolved version differs from the override

#### Scenario: Migrations still run with the overridden CLI

- **WHEN** the patched production image starts against a supported external PostgreSQL database or in its default embedded-database mode
- **THEN** `prisma migrate deploy` completes successfully from the entrypoint
- **AND** health, login and authenticated project listing succeed

#### Scenario: Image scan shows no fixable findings for the target packages

- **WHEN** the patched production image is scanned
- **THEN** no fixable HIGH or Critical advisory is reported for `mysql2`, `deepmerge-ts` or `source-map-js`
- **AND** any remaining findings are recorded with package, installed version and advisory
