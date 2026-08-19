## Why

Live acceptance against the current Chorus environment proved that `clientType=dsh` is still rejected at the SSE registration boundary even though the integrated worktree already contains the approved server allowlist and focused tests. The existing implementation must be delivered through the human-controlled deployment path and proven live before the parent dsh end-to-end acceptance can continue.

## What Changes

- Confirm the deployment candidate contains the existing `dsh` server registration change and its focused regression coverage.
- Obtain explicit human approval before committing, releasing, or deploying the shared dsh changeset.
- Deploy the approved candidate to the current Chorus environment without a client-type schema migration.
- Re-probe the authenticated SSE boundary with `clientType=dsh` and verify both `connection_registered` and the corresponding `/api/agent-connections` row.
- Permit only narrowly scoped server-side remediation if the first post-deploy probe exposes another registration gate.
- Record redacted deployment and probe evidence, then return full wake/turn acceptance to the parent idea.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `dsh-client-type`: Require the approved dsh registration behavior to be available and directly verifiable in the target Chorus deployment.

## Impact

The primary implementation already exists in `src/services/daemon-connection.service.ts` and its focused service tests. This change affects release/deployment state and live acceptance evidence; it adds no endpoint, dependency, database schema, or migration. Commit and deployment actions remain human-gated.
