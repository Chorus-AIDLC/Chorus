# Fix SSO/OIDC token refresh: single server-side refresh authority, IdP-agnostic

## Why

SSO (OIDC) users on the hosted deployment report that, after logging in, their session
keeps expiring and bounces them back to `/login` even when it should silently renew.

Root cause (verified against the full auth flow in `develop` / 0.11.2): the SSO session
runs **two independent token-refresh mechanisms that share one OIDC refresh token but live
in different stores and never synchronize**:

1. **Frontend `oidc-client-ts`** (`src/lib/oidc.ts:33`): `automaticSilentRenew: true` with
   `accessTokenExpiringNotificationTimeInSeconds: 60`. It renews ~60s before access-token
   expiry using the refresh token in **`localStorage`**, then syncs the new token into the
   cookie (`src/contexts/auth-context.tsx:122` `handleUserLoaded`).
2. **Edge Middleware** (`src/middleware.ts:203-296`): on every navigation / RSC / `/api/*`
   (non-`api/auth`) request, if the **`oidc_access_token` cookie** is within 30s of expiry,
   it exchanges the **`oidc_refresh_token` cookie** at the IdP token endpoint and writes the
   new token back to the cookie, rotating the refresh-token cookie when the IdP returns a
   new one (`src/middleware.ts:286-289`).

Why this kicks the user out — three compounding facts, all verified:

- **The two stores never sync.** Middleware runs in Edge and cannot touch the browser's
  `localStorage`; it only updates cookies. So the refresh token held by `oidc-client-ts` in
  `localStorage` goes stale.
