# Authentication Architecture

Chorus supports four authentication methods, all converging into a single unified `AuthContext` through the `getAuthContext()` function in `src/lib/auth.ts`. This document explains each method, how they are resolved, and how token lifecycle is managed.

---

## Table of Contents

1. [Unified AuthContext](#1-unified-authcontext)
2. [Authentication Methods](#2-authentication-methods)
   - [2.1 API Key (Agent)](#21-api-key-agent)
   - [2.2 OIDC (User)](#22-oidc-user)
   - [2.3 Default Auth (User)](#23-default-auth-user)
   - [2.4 Super Admin](#24-super-admin)
3. [Resolution Cascade](#3-resolution-cascade)
4. [Token Lifecycle & Auto-Refresh](#4-token-lifecycle--auto-refresh)
5. [Multi-Tenancy](#5-multi-tenancy)
6. [Security Patterns](#6-security-patterns)
7. [Key Files](#7-key-files)

---

## 1. Unified AuthContext

All four authentication methods produce one of three context types, defined in `src/types/auth.ts`:

```
AuthContext = UserAuthContext | AgentAuthContext | SuperAdminAuthContext
```

| Context Type | `type` field | Key fields | Produced by |
|---|---|---|---|
| `UserAuthContext` | `"user"` | `companyUuid`, `actorUuid`, `email`, `name` | OIDC, Default Auth |
| `AgentAuthContext` | `"agent"` | `companyUuid`, `actorUuid`, `roles[]` (preset selector), `permissions[]` (effective 15-bit set), `agentName`, `ownerUuid` | API Key |
| `SuperAdminAuthContext` | `"super_admin"` | `email` (no companyUuid) | Super Admin cookie |

Downstream code uses type guards to branch on context type:

```typescript
import { isAgent, isUser, hasPermission, requireAgentPermission } from "@/lib/auth";

if (isAgent(auth)) {
  // auth.roles (preset selector), auth.permissions (effective set), auth.agentName available
}
if (isUser(auth)) {
  // auth.email, auth.name available
}
if (isAgent(auth) && hasPermission(auth, "proposal:admin")) {
  // Permission-specific logic (preferred over role checks)
}

// For REST route handlers, gate with requireAgentPermission:
export const POST = requireAgentPermission("task:admin", async (req, ctx, auth) => {
  /* ... */
});
```

The legacy `hasRole(auth, "pm")` helper still exists for back-compat, but new code should gate on `hasPermission` / `requireAgentPermission` — roles are only preset selectors, not the authorization source of truth.

---

## 2. Authentication Methods

### 2.1 API Key (Agent)

**Purpose**: AI Agents accessing the MCP endpoint or REST APIs.

**Key files**: `src/lib/api-key.ts`

**How it works**:

1. Agent sends `Authorization: Bearer cho_<random64bytes>`
2. `getAuthContext()` detects the `cho_` prefix
3. `validateApiKey(token)` hashes the token with SHA-256 and looks up `prisma.apiKey` by `keyHash`
4. Checks: not revoked, not expired
5. Returns `AgentAuthContext` with the agent's `roles` (preset selector), `permissions` (effective 15-bit set — preset expansion ∪ custom), `companyUuid`, `actorUuid`

**Key generation**: `generateApiKey()` creates `cho_<32-byte-random-base64url>`. The raw key is shown once at creation time; only the SHA-256 hash is stored in the database.

**Security**: Comparison uses `crypto.timingSafeEqual()` to prevent timing attacks.

**Agent permissions** determine which MCP tools are registered. Each Agent carries a **15-bit permission matrix** (5 resources × 3 actions). `roles[]` only selects one of three presets; the real authorization source is the effective `permissions[]` set (preset expansion ∪ custom permissions). See [ARCHITECTURE.md §6.3](./ARCHITECTURE.md#63-permission-model) for the full matrix.

**Role Preset → Expanded Permissions** (see `src/lib/authz/presets.ts`):

| Preset | Expanded Permissions | Representative Tools |
|---|---|---|
| `developer_agent` | `*:read` + `task:write` (6 perms) | Task claim/release, submit for verify, report work, sessions |
| `pm_agent` | `*:read` + `idea:write` + `proposal:write` + `document:write` + `task:write` + `project:write` (10 perms) | Proposal/document/task creation, draft management, assignment |
| `admin_agent` | All 15 perms (`*:read` + `*:write` + `*:admin`) | Approve/reject proposals, verify/reopen/close tasks, delete entities |

Custom agents layer additional permission bits on top of any preset (e.g. a Developer agent with `task:admin` to self-verify, or a read-only auditor with only `*:read`). MCP tool visibility is driven by the effective set; REST routes gate via `requireAgentPermission("resource:action", ...)`.

### 2.2 OIDC (User)

**Purpose**: Enterprise SSO login for human users.

**Key files**: `src/lib/oidc-auth.ts`, `src/lib/oidc.ts`, `src/app/login/page.tsx`, `src/app/login/callback/page.tsx`, `src/middleware.ts`

**Flow**:

1. User enters email on login page
2. `POST /api/auth/identify` checks if the email's company has OIDC configured
3. Frontend redirects to the OIDC provider's `/authorize` endpoint (PKCE, no client secret)
4. Provider redirects back with authorization code
5. Frontend exchanges code for tokens via the provider's token endpoint
6. `POST /api/auth/callback` receives `oidcSub`, `email`, `accessToken`, `refreshToken`
7. Server finds-or-creates user by `(companyUuid, oidcSub)`
8. Sets four HTTP-only cookies:

| Cookie | Purpose | Max-Age |
|---|---|---|
| `oidc_access_token` | Access token for API calls | 1 hour |
| `oidc_refresh_token` | Refresh token for auto-renewal | 30 days |
| `oidc_client_id` | For middleware token refresh | 30 days |
| `oidc_issuer` | For JWKS discovery | 30 days |

**Token verification** (`verifyOidcAccessToken()`):
- Decodes token to extract `iss` claim
- Fetches JWKS from `{issuer}/.well-known/jwks.json` (cached 10 min)
- Verifies JWT signature using `jose` library
- Finds user in DB by `(companyUuid, oidcSub)`

**OIDC configuration** is stored per-company in the database (set by Super Admin):
- `Company.oidcIssuer` — the OIDC provider URL
- `Company.oidcClientId` — the client ID
- `Company.oidcEnabled` — boolean toggle

### 2.3 Default Auth (User)

**Purpose**: Simple email/password login for development and demo deployments without OIDC infrastructure.

**Key files**: `src/lib/default-auth.ts`, `src/lib/user-session.ts`, `src/app/api/auth/default-login/route.ts`

**Environment variables**:

```bash
DEFAULT_USER="dev@chorus.local"
DEFAULT_PASSWORD="chorus123"
```

When both are set, `isDefaultAuthEnabled()` returns true and the login page shows an email/password form.

**Flow**:

1. User enters email + password
2. `POST /api/auth/default-login` verifies email matches `DEFAULT_USER` (case-insensitive) and password matches `DEFAULT_PASSWORD`
3. `findOrCreateDefaultUser()` auto-provisions company (from email domain) and user in the database
4. Creates one self-signed HS256 JWT:

| Token | Cookie name | Expiry | Contents |
|---|---|---|---|
| Session token | `user_session` | 365 days (local-dev longevity) | Full user payload (`userUuid`, `companyUuid`, `email`, `name`, `oidcSub`) |

5. Sets it as an HTTP-only cookie

**No refresh arm**: default auth is a single long-lived JWT. There is no `user_refresh`
token and no middleware refresh branch for it (that machinery existed historically but had
no producer and was deleted in the auth slim-down, idea 3bf0819c). When the token
eventually expires, the session probe's verdict simply routes to re-login.

### 2.4 Super Admin

**Purpose**: Platform-level administration (company management, OIDC configuration, entity management across all tenants).

**Key files**: `src/lib/super-admin.ts`, `src/app/api/admin/login/route.ts`

**Environment variables**:

```bash
SUPER_ADMIN_EMAIL="admin@example.com"
SUPER_ADMIN_PASSWORD_HASH="$2b$10$..."   # bcrypt hash
```

**Flow**:

1. `POST /api/auth/identify` detects the email matches `SUPER_ADMIN_EMAIL`
2. Redirects to `/login/admin?email=...`
3. User enters password
4. `POST /api/admin/login` verifies password using `bcrypt.compare()` against `SUPER_ADMIN_PASSWORD_HASH`
5. Creates an HS256 JWT with `{ type: "super_admin", email }`, 24-hour expiry
6. Sets `admin_session` HTTP-only cookie

**Restrictions**: `SuperAdminAuthContext` has no `companyUuid` — it operates across all tenants. Not subject to multi-tenancy scoping.

---

## 3. Resolution Cascade

`getAuthContext()` in `src/lib/auth.ts` is the single entry point for all authentication. It tries methods in priority order, returning immediately on the first success:

```
Step 1: Authorization header (Bearer token)
  ├─ cho_* prefix   → API Key validation     → AgentAuthContext
  ├─ RS*/ES* JWT    → OIDC token verification → UserAuthContext
  └─ HS256 JWT      → Chorus JWT verification → UserAuthContext

Step 2: Session cookies
  └─ user_session or admin_session → UserAuthContext or SuperAdminAuthContext

Step 3: OIDC cookie (for SSE/EventSource — no Authorization header)
  └─ oidc_access_token cookie → OIDC verification → UserAuthContext

Step 4: return null (unauthenticated)
```

**Token type detection**: `isOidcToken()` distinguishes OIDC JWTs from Chorus self-signed JWTs by checking:
- Not a `cho_` API key
- Valid 3-part JWT structure
- Header algorithm is RS* or ES* (asymmetric = OIDC) vs HS256 (symmetric = Chorus)

---

## 4. Token Lifecycle & Auto-Refresh

Token refresh is handled at two layers:

### Layer 1: Edge Middleware (`src/middleware.ts`)

The middleware runs on every matcher-covered request (everything except static assets, `/login`, `/api/auth/*`) and refreshes OIDC tokens transparently before requests reach Server Components. It is the single renewal authority.

**OIDC users**:
1. Decode `oidc_access_token` cookie, check `exp` claim
2. If > 30 seconds until expiry → pass through
3. If expiring/expired (or the access cookie is gone but a refresh cookie exists) → call the discovered token endpoint with `oidc_refresh_token` + `oidc_client_id`
4. Write the new access token to both request and response cookies
5. **If refresh fails → pass the request through untouched.** The middleware NEVER clears cookies or redirects: a single invocation cannot distinguish a transient failure from a dead refresh token, so session death is decided exclusively by the client probe verdict (see Layer 2). Every attempt emits a structured `oidc_refresh` log line (outcome, path, token fingerprint).

**Default Auth users**: no middleware involvement — the `user_session` JWT is long-lived and self-contained.

### Layer 2: Client probe verdict (`src/contexts/auth-context.tsx`)

AuthProvider's `fetchSession()` probes `GET /api/session`. The probe is middleware-matcher-covered, so an expiring/expired access cookie is refreshed on the probe request itself. The verdict chain: probe → retry once (second refresh chance for transient failures) → on a second 401, attempt localStorage refresh-token recovery via `POST /api/auth/sync-token` (rebuilds the refresh-material cookies after an iOS cookie purge) → final probe → only then redirect to `/login`. The dashboard layout, root page, and login page consume the same contract; AuthProvider is the single session-death authority.

### Layer 3: Recovery endpoint (`/api/auth/sync-token`)

The only client→cookie write path. iOS Safari purges httpOnly cookies from backgrounded tabs while `oidc-client-ts`'s localStorage user survives; the recovery posts the stored (expired access token + live refresh token) pair, the server verifies the access token's **signature** (bounded exp tolerance — it identifies the company, it never authenticates), and rebuilds `oidc_refresh_token`/`oidc_client_id`/`oidc_issuer`. Real authentication still happens at the IdP on the next middleware refresh. `authFetch()` itself is a plain same-origin cookie fetch — no Bearer header, no silent renew, no retries.

### Token expiry summary

| Token | Expiry | Refresh mechanism |
|---|---|---|
| OIDC access token | ~1 hour (provider-dependent) | Middleware (external token endpoint) |
| OIDC refresh token | ~30 days (provider-dependent) | N/A (used to refresh access token; recoverable from localStorage after an iOS cookie purge) |
| Default Auth session (`user_session`) | 365 days | None (single long-lived JWT; expiry → re-login) |
| Super Admin session (`admin_session`) | 24 hours | None (expiry → re-login) |
| API Key | Configurable (or no expiry) | N/A (long-lived) |

---

## 5. Multi-Tenancy

All `AuthContext` types (except `SuperAdminAuthContext`) carry `companyUuid`. Every database query must be scoped:

```typescript
const tasks = await prisma.task.findMany({
  where: {
    companyUuid: auth.companyUuid,  // Always required
    ...otherFilters,
  },
});
```

This ensures data isolation between companies. Super Admin is the only context that can query across company boundaries.

---

## 6. Security Patterns

| Pattern | Implementation | Location |
|---|---|---|
| API Key hashing | SHA-256, only hash stored | `src/lib/api-key.ts` |
| Timing-safe comparison | `crypto.timingSafeEqual()` | `src/lib/api-key.ts` |
| OIDC JWT verification | `jose` library + JWKS (cached 10 min) | `src/lib/oidc-auth.ts` |
| Super Admin password | bcrypt hash in env var | `src/lib/super-admin.ts` |
| HTTP-only cookies | All auth cookies | All auth routes |
| Secure flag | Production only | All auth routes |
| SameSite=Lax | All auth cookies | All auth routes |
| PKCE (OIDC) | No client secret needed | `src/lib/oidc.ts` |

---

## 7. Key Files

| File | Responsibility |
|---|---|
| `src/types/auth.ts` | `AuthContext` union type, `AgentRole`, type definitions |
| `src/lib/auth.ts` | `getAuthContext()` cascade, type guards (`isAgent`, `isUser`, `hasRole`), route decorators (`requireAuth`, `requireUser`, `requireAgentRole`, `requireSuperAdmin`) |
| `src/lib/api-key.ts` | API Key generation, SHA-256 hashing, validation |
| `src/lib/oidc-auth.ts` | OIDC JWT verification via JWKS |
| `src/lib/oidc.ts` | OIDC client configuration, `UserManager` factory |
| `src/lib/auth-client.ts` | Client-side `authFetch()`, OIDC silent renew, token sync |
| `src/lib/default-auth.ts` | `isDefaultAuthEnabled()`, `verifyDefaultPassword()` |
| `src/lib/user-session.ts` | JWT creation/verification for the `user_session` token, cookie helpers |
| `src/lib/super-admin.ts` | Super Admin email/password verification |
| `src/middleware.ts` | Edge Middleware — auto-refresh for both OIDC and Default Auth tokens |
| `src/app/api/auth/default-login/route.ts` | Default Auth login endpoint |
| `src/app/api/auth/callback/route.ts` | OIDC callback — sets cookies after provider redirect |
| `src/app/api/auth/identify/route.ts` | Email identification — routes to OIDC or Default Auth |
| `src/app/api/session/route.ts` | Session probe endpoint (matcher-covered so it refreshes its own cookie) |
| `src/app/api/admin/login/route.ts` | Super Admin login endpoint |
| `src/app/login/page.tsx` | Login page UI (email input, password form, OIDC redirect) |
| `src/app/login/callback/page.tsx` | OIDC callback page (code exchange) |
| `src/app/(dashboard)/layout.tsx` | Dashboard layout — session check + refresh on mount |
