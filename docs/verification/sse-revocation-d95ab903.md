# SSE live-auth revocation evidence — d95ab903

Date: 2026-10-15
Task: `d95ab903-a179-499f-9d31-80a0fb3e19de`
Project: `f176e636-b78c-4914-9da6-27a76ff7372c`
Proposal: `6ea93f41-96bc-474b-94d1-8c9a87b6ff71`
Review basis: Leo Round 1 idea comment `e6b3bbe2-3a72-45c2-a415-25d6a63ba9f6` on idea `d5b5849c-c806-4f35-aacb-5346bd78e4ce`.

## Reproduction before implementation

```sh
pnpm exec vitest run src/app/api/events/__tests__/route.project-access.test.ts src/app/api/events/notifications/__tests__/route.test.ts -t 'already-open'
```

Result: **4 failures**, human and owned-agent on both routes. Fresh GET returned 401 after auth rejection, but old events streams delivered task changes, presence, and unscoped browser notifications. Old notification streams delivered both project-scoped and unscoped confidential messages. The assertions expected no protected deliveries.

## Implementation

- `src/lib/sse-auth.ts`: shared final-delivery gate resolves original request credentials through real `getAuthContext` on every message/heartbeat. That path queries authoritative account state/session generation and API-key owner state; no connection-lifetime auth cache or process-local invalidation event is required. Auth failure/DB error, changed identity/tenant, changed owner, or reduced agent permission ceiling closes the connection.
- Deliveries use one serial queue. Project/turn/snapshot work occurs upstream; fresh authentication occurs immediately before synchronous `controller.enqueue`, with no intervening await. Queued deliveries do not reuse an earlier successful auth result. Relevant project/group revision predicates are also checked after asynchronous auth.
- Both routes gate every data path, registration/conflict handshake, and heartbeat. Invalidated daemon connections are not heartbeat-touched. Cleanup is idempotent across revocation, client abort, and reader cancellation; it removes subscriptions/timer, closes the controller, marks the connection offline, and retains existing execution/orphan-turn reconciliation.
- Existing valid SSO sessions, unowned agents, wake-recovery/liveness protocols, and eligible owned-agent keys after password-only reset remain supported. Human reset/session generation changes invalidate original credentials; password-only reset does not destroy otherwise eligible owner API keys.

## Final verification

```sh
pnpm exec vitest run src/app/api/events src/lib/__tests__/user-session.test.ts src/lib/__tests__/api-key.test.ts src/lib/__tests__/oidc-auth.test.ts src/lib/__tests__/auth.test.ts src/lib/__tests__/workspace-local-auth.test.ts
pnpm exec tsc --noEmit --incremental false
pnpm exec eslint src/lib/sse-auth.ts src/app/api/events/route.ts src/app/api/events/notifications/route.ts src/app/api/events/__tests__/route.auth-revocation.test.ts src/app/api/events/__tests__/route.project-access.test.ts src/app/api/events/notifications/__tests__/route.test.ts
git diff --check -- src/app/api/events src/lib/sse-auth.ts
```

- **9 test files / 329 tests passed**; final rerun completed at local 18:28 on 2026-10-15.
- **Typecheck passed**, exit 0.
- Scoped implementation ESLint passed with zero errors. Three test-file ignored-pattern warnings reflect the repository's existing ESLint test exclusions; not a claim that ESLint linted tests.
- Scoped diff whitespace check passed.
- New real-auth SSE matrix: **52 tests**, using production routes, `getAuthContext`, JWT signing/verification, API-key validation, and account-state helper with in-memory Prisma persistence only. Coverage includes cookie/Bearer disable/delete/missing/reset/generation; owned-owner disable/delete/missing; revoked/expired keys and changed owner; every protected channel; quiet heartbeat invalidation; DB failure; reader cancellation; invalidation between queued deliveries; abort during auth; pending project authorization; snapshot replay/buffer invalidation; valid SSO/unowned behavior; owner password-only reset compatibility.
- Existing mocked-auth route regressions add four explicit pre-fix reproductions, now passing. The multi-principal fixture now associates each request with its own identity to faithfully support live revalidation.

## Combined-suite integration

The first parent full-suite run found four failures in the older `daemon-turn-project-access.test.ts` fixture, plus one bcrypt login timeout in another file. Its mocked valid Agent lacked the required `permissions` array, so the new gate correctly failed closed; a deferred one-shot grant mock then remained unconsumed and contaminated later cases. The fixture now provides `permissions: []`, without weakening production checks or access assertions. The focused repair run (daemon-turn project access + local-auth) passed **54 tests across 2 files**. A final combined full-suite rerun is tracked in the central verification record.

## Boundary and handoff

No real database/server/browser verification is claimed in this task. Tests stub only in-memory persistence and daemon/project dependencies; environment overrides are test-local and restored. No real env/data changes, commits, pushes, merges, existing task reopenings, or central-report edits were made. Prior uncommitted shared-tree work was retained. Independent task review and admin verification belong to the parent orchestrator after submission; this evidence is a developer self-check, not an independent VERDICT.
