# Design: single server-side OIDC refresh authority

## Context

Two refresh mechanisms share one rotating OIDC refresh token across two stores that never
sync (browser `localStorage` via `oidc-client-ts`; HTTP-only cookie via Edge middleware).
Under refresh-token rotation this races to `invalid_grant`, and a frontend "expired ⇒
logout" trigger then redirects to `/login` even when the cookie session is still valid. The
fix collapses refresh ownership to one authority — the Edge middleware (cookie) — which is
already IdP-agnostic.

### Verified facts the design relies on

- `getAuthContext` (`src/lib/auth.ts:26-83`) tries Bearer header, then `user_session`
  cookie, then `oidc_access_token` cookie. A stale Bearer token (expired) does **not**
  short-circuit: `verifyOidcAccessToken` returns null and control falls through to the
  cookie. ⇒ A request authenticates from the middleware-refreshed cookie even when the
  `localStorage` Bearer token is stale.
- Middleware OIDC refresh (`src/middleware.ts:203-296`) is standard OIDC: discovery for
  `token_endpoint`, then `grant_type=refresh_token`. No Cognito-specific logic. It writes
  the new access token to both the request cookie (for downstream RSC) and the response
  cookie (for the browser), and rotates the refresh-token cookie when the IdP returns a new
  one.
- The middleware `matcher` (`src/middleware.ts:298-303`) covers all paths except
  `_next`, `login`, `api/auth`, `skill`, `favicon.ico`, and files with an extension.
- default-auth uses a parallel branch in the same middleware (`handleUserSessionRefresh`,
  `src/middleware.ts:82-154`) — short-lived `user_session` + long-lived `user_refresh`,
  both self-signed with `NEXTAUTH_SECRET`, re-signed entirely in Edge. It shares the
  frontend redirect logic (`auth-context`). This is why default-auth is a faithful local
  e2e proxy for the SSO "don't kick early, kick only on true death" contract.

## Goals / Non-Goals

**Goals**
- Exactly one consumer of the OIDC refresh token (the middleware/cookie).
- An expired access token never, by itself, logs the user out.
- Redirect to `/login` only on a true 401 after middleware had its refresh chance.
- Keep everything IdP-agnostic (standard OIDC discovery + refresh grant only).
- Refresh-token cookie lifetime tracks the IdP's stated lifetime.

**Non-Goals**
- No change to MCP/API-Key (`cho_`) auth, SuperAdmin, or default-auth business semantics.
- No change to `getAuthContext` precedence.
- No binding to any specific IdP; no real-IdP dependency in tests.
- No auth-module refactor beyond the refresh/redirect surface.

## Decisions

### D1 — Edge middleware (cookie) is the single OIDC refresh authority

Disable `automaticSilentRenew` in `createOidcSettings` (`src/lib/oidc.ts`). `oidc-client-ts`
keeps doing the initial authorization-code exchange and stores the user, but no longer runs
a background renewal that consumes the refresh token. The silent-refresh iframe page
(`src/app/login/silent-refresh/page.tsx`) and `silent_redirect_uri` become unused for the
renewal path; leave the route in place (harmless) but it is no longer driven.

Rejected alternatives: (b) make the frontend the single authority and stop middleware from
touching OIDC — rejected because Chorus is RSC-heavy and RSC requests can't read
`localStorage`, so server rendering would lose auth; (c) keep both with a distributed lock —
rejected, there is no shared lock across Edge and browser.

### D2 — Remove the unconditional "expired ⇒ logout" trigger; redirect only on true 401

In `src/contexts/auth-context.tsx`, remove the `addAccessTokenExpired` and
`addSilentRenewError` handlers that call `handleSessionExpired()`. Session death is decided
**only** by the backend: when `authFetch("/api/auth/session")` (or any gated request) returns
401 **after** passing through middleware, the app treats the session as dead and redirects.
Because middleware refreshes the cookie before the request reaches the route, a 401 here
means the refresh token itself is gone/expired/revoked — a genuine re-login condition.

`addUserLoaded` may stay only if it still fires for the initial login (it syncs the token to
the cookie). Since silent renewal is off, in practice the callback path is the login
callback (`src/app/login/callback/page.tsx`) which already posts the token to
`/api/auth/callback`. Keep `handleUserLoaded`'s cookie sync as a harmless redundancy or
remove it — implementer's call, but it must not reintroduce a refresh-token consumer.

### D3 — Remove BOTH frontend `signinSilent` consumers, rely on cookie

`src/lib/auth-client.ts` has **two** independent frontend refresh-token consumers, both of
which must go (the proposal-reviewer caught that the first draft only addressed the second):

1. **Pre-request renewal in `getAccessToken()` (lines 50-72).** On `user.expired` it calls
   `manager.signinSilent()` to get a fresh access token, and `authFetch` calls
   `getAccessToken()` at the top of **every** request (line 100). This runs regardless of
   `automaticSilentRenew` and is a second racer for the rotating refresh token. Change
   `getAccessToken()` so that when the user is expired it does **not** call `signinSilent`:
   return the (expired) access token (or no Bearer header) and let the request proceed — the
   middleware refreshes the cookie and `getAuthContext` falls through to it. The frontend must
   never consume the refresh token to renew.
