# Deleted local identity reuse — 2026-10-15

- Idea: `d5b5849c-c806-4f35-aacb-5346bd78e4ce`
- Follow-up task: `9e74e5d3-bba7-42ee-b722-a2e14badd41d`
- Human decision: comment `b5c1fe13-2895-495d-bf61-9bb65e4bee3a`: deleted identifiers may be reused, with a new UUID and no inheritance.
- Branch: `feat/workspace-local-users`; no commit, push, PR, merge or deployment.

## Implementation boundary

Removal nulls `username` and `localEmail` in the existing locked lifecycle transaction, alongside tombstoning and credential revocation. The nullable, tenant-local unique indexes already support this; no schema/migration change is needed. The original UUID, OIDC subject, display email and historical references remain. Public deletion DTOs keep string fields: empty username and preserved display email. Creation still inserts a new invited account with an independent UUID/subject, new link and explicit administrative flag (default false); no lookup-by-email recovery or ownership transfer is added.

Current EN/ZH operations guidance and the cumulative OpenSpec were updated. The archived original design remains an historical snapshot, superseded for this policy by the human decision and current spec. Spec Document `3b298ce3-2bb3-4262-8d6f-02187e9af069` updated through CLI `--arg-file content=openspec/specs/workspace-local-users/spec.md`; round-trip content equals local bytes, version 4.

## Executed evidence

### Red / green regression

```sh
node node_modules/vitest/vitest.mjs run src/services/__tests__/local-user-recreation.test.ts --maxWorkers=2 --no-cache
```

Before production patch: exit 1, **4 failed / 5 passed**. Failures show retained identifiers and 409 on reuse, including the replacement activation path. Log: `/tmp/chorus-identity-reuse-red.log`.

After patch and final test typing correction:

```sh
node node_modules/vitest/vitest.mjs run src/services/__tests__/local-user-recreation.test.ts src/services/__tests__/local-user.service.test.ts src/lib/__tests__/workspace-local-auth.test.ts src/lib/__tests__/user-session.test.ts src/lib/__tests__/api-key.test.ts src/app/api/__tests__/local-users-routes.test.ts src/app/api/events --maxWorkers=2 --no-cache
node node_modules/typescript/bin/tsc --noEmit --incremental false
node --check scripts/verify-local-users.mjs
git diff --check
```

Final scoped regression: exit 0, **10 files / 397 tests passed**, 14.89s. Log: `/tmp/chorus-identity-reuse-green-final.log`. Final types, script syntax and whitespace: exit 0. The first type check failed on the test's inferred optional header fields; explicitly typed string headers fixed it, and the check was rerun successfully. Do not describe that initial check as passing.

The new stateful persistence double enforces actual inserted/stored identifiers and drives reads from service writes. It covers duplicate active/invited/disabled identities, reuse of either identifier, late token/audit failure rollback, old link rejection, and actual JWT/API-key resolution after a fresh invitation activates. It does not emulate PostgreSQL locks or assert mock storage is a live database.

### Fresh isolated HTTP / database acceptance

A new PGlite database was created at `/tmp/chorus-identity-reuse-stack-ZUTUAX/db`, listening only on test port 5435, with migrations applied. Next development server used loopback port 8640 and explicitly supplied isolated database, Superadmin configuration, application origin and session secret. No live `.env` or `.pglite` was modified. Both temporary server processes were terminated by the stack's exit trap; fixtures remain in the disposable directory.

Executed the extended `scripts/verify-local-users.mjs` with its isolation gate: **exit 0, 64 checks passed**. Log: `/tmp/chorus-identity-reuse-live.log`; migration/app/database logs have the same `chorus-identity-reuse-*` prefix.

Actual HTTP responses and SQL persistence confirm:
- Same normalized username/email can be reinvited after removal, with a different UUID and no administrator privilege.
- New invitation acceptance and login succeed; old cookie, invitation/reset links and old owned key remain denied (REST/MCP) after activation.
- A private project, private group, membership rows and historical Idea were seeded for the old identity before removal. The replacement has no old membership and cannot read the private project (404).
- Historical Idea creator/assignee and Agent owner remain the deleted UUID; both project/group membership rows remain only on that UUID.
- Existing last-admin, tenant, reset, invitation, disable/enable, normalized uniqueness and audit assertions pass in the same run.

## Scope and limitations

No SSE code or policy changed. Existing SSE route regressions are included in the 397-test run, but this live script does not establish/revoke SSE streams. A fresh complete regression run (`node node_modules/vitest/vitest.mjs run --maxWorkers=4`) completed with exit 0: **476 files passed / 11 skipped; 11,163 tests passed / 245 skipped**, 222.45s. Log: `/tmp/chorus-identity-reuse-full.log`. Scoped ESLint completed with zero errors; two verifier console warnings and one ignored-test warning remain (the test file was not linted). No post-patch browser acceptance, production build or multi-connection PostgreSQL contention run is claimed for this follow-up. Prior build/browser evidence belongs to its recorded earlier revision. PGlite single-connection concurrency is not PostgreSQL multi-connection lock evidence.

Independent review and final task verification are recorded in the follow-up Task comments; this document contains the developer's executed evidence, not an invented reviewer verdict.
