## Why
Chorus currently offers OIDC identities and a deployment-level development password fallback, not workspace-isolated password accounts. The human's two elaboration rounds request local workspace user administration and a unified username/email entry while retaining existing SSO authorization.

## What Changes
- Superadmin creates an explicitly local-auth workspace with an invited initial Workspace Admin. Existing workspace creation and OIDC configurations remain compatible.
- Local usernames and emails are case-normalized and unique within a workspace, not globally; identities, credentials and administrative privileges remain tenant-bound.
- Administrators invite, list, edit, enable/disable, reset, grant/revoke admin and remove users. Removal is a tombstone retaining historical UUID ownership. Links are single-use and expiring, with secure administrator handoff; no default password provisioning.
- Username/email discovery presents all applicable local and existing OIDC/default/superadmin paths; local candidate selection precedes password authentication. SSO email suffix discovery and IdP authentication remain unchanged.
- User and owned Agent/API Key authentication checks current account state. Local session generations support revocation on reset/state/privilege changes. Existing owner project-access inheritance remains the ceiling; ordinary users retain existing business permissions.
- English/Chinese UI uses semantic theme tokens and shadcn components. Tests cover service/API/UI behavior and real isolated-database/browser integration.

## Non-goals
No custom RBAC, role inheritance, per-object/field permissions, IdP group mapping, SSO user administration, self-registration, self-service forgotten passwords, global multi-workspace account or new Superadmin daily cross-tenant user management. No production data migration, deployment, push or merge in this run. No new public workspace directory. An unknown SSO username can be redirected to enter an email rather than adding a discovery mechanism.

## Capabilities
### New Capabilities
- `workspace-local-users`: tenant-local credentials, invite/reset lifecycle, workspace administration and local login integration.

### Modified Capabilities
None; preserve existing OIDC and project access contracts while extending compatible discovery variants.

## Acceptance Scope
1. Atomic local workspace creation provisions exactly one invited administrator and a usable link.
2. Tenant-local normalization/uniqueness allows identical identities across tenants; validation rejects invalid credentials and identifier ambiguity.
3. Only active human Workspace Admins of local workspaces administer their users; cross-tenant identifiers never authorize management.
4. Complete lifecycle actions preserve history; disabling/removing/demoting the last effective admin is rejected under concurrency.
5. Invite/reset tokens are hashed at rest, bound to account and workspace, expiring and atomically consumed; stale links cannot activate disabled/removed users.
6. Unified discovery/login preserves legacy SSO/default/admin behavior and never treats discovery as authorization.
7. Revoked users/sessions/owned keys cannot authenticate through REST, MCP or browser auth; project access remains owner-scoped.
8. All flows have bilingual, accessible light/dark screens with actionable failures and link handoff.
9. Regression suite, type-check and isolated integration/browser checks pass or limitations are explicitly reported without claiming completion.

## Evidence
- Least privilege, tenant/resource boundaries and per-request authorization: [OWASP Authorization](ref:ffe01da5-c121-4de7-aa8c-f87a115b93b9).
- Safe password storage, generic failures and throttling: [OWASP Authentication](ref:be803269-4814-4d92-bd38-2ee70f7a9784).

## Impact
Prisma schema and additive migration; local account service and API routes; auth/session/API-key validation and discovery; login, credential acceptance, Superadmin creation and workspace settings UI; locale resources and operations documentation. Existing OIDC users/default users are not silently elevated or assigned usable local passwords. Pencil MCP is unavailable, so encrypted `docs/design.pen` remains an explicitly recorded follow-up rather than being edited as text.
