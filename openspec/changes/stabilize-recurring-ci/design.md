## Context

The user authorized recurring-failure repair, a standalone branch/commit/push/PR to develop and repeated targeted tests plus complete CI. YOLO authorizes lifecycle gates, not merge or deployment. The working tree contains an unpublished install-local.test.ts patch from the earlier CI investigation; it must be inspected and reused, not overwritten blindly.

## Decisions

1. Prefer the smallest compatible Vite security update, checking the advisory and registry during implementation. Keep the high/critical audit unchanged; do not exempt the advisory or relax assertions.
2. Treat password prompt output as insufficient proof that Bash has entered read. Review the existing Linux procfs stdin-read handshake and signal-specific exit-code assertions. Retain bounded deadlines and explicit unsupported-environment failures. Non-Linux behavior stays covered by the existing macOS job; do not claim a portable handshake without evidence.
3. Separate dependency repair and installer stabilization into disjoint tasks. A dependent delivery task integrates them, verifies remote checks and records exact SHA/run associations. Independent code review runs before final delivery completion.
4. Start from current origin/develop, keep unrelated work out of the commit, and preserve the original patch until integrated. No broad dependency refresh or application feature work.

## Validation

- Run audit-root unit tests and actual audit, frozen installation, Prisma generation and typecheck.
- Run the full installer suite and at least 30 repeated executions of its signal-interruption cases, recording actual counts. Preserve EOF and secret-redaction tests.
- Execute full coverage and supporting workflow checks remotely; local full coverage is also desirable when an isolated Research database is available, never point tests at a normal application database.
- Require all applicable PR checks, including macOS installer compatibility when triggered, on the final submitted code commit. Diagnose any newly uncovered failure within the authorized CI scope; escalate unrelated product decisions instead of bypassing checks.

## Risks and Rollback

New dependency advisories may appear during work; report them truthfully. Procfs access/architecture assumptions must be explicit. A fixed number of green repetitions is evidence, not a guarantee of no flakiness. Restore dependency pins/lockfile and the focused test diff to roll back; do not change deployment or secrets.

## Completion

Verify implementation tasks after independent review, then deliver the authorized PR without merging. Once delivery is verified, archive OpenSpec, mirror cumulative spec bytes back to Chorus, and record a completion report. If archival adds a docs-only commit to the PR, await its applicable CI checks too.
