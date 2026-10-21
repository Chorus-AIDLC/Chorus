# Tasks

Chorus task drafts are authoritative for execution status; this checklist describes one atomic implementation task.

## 1. Fix submit-attempt invalidation with regression coverage

- [x] 1.1 Add deterministic missing-receipt task/proposal delayed-read regressions and record failures against the existing implementation using `bun test packages/chorus-pi/test/submit-gate.test.ts`.
- [x] 1.2 Restructure both submit branches to calculate the verdict before unconditional scoped/global invalidation, preserving existing task-without-UUID behavior and diagnostics; verify the focused suite passes.
- [x] 1.3 Cover stale/unacceptable receipts, UUID-less proposal invalidation, unrelated-object isolation, conservative block behavior, and fresh-read one-shot recovery in the same test file; verify with the focused suite and review against the delta spec.
- [x] 1.4 Run `bun test packages/chorus-pi/test`, `(cd packages/chorus-pi && bash test/all.sh)`, and `node packages/chorus-pi/scripts/validate-package.mjs`, report offline evidence and any unrelated failures, and confirm the unrelated SIGINT test modification is untouched.
