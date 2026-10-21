## Why

Recent Test & Coverage runs fail repeatedly: Vite 8.3.2 is blocked by the existing high/critical audit, and historical installer PTY signal tests time out. Existing installer fixes were validated locally but never published. A green local test alone is not remote CI recovery.

## What Changes

- Update Vite to a compatible patched release and regenerate the pnpm lockfile without bypassing the audit.
- Review and reuse the existing installer signal-read synchronization patch; preserve exit-code, terminal echo, no-secret-output and no-side-effect assertions.
- Repeat targeted signal tests and run the complete CI on an isolated fix PR targeting develop.
- Record exact commits, run links, known limits and independent review evidence. Do not merge or deploy.

## Capabilities

### New Capabilities
- `ci-failure-recovery`: reproducible dependency-audit and installer-interruption regression recovery.

### Modified Capabilities
None.

## Impact

Root package.json and pnpm-lock.yaml; src/lib/__tests__/install-local.test.ts and focused supporting tests only if required. Workflow changes require a demonstrated failure and must not weaken quality gates. Existing unrelated changes remain untouched.

## Acceptance

Root high/critical audit passes without new exemptions; frozen installation and typecheck pass; installer regressions and at least 30 repeated signal-test rounds pass on Linux; all applicable checks on the PR's final code commit pass. Non-Linux behavior is reported separately using the existing macOS workflow. Missing or failed checks are not counted as success.

## Evidence

Reuse Idea references 9cbe66a1-2d3d-4a9b-bfcd-897ce573b510 and 467ccbd8-a6f0-4638-84da-108477832769 for Vite audit failures; 05f8d9a4-064f-4f4e-a351-62d4a5286e89 and completed task 6118e6c9-ba5a-4afb-a923-82407457e1c8 for the historical PTY issue. No new research pass is needed before implementation.
