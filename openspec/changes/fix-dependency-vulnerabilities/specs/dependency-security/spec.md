# dependency-security Specification

## ADDED Requirements

### Requirement: Root dependency tree SHALL have no unexempted critical or high vulnerabilities

The root project's resolved dependency tree SHALL contain no critical or high severity advisories reported by `pnpm audit` against the npmjs registry, except advisories with no patched release that are explicitly recorded as exemptions.

#### Scenario: Audit is clean

- **GIVEN** the lockfile after this change
- **WHEN** `pnpm audit --audit-level high` is run for the root project
- **THEN** it MUST exit 0 (exempted advisories excluded)

### Requirement: Dependency fixes SHALL NOT change application behaviour

#### Scenario: Quality gates pass

- **WHEN** `pnpm test`, `npx tsc --noEmit`, `pnpm lint` and `pnpm build` are run
- **THEN** all MUST pass, and a browser smoke test of login, board, proposals and light/dark themes MUST show no regression

### Requirement: CI SHALL block regressions

#### Scenario: New high advisory

- **GIVEN** a PR introducing a dependency with a high/critical advisory
- **WHEN** the CI audit step runs
- **THEN** the job MUST fail