2. **401-branch retry in `authFetch` (lines 113-127).** The OIDC branch
   (`getUserManager()` present) does `manager.signinSilent()` and retries. Remove this
   retry; surface the 401 to the caller, which routes to the single redirect site.

The default-auth branch (cookie `/api/auth/refresh` on 401) is unchanged. Net effect: zero
frontend `signinSilent` calls on the request path; the refresh token has exactly one
consumer (the middleware).

### D4 — Optional keepalive (defense-in-depth, minimal)

When an OIDC session exists, schedule a lightweight client timer that, shortly before access
expiry, issues a request to a middleware-covered path (e.g. a tiny GET that the matcher
covers and that returns quickly) so middleware refreshes the cookie even if the user is idle
on one SPA page without navigating. Constraints:
- Only armed when there is an OIDC session (no effect for default-auth/superadmin, though it
  is harmless if it also fires there).
- Must hit a path **inside** the middleware matcher (NOT under `api/auth`, which is excluded).
- Interval derived from the access-token `exp` (refresh slightly before expiry), not a fixed
  constant.
This is explicitly a defense layer: the correctness of the fix does not depend on it (the
fall-through rescues the first post-idle request). Keep it small; if it risks scope creep,
it can ship as its own task gated behind the core fix.

### D5 — Refresh-token cookie lifetime: centralized default everywhere; `refresh_expires_in` only where observable

The `oidc_refresh_token` cookie is written at three sites, and only one of them actually sees
an IdP token response (the reviewer correctly flagged that the other two cannot):

- `src/middleware.ts` rotation branch (~L288) — **this is the only site that calls the IdP
  token endpoint** (`grant_type=refresh_token`) and thus can read `refresh_expires_in` from
  `tokenData`. Here, derive the cookie maxAge from `refresh_expires_in` when present, else the
  centralized default.
- `src/app/api/auth/callback/route.ts` (~L67) and `src/app/api/auth/sync-token/route.ts`
  (~L36) — both write the cookie from a **client-supplied** `refreshToken` in the request
  body; neither calls the token endpoint, so `refresh_expires_in` is **not available** here.
  These use the centralized default constant.

The unifying rule: **no inline `30 * 24 * 3600` literal at any site** — all three source a
single documented default constant (one definition, commented with rationale). The middleware
site additionally upgrades to `refresh_expires_in` when the IdP provides it. This is the
honest, attainable version of "lifetime tracks the IdP": track it where it is observable,
default consistently where it is not.

(If, in future, we want the body-driven sites to also honor `refresh_expires_in`, that
requires new client→server plumbing to forward the value — explicitly out of scope here.)

## Risks / Trade-offs

- **RSC soft navigation may not always hit middleware.** Mitigated by D4 keepalive and by
  the fact that any data-fetching request (route handlers, server actions, full navigations)
  does pass the matcher. Verify matcher coverage during implementation; if a common
  navigation path bypasses middleware, the keepalive (D4) covers it.
- **Disabling `automaticSilentRenew` removes the "expiring" notification-driven renew.** That
  is intended — renewal moves entirely to middleware. The risk is purely the idle-single-page
  window (D4).
- **Behavior parity with default-auth.** The frontend redirect logic is shared, so the
  default-auth e2e meaningfully exercises the "don't kick within validity; kick on true
  failure" contract. OIDC-only mechanics (discovery, refresh grant, rotation) are covered by
  the middleware integration test.

## Test / Acceptance Plan (IdP-agnostic, local)

- **A — default-auth browser e2e (primary, Playwright real viewport against a real local
  server on :8637, `.env` `DEFAULT_USER`/`DEFAULT_PASSWORD`).** Shorten the access-token TTL,
  then verify: (1) while the refresh token is valid, an access-token expiry is silently
  renewed by middleware (`handleUserSessionRefresh`) and the user is NOT redirected and the
  in-flight action is not interrupted; (2) when the refresh token is invalidated, the next
  request cleanly redirects to `/login`. This is the shared "never kick within validity; kick
  only on true death" contract.
- **B — middleware OIDC refresh integration test (IdP-agnostic).** With a mock token endpoint
  + discovery document, assert: access about to expire → standard refresh; rotation updates
  the cookie; refresh failure → `clearAuthAndRedirect`. No real IdP.
- **C — frontend unit tests.** `createOidcSettings` has `automaticSilentRenew: false`;
  `auth-context` no longer redirects on token-expired/renew-error; `authFetch` 401 OIDC
  branch no longer calls `signinSilent`.
- **D (optional / gold) — local mock OIDC issuer + Playwright full SSO e2e** (self-hosted
  well-known/jwks/token with a rotation toggle), proving the fix works for any standard
  issuer. Included only if patch size allows; otherwise A+B+C are the acceptance.

## Migration

No data migration. Behavior changes for OIDC sessions only; existing cookies remain valid.
The refresh-token cookie maxAge change applies to cookies written after deploy.
