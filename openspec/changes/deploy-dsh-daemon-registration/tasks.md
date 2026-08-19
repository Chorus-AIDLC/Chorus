## 1. Prepare the controlled deployment

- [x] 1.1 Inspect the deployment base and exact dsh registration candidate, separating the approved release scope from unrelated shared-worktree changes.
- [x] 1.2 Run the focused daemon connection registration tests, verify all existing client types remain accepted, and confirm no dsh-specific schema migration is required.
- [ ] 1.3 Present the exact commit/release/deployment candidate and rollback revision for explicit human authorization.

## 2. Deploy and verify registration

- [ ] 2.1 After authorization, commit and deploy the approved candidate through the normal controlled deployment path.
- [ ] 2.2 Probe the authenticated SSE boundary with `clientType=dsh`, verify `connection_registered` and the matching `/api/agent-connections` row, and preserve redacted evidence.
- [ ] 2.3 If another server-side registration gate appears, apply only a narrowly scoped correction, rerun focused tests, and repeat the authorization and deployment steps.
- [ ] 2.4 Record the accepted deployed revision and registration evidence, then notify the parent live E2E task that its blocker is cleared.
