# B2 local Workspace detail editor regression

Task: `5c3909a6-4d59-4cc0-8562-52a8e8c64367`
Proposal: `6ea93f41-96bc-474b-94d1-8c9a87b6ff71`
Review origin: Leo idea comment `e6b3bbe2-3a72-45c2-a415-25d6a63ba9f6` on idea `d5b5849c-c806-4f35-aacb-5346bd78e4ce`.

## Reproduction and fix

The existing detail editor submitted `name`, `emailDomains`, `oidcIssuer`, `oidcClientId`, and `oidcEnabled` unconditionally. Local workspace rename therefore reached the unchanged service guard and returned HTTP 400, including when OIDC/domain fields were empty/null/false.

Before changing the page, the new detail regression suite returned **2 failed / 4 passed**: local rendering exposed inapplicable controls, and an actual form save returned **400 instead of 200**. OIDC editing and malicious conversion rejection already passed. The initial async-param harness warning was corrected before the recorded stable reproduction.

The fix adds the already-returned `localAuthEnabled` flag to the page-local detail type, hides local domain/OIDC configuration, and sends only `{name}` for local editing. Existing non-local payload and controls are retained. Production API and company service code, including mode-conversion protection, were not changed.

## Executed evidence

```sh
npx vitest run 'src/app/admin/companies/[uuid]/__tests__/page.test.tsx'
# Before fix: 2 failed / 4 passed.

npx vitest run 'src/app/admin/companies/[uuid]/__tests__/page.test.tsx' \
  src/services/__tests__/company.service.test.ts \
  src/app/admin/companies/new/__tests__/page.test.tsx \
  src/app/api/__tests__/local-users-routes.test.ts
# After fix, repeated: 4 files / 87 tests passed.

npx tsc --noEmit
# Task-owned test typing corrected. Remaining errors are in concurrent SSE work:
# src/lib/sse-auth.ts(41,22): TS2339 AuthContext.permissions
# src/lib/sse-auth.ts(41,40): TS7006 implicit-any permission
# src/lib/sse-auth.ts(41,64): TS2339 AuthContext.permissions
```

The detail suite mounts the production React page and forwards its fetch calls to the production GET/PATCH handlers, parser, error handler and real company service. Only authentication (a Superadmin fixture) and Prisma persistence (in-memory fixture) are mocked. It verifies local name-only save and refreshed detail, full existing OIDC update with normalized domains, injected local mode flag rejection, malicious OIDC conversion rejection, and rejection of the exact pre-fix payload. Service regressions separately cover each empty OIDC/domain field and name-only local save.

This is an executed UI/API/service integration regression, **not** a live HTTP/browser/database or external-IdP verification. No real data or environment was accessed or changed. No commit/push/merge was performed. Shared previous changes were retained. No auth-throttle/SSE/central documentation/types/messages were edited.

Independent review/admin verification belong to the parent orchestrator. Global typecheck cannot be reported as passing until its concurrent SSE errors are resolved.
