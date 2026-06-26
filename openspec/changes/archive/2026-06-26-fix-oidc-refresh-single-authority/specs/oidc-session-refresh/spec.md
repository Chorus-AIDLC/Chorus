## ADDED Requirements

### Requirement: Edge middleware is the single OIDC refresh authority

The application SHALL renew an expiring OIDC access token in exactly one place: the Edge
middleware, by exchanging the `oidc_refresh_token` cookie at the IdP token endpoint and
writing the new access token back to the cookie. The frontend `oidc-client-ts` UserManager
SHALL NOT perform background silent renewal: `automaticSilentRenew` SHALL be disabled so
that the refresh token is consumed by only one party. The middleware refresh SHALL remain
IdP-agnostic — it SHALL use standard OIDC discovery to locate the token endpoint and the
standard `grant_type=refresh_token` exchange, with no provider-specific logic.

#### Scenario: Access token near expiry is renewed by middleware

- **WHEN** a request passes through the Edge middleware and the `oidc_access_token` cookie is
  within the expiry threshold while a valid `oidc_refresh_token` cookie is present
- **THEN** the middleware exchanges the refresh token via `grant_type=refresh_token` at the
  discovered token endpoint and writes the new access token to the cookie for both the
  downstream request and the browser response

#### Scenario: Frontend does not run silent renewal

- **WHEN** the OIDC UserManager is configured for a logged-in user
- **THEN** `automaticSilentRenew` is disabled and the frontend does not call the token
  endpoint to renew the access token using the refresh token

#### Scenario: No frontend code path consumes the refresh token to renew

- **WHEN** an authenticated request is issued and the access token is expired
- **THEN** the frontend does not call `signinSilent` (neither on a background timer nor
  before issuing a request nor on a 401) to obtain a new access token from the refresh
  token; the expired access token is sent and the middleware/cookie path performs the renewal

#### Scenario: Refresh path is not bound to any specific IdP

- **WHEN** the configured OIDC issuer is any standard provider exposing
  `/.well-known/openid-configuration` and a token endpoint that accepts
  `grant_type=refresh_token`
- **THEN** the middleware refresh succeeds without any provider-specific code path

### Requirement: An expired access token does not by itself end the session

An expired OIDC access token SHALL NOT, on its own, cause the frontend to clear the session
or redirect to the login page. The frontend SHALL NOT register handlers that force a logout
or navigation to `/login` in response to access-token-expired or silent-renew-error events.
Session continuity SHALL instead rely on the middleware refreshing the cookie and on backend
auth resolution falling through to the refreshed `oidc_access_token` cookie.

#### Scenario: Token expiry while the refresh token is still valid keeps the user signed in

- **WHEN** the access token expires but the refresh token is still valid
- **THEN** the user is not redirected to `/login`, and the next request is served using the
  cookie that the middleware refreshes

#### Scenario: No unconditional redirect on token-expired events

- **WHEN** the frontend OIDC layer observes an access-token-expired or silent-renew-error
  condition
- **THEN** it does not redirect to `/login` solely because of that event

### Requirement: Redirect to login only on a true post-middleware 401

The application SHALL redirect an OIDC user to `/login` only when a request that has already
passed through the Edge middleware (and therefore been given the cookie-refresh opportunity)
still resolves as unauthenticated — i.e. the session endpoint or a gated request returns
401, indicating the refresh token is genuinely expired or revoked. The authenticated fetch
helper SHALL NOT attempt a frontend `signinSilent` refresh on a 401 for an OIDC session;
it SHALL rely on the middleware-refreshed cookie and surface a genuine 401 to the single
redirect site.

#### Scenario: Genuine refresh-token failure redirects to login

- **WHEN** the refresh token is expired or revoked and a request passes through middleware
  (which cannot refresh) and `/api/auth/session` returns 401
- **THEN** the application clears the session state and redirects the user to `/login`

#### Scenario: authFetch does not silent-renew on OIDC 401

- **WHEN** an authenticated fetch for an OIDC session receives a 401
- **THEN** it does not call `signinSilent` and does not retry via a frontend refresh; the
  401 is surfaced for the single session-death redirect path

### Requirement: Optional keepalive refreshes the cookie for idle single-page sessions

A keepalive, when present, SHALL refresh the session cookie for an idle single-page OIDC
session before its access token expires, and session continuity SHALL NOT depend on it. When
an OIDC session exists, the application MAY run a lightweight client keepalive that, as the
access token nears expiry, issues a request to a path covered by the middleware matcher so
the middleware refreshes the cookie even if the user remains idle on a single page without
navigating. The keepalive SHALL target a middleware-covered path (not an `api/auth` path,
which is excluded from the matcher) and SHALL derive its timing from the access token's
expiry rather than a fixed constant. Even without the keepalive, the first request issued
after the user resumes activity SHALL be rescued by the middleware refresh.

#### Scenario: Idle single-page session is kept alive

- **WHEN** an OIDC user stays on a single page without navigating and the keepalive is enabled
- **THEN** before the access token expires, a request to a middleware-covered path triggers a
  cookie refresh, so the session does not lapse during the idle period

#### Scenario: Keepalive is not required for correctness

- **WHEN** the keepalive is absent or disabled and the user resumes activity after the access
  token expired (refresh token still valid)
- **THEN** the first request is refreshed by the middleware and the user is not redirected

### Requirement: Refresh-token cookie lifetime is not a hardcoded 30-day literal

The `oidc_refresh_token` cookie max-age SHALL NOT be written as an inline hardcoded 30-day
literal at any write site. Every write site SHALL source its max-age from a single
centralized, documented default constant. At the one write site that itself calls the IdP
token endpoint and therefore observes the token response — the middleware refresh-token
rotation path — the cookie max-age SHALL be derived from the IdP's stated refresh-token
lifetime (`refresh_expires_in`) when that value is present, falling back to the centralized
default when it is absent. The write sites that set the cookie from a client-supplied body
rather than an IdP token response (the OIDC callback and the token-sync endpoint) do not
observe `refresh_expires_in` and SHALL use the centralized default; they SHALL NOT be
required to derive a value they cannot observe.

#### Scenario: Middleware rotation follows refresh_expires_in when provided

- **WHEN** the middleware refreshes at the IdP token endpoint and the token response includes
  `refresh_expires_in`
- **THEN** the rotated `oidc_refresh_token` cookie is written with a max-age derived from that
  value

#### Scenario: Middleware rotation falls back to the centralized default

- **WHEN** the middleware refreshes and the IdP token response does not include a
  refresh-token lifetime
- **THEN** the rotated `oidc_refresh_token` cookie is written with the centralized documented
  default max-age, not an inline hardcoded 30-day literal

#### Scenario: Body-driven write sites use the centralized default

- **WHEN** the OIDC callback route or the token-sync route writes the `oidc_refresh_token`
  cookie from a client-supplied refresh token (no IdP token response is observed)
- **THEN** the cookie max-age is sourced from the centralized documented default constant, not
  an inline hardcoded 30-day literal
