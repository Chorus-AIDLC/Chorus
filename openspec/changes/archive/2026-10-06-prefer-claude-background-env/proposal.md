# Prefer daemon environment protection over global agent waiting rules

## Why

The owner revised PR #602's scope in Idea comment `7c3eb0e4-1338-4552-ab7e-1059583e3b18` (2026-10-06 02:09:36Z). The injected Claude background wait ceiling should provide the primary protection without imposing foreground waits on interactive sessions or spending main-agent tokens solely to keep a turn open. Standalone public skills are unnecessary for this change.

## What Changes

- Supersede the original B requirement: remove this feature's global background-child ownership mandate from the daemon prompt and Claude/standalone workflow skills.
- Restore the associated plugin manifests, registry and skill versions, since no plugin package changes remain.
- Preserve A (native-first environment configuration) and C (termination detection, abnormal wake reporting and entity comment) unchanged.
- Retain all pre-existing review gates, human handoff behavior and cancellation semantics.
- Record Clay's completed 60-minute real-Claude expiry test without misrepresenting it as the full daemon-to-comment E2E path.

## Capabilities

### New Capabilities
None.

### Modified Capabilities
- `daemon-claude-background-agents`: replace the global background-ownership guidance requirement with environment-first protection that does not introduce a foreground wait mandate.

## Impact

PR #602 only: prompt/skill reversions, one regression test, and a spec amendment. The earlier archived change remains an accurate historical record of the original A+B+C approval; this later change supersedes B. No dependency remediation, backend expansion, merge, reinstall or daemon restart is authorized by this amendment.
