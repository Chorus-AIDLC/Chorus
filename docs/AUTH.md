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
4. Creates two self-signed HS256 JWTs:

| Token | Cookie name | Expiry | Contents |
|---|---|---|---|
| Access token | `user_session` | 1 hour | Full user payload (`userUuid`, `companyUuid`, `email`, `name`, `oidcSub`) |
| Refresh token | `user_refresh` | 7 days | Minimal payload (`userUuid`, `companyUuid`) |

5. Sets both as HTTP-only cookies

**Auto-refresh**: The Edge Middleware (`src/middleware.ts`) detects when `user_session` is within 10 seconds of expiry and uses `user_refresh` to sign a new access token locally (no external calls needed). See [Token Lifecycle](#4-token-lifecycle--auto-refresh) for details.

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

The middleware runs on every request (except static assets, `/login`, `/api/auth/*`) and handles token refresh transparently before requests reach Server Components.

**OIDC users**:
1. Decode `oidc_access_token` cookie, check `exp` claim
2. If > 30 seconds until expiry → pass through
3. If expiring → call external token endpoint with `oidc_refresh_token` + `oidc_client_id`
4. Write new access token to both request and response cookies
5. If refresh fails → clear all cookies, redirect to `/login`

**Default Auth users**:
1. Decode `user_session` cookie, check `exp` claim
2. If > 10 seconds until expiry → pass through
3. If expiring → verify `user_refresh` cookie using `NEXTAUTH_SECRET`
4. Re-sign a new access token with the same payload using `jose` (no external calls)
5. Write new `user_session` to both request and response cookies
6. Log: `[middleware] User session refreshed for <email>`

### Layer 2: Frontend fallback (`src/app/(dashboard)/layout.tsx`)

On initial page load, `checkSession()` calls `GET /api/auth/session`. If it returns 401, it tries `POST /api/auth/refresh` (which verifies `user_refresh` cookie server-side and issues new tokens). This is a safety net for cases where the middleware refresh didn't fire (e.g., the user's first request after a long idle period).

### Layer 3: Client-side OIDC (`src/lib/auth-client.ts`)

For OIDC users, `authFetch()` wraps all API calls. On 401, it attempts `signinSilent()` via `oidc-client-ts` to refresh the token client-side, then retries the request.

### Token expiry summary

| Token | Expiry | Refresh mechanism |
|---|---|---|
| OIDC access token | ~1 hour (provider-dependent) | Middleware (external token endpoint) |
| OIDC refresh token | ~30 days (provider-dependent) | N/A (used to refresh access token) |
| Default Auth access token (`user_session`) | 1 hour | Middleware (local JWT re-sign) |
| Default Auth refresh token (`user_refresh`) | 7 days | N/A (used to refresh access token) |
| Super Admin session (`admin_session`) | 24 hours | `POST /api/auth/refresh` |
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
| `src/lib/user-session.ts` | JWT creation/verification for `user_session`/`user_refresh` tokens, cookie helpers |
| `src/lib/super-admin.ts` | Super Admin email/password verification |
| `src/middleware.ts` | Edge Middleware — auto-refresh for both OIDC and Default Auth tokens |
| `src/app/api/auth/default-login/route.ts` | Default Auth login endpoint |
| `src/app/api/auth/callback/route.ts` | OIDC callback — sets cookies after provider redirect |
| `src/app/api/auth/identify/route.ts` | Email identification — routes to OIDC or Default Auth |
| `src/app/api/auth/refresh/route.ts` | Token refresh endpoint (server-side, for `user_refresh` cookie) |
| `src/app/api/auth/session/route.ts` | Session check endpoint |
| `src/app/api/admin/login/route.ts` | Super Admin login endpoint |
| `src/app/login/page.tsx` | Login page UI (email input, password form, OIDC redirect) |
| `src/app/login/callback/page.tsx` | OIDC callback page (code exchange) |
| `src/app/(dashboard)/layout.tsx` | Dashboard layout — session check + refresh on mount |
