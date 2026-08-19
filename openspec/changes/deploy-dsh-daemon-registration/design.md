## Context

The current worktree adds `dsh` to `DAEMON_CLIENT_TYPES` and covers a parsed dsh self-report through the real registration service boundary. The deployed server revision does not contain that allowlist entry: a live authenticated dsh SSE probe receives only the initial comment and creates no daemon connection, while an otherwise identical Codex probe receives `connection_registered`.

`DaemonConnection.clientType` is stored as a string, so the existing dsh-client-type specification correctly requires no persistence migration. The repository is a shared, heavily modified worktree, and project governance requires a human to authorize the commit and deployment rather than allowing a headless worker to release it automatically.

## Goals / Non-Goals

**Goals:**

- Verify the deployment candidate contains the approved dsh registration implementation and focused tests.
- Preserve existing daemon client registration behavior.
- Deploy only after explicit human authorization.
- Prove dsh registration on the current Chorus environment with redacted, auditable evidence.
- Allow a narrow correction if live deployment reveals another server-side registration gate.

**Non-Goals:**

- Complete a daemon wake, dsh model turn, transcript, usage, resume, or interrupt flow.
- Redesign client-type registration or introduce a plugin registry.
- Add a database migration or alter stored connection records.
- Commit unrelated shared-worktree changes or bypass normal release governance.

## Decisions

### Treat the integrated implementation as the deployment candidate

The developer first inspects the exact candidate diff and runs focused daemon connection tests. Reimplementing the allowlist change is unnecessary unless the candidate is absent or a post-deploy probe identifies a second server-side gate.

### Keep commit and deployment as an explicit human gate

The task prepares the candidate, test evidence, deployment steps, and rollback point, then requests approval before any commit, release, or live deployment. Approval for the proposal does not itself authorize an unattended deployment.

### Verify the narrow live boundary

After deployment, use an authenticated dsh SSE connection with a dedicated non-secret host/cwd identity. Acceptance requires a `connection_registered` event with a UUID and a matching dsh entry from `/api/agent-connections`. The probe output must redact API keys and authorization material.

The parent idea owns complete daemon wake/turn acceptance. Keeping this task at the registration boundary avoids duplicating or prematurely claiming that broader result.

### Avoid persistence work

No migration is run solely for dsh client-type support because the field is already a free string. Normal deployment migration checks may confirm compatibility, but they must not introduce a dsh-specific schema change.

## Risks / Trade-offs

- [The shared changeset contains unrelated work] -> Inspect and stage only the approved release scope; present the exact candidate to the human gate before committing.
- [The deployment changes behavior for existing clients] -> Run focused registration tests for the complete allowlist before deployment and retain the prior revision as the rollback target.
- [The first live probe finds another gate] -> Apply only the smallest server-side correction needed for registration, rerun focused tests, and repeat the human deployment gate.
- [Evidence leaks credentials] -> Record only redacted commands, revision identifiers, connection UUIDs, client type, host/cwd categories, and response status.

## Migration Plan

1. Identify the deployment base and review the dsh registration diff against it.
2. Run focused daemon connection service tests and confirm no dsh-specific migration exists or is needed.
3. Present the exact commit/release/deployment candidate and rollback revision for human approval.
4. After approval, commit and deploy through the project's normal controlled path.
5. Run the dsh SSE registration probe and query `/api/agent-connections`.
6. If registration fails, collect redacted diagnostics, make only a narrowly scoped correction, and return to steps 2-5.
7. Record the successful revision and evidence, then unblock the parent live E2E task.

Rollback redeploys the prior known revision. No database rollback is required.

## Open Questions

None. The deployment approval is intentionally deferred to task execution.