- **Refresh-token rotation makes `invalid_grant` inevitable.** With one-time rotation
  (common in modern OIDC, including Cognito's recommended config), whichever consumer uses
  the already-rotated token second is rejected. Typical sequence: tab in background →
  browser throttles the `oidc-client-ts` timer → access token truly expires → user returns
  and navigates → middleware refreshes and rotates the cookie refresh token first → then
  `oidc-client-ts` wakes and calls `signinSilent()` with the now-**stale** `localStorage`
  refresh token → `invalid_grant`.
- **The frontend has an "expired ⇒ logout" trigger decoupled from real session state.**
  On `addAccessTokenExpired` or `addSilentRenewError`, `src/contexts/auth-context.tsx:110-119`
  calls `handleSessionExpired()` → `router.push("/login")` **unconditionally — even when the
  cookie session that middleware maintains is still perfectly valid.** This is the direct
  cause of "I should still be logged in, but I keep getting kicked out."

A decisive enabling fact (verified): `getAuthContext` (`src/lib/auth.ts:26-83`) resolves
auth in the order **Bearer header → `user_session` cookie → `oidc_access_token` cookie**.
When the `localStorage` Bearer token is expired, `verifyOidcAccessToken` returns null and
the function **falls through** to read the `oidc_access_token` cookie — i.e. the token
middleware just refreshed. **So the backend already authenticates from the
middleware-refreshed cookie even when the frontend Bearer token is stale.** This is what
makes a single server-side refresh authority correct.

This change is **IdP-agnostic by construction** (an explicit requirement from the
requester: do not bind to any specific IdP). The middleware refresh path uses standard OIDC
discovery (`<issuer>/.well-known/openid-configuration` → `token_endpoint`) and the standard
`grant_type=refresh_token` exchange — there is no Cognito-specific code
(`src/middleware.ts:39-64, 246-255`).

## What Changes

- **Make the Edge middleware (cookie) the single OIDC refresh authority.** Disable
  `automaticSilentRenew` so `oidc-client-ts` stops consuming the refresh token to renew, and
  stop the frontend from racing the rotating refresh token. `oidc-client-ts` remains only
  for the initial login authorization-code exchange.
- **Remove the unconditional "expired ⇒ logout" trigger.** The `addAccessTokenExpired` /
  `addSilentRenewError` → `handleSessionExpired()` redirect is removed. An expired access
  token is no longer treated as a dead session — middleware silently renews on the next
  request, and `getAuthContext` falls through to the refreshed cookie.
- **Remove BOTH frontend refresh-token consumers in `auth-client.ts`.** Besides the
  401-branch retry, `getAccessToken()` (`src/lib/auth-client.ts:50-72`) independently calls
  `signinSilent()` on expiry and runs at the top of every `authFetch` (line 100) regardless
  of `automaticSilentRenew`. Both are removed so the frontend never consumes the rotating
  refresh token; the expired access token is sent and the cookie/middleware path renews.
- **Redirect to login only on a true 401.** A logout/redirect happens only when a request
  that has passed through middleware (and thus been given the cookie-refresh opportunity)
  still returns 401 from `/api/auth/session` — i.e. the refresh token is genuinely
  expired/revoked. The `authFetch` OIDC 401 branch (`src/lib/auth-client.ts:113-127`) drops
  its `signinSilent` retry and relies on the middleware-refreshed cookie.
- **Defense-in-depth keepalive (minimal).** When an OIDC session exists, a lightweight
  client keepalive pings a middleware-covered endpoint as the access token nears expiry, so
  a user idle on a single SPA page (pure soft navigation may not hit middleware) still gets
  the cookie refreshed before it expires. This is a defense layer only — even without it the
  first real request after idling is rescued by the middleware fall-through; the keepalive
  just shrinks the window in which SSE/streaming connections might drop first.
- **Stop pinning the refresh-token cookie maxAge to a hardcoded 30 days.** Replace the inline
  `30 * 24 * 3600` literal at all three write sites with a single centralized, documented
  default constant. Only the middleware rotation site actually calls the IdP token endpoint,
  so only it can (and does) upgrade to the IdP's `refresh_expires_in` when present; the
  callback and token-sync routes write the cookie from a client-supplied body and have no
  `refresh_expires_in` to read, so they use the centralized default. A 30-day cookie
  outliving a shorter-lived IdP refresh token presents as "random" expiry.

## Capabilities

- **oidc-session-refresh** — normative requirements that the Edge middleware is the sole
  OIDC refresh authority, that an expired access token does not by itself end the session or
  force a redirect, that a redirect to login happens only on a true post-middleware 401,
  that the frontend does not run silent-renew against the refresh token, that an optional
  keepalive refreshes the cookie before expiry for idle single-page sessions, and that the
  refresh-token cookie lifetime tracks the IdP's stated refresh-token lifetime rather than a
  hardcoded 30 days. The requirements are stated IdP-agnostically (any standard OIDC issuer).

## Impact

- Affected code (frontend OIDC refresh + redirect logic, plus the two cookie-writing paths):
  - `src/lib/oidc.ts:15-44` — `createOidcSettings`: `automaticSilentRenew` disabled; review
    `silent_redirect_uri` / `accessTokenExpiringNotificationTimeInSeconds` usage.
  - `src/contexts/auth-context.tsx:99-150` — remove the OIDC `expired`/`renew-error` →
    `handleSessionExpired` redirect; keep redirect only for a true 401 from the session
    fetch.
  - `src/lib/auth-client.ts:50-72` — `getAccessToken()` no longer calls `signinSilent` on
    expiry (the per-request refresh-token consumer); and `:113-127` — `authFetch` OIDC 401
    branch no longer retries `signinSilent`. Both rely on the middleware-refreshed cookie.
    Optional keepalive helper.
  - `src/middleware.ts:286-289` — rotation site derives `oidc_refresh_token` cookie maxAge
    from `refresh_expires_in` when present, else the centralized default.
  - `src/app/api/auth/sync-token/route.ts:35-37` and `src/app/api/auth/callback/route.ts:65-68`
    — body-driven cookie writes use the centralized default constant (no IdP token response
    here), replacing the inline 30-day literal.
- **Out of scope / must not change:** MCP / API Key (`cho_`) authentication; SuperAdmin and
  default-auth business semantics; the `getAuthContext` precedence order. The default-auth
  refresh path is exercised only as a test harness to verify shared behavior, not modified.
- No database schema change. No new runtime dependency.
- Local e2e (IdP-agnostic): the primary acceptance runs against the **default-auth** login
  path in a real browser, because default-auth and SSO share the same middleware refresh
  framework (`handleUserSessionRefresh` alongside the OIDC refresh) and the same frontend
  redirect logic (`auth-context` `handleSessionExpired`). OIDC-specific branches are covered
  by a middleware refresh integration test with a mock token endpoint + discovery, plus
  frontend unit tests. An optional local mock-OIDC-issuer Playwright run is the gold-standard
  "works for any standard issuer" proof if patch size allows.
