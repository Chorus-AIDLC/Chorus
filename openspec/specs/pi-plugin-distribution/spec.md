# pi-plugin-distribution Specification

## Purpose
TBD - created by archiving change optimize-pi-plugin-npm-parity. Update Purpose after archive.
## Requirements
### Requirement: chorus-pi is a publishable npm package
The `@chorus-aidlc/chorus-pi` package SHALL declare the metadata required to publish to the public npm registry: `publishConfig.access` = `public`, a `files` allowlist that includes exactly the runtime assets (`extensions`, `lib`, `skills`, `agents`, `bin`, `README.md`) and excludes tests and dev-only files, a `repository.directory` of `packages/chorus-pi`, and a `.npmignore` that prevents npm from falling back to `.gitignore`. Because pi loads TypeScript via jiti, the package SHALL be published as TypeScript source with **no** build/`dist` step.

#### Scenario: pack contains only allowlisted runtime assets
- **WHEN** `npm pack` (or `pnpm pack`) is run in `packages/chorus-pi`
- **THEN** the tarball contains the extension, lib, all skills, all reviewer agents, the bin wrapper, and README
- **AND** it contains no `test/`, `node_modules/`, `.env`, or credential-like (`cho_…`) strings

#### Scenario: version tracks the app version
- **WHEN** the package version is read
- **THEN** it equals the root `package.json` version (lockstep), not the drifted `0.17.0`

### Requirement: chorus-pi has package-validation scripts
The package SHALL provide a `check:package` script (a `validate-package.mjs` that asserts package identity, the exact skill set, the reviewer-agent set, and manifest shape) and a `check:pack` script (a pack-into-tmp check asserting required files present and forbidden artifacts absent), modeled on the dsh package's equivalents. `prepublishOnly` SHALL run `check:package`.

#### Scenario: check scripts pass on a correct tree
- **WHEN** `pnpm run check:package` and `pnpm run check:pack` run in `packages/chorus-pi`
- **THEN** both exit 0

#### Scenario: check:package fails on a missing skill
- **WHEN** a skill listed in the expected set is absent
- **THEN** `check:package` exits non-zero and names the missing skill

### Requirement: chorus-pi is a workspace member without breaking the dashboard build
`packages/chorus-pi` SHALL be a pnpm workspace member (the `!packages/chorus-pi` exclusion removed from `pnpm-workspace.yaml`), while the root dashboard `tsc` build SHALL NOT compile the package's TypeScript (the regression #458 that caused the original exclusion).

#### Scenario: root typecheck excludes chorus-pi
- **WHEN** the root `tsc --noEmit` / `pnpm build` runs
- **THEN** it succeeds and does not type-check `packages/chorus-pi/**`

### Requirement: chorus-pi is published in the coordinated release flow
`scripts/coordinated-npm-release/manifest.json` SHALL contain a 4th package entry for `packages/chorus-pi` (`@chorus-aidlc/chorus-pi`) with install/check/package commands, `requiredFiles`, and `forbiddenPatterns`. The hardcoded `expectedPackages` array and its guard message in `lib.mjs` SHALL include the new package in publish order, and the release-contract `__tests__` SHALL be updated so `loadManifest()` does not throw.

#### Scenario: manifest and guard agree
- **WHEN** `loadManifest()` runs against the updated manifest
- **THEN** it returns the 4-package manifest without throwing the "must contain exactly …" error

#### Scenario: release-contract test reflects four packages
- **WHEN** `pnpm test:release-contract` runs
- **THEN** it passes with the four expected `[directory, packageName]` identities in publish order

