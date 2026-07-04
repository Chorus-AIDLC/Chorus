# oidc-session-refresh delta

## MODIFIED Requirements

### Requirement: Redirect to login only on a true post-middleware 401

The application SHALL redirect an OIDC user to `/login` only when a request that has already passed through the Edge middleware (and therefore been given the cookie-refresh opportunity) still resolves as unauthenticated — i.e. the session endpoint or a gated request returns 401, indicating the refresh token is genuinely expired or revoked. The Edge middleware itself SHALL NOT redirect any request to `/login` and SHALL NOT expire or clear auth cookies, under any refresh outcome; the client-side session probe (prime, then retry once, then redirect on a second 401) is the sole session-death decision site for OIDC sessions. The authenticated fetch helper SHALL NOT attempt a frontend `signinSilent` refresh on a 401 for an OIDC session; it SHALL rely on the middleware-refreshed cookie and surface a genuine 401 to the single redirect site.

#### Scenario: Genuine refresh-token failure redirects to login

- **WHEN** the refresh token is expired or revoked and a request passes through middleware
  (which cannot refresh) and `/api/auth/session` returns 401 both before and after a
  cookie-priming retry
- **THEN** the application clears the session state client-side and redirects the user to
  `/login`

#### Scenario: Middleware never issues the login redirect

- **WHEN** any request passes through the Edge middleware, regardless of the state of the
  auth cookies or the outcome of a refresh attempt
- **THEN** the middleware response is never a redirect to `/login` and never carries
  cookie-expiring `Set-Cookie` headers for the auth cookies

#### Scenario: authFetch does not silent-renew on OIDC 401

- **WHEN** an authenticated fetch for an OIDC session receives a 401
- **THEN** it does not call `signinSilent` and does not retry via a frontend refresh; the
  401 is surfaced for the single session-death redirect path

## ADDED Requirements

### Requirement: Middleware refresh failure is non-destructive

The Edge middleware SHALL treat every OIDC refresh failure as transient and pass the request through unchanged: on a network error contacting the IdP, an OIDC discovery failure, a non-OK token-endpoint response (including `invalid_grant`), a token response missing `access_token`, or an expired access token with missing refresh materials, the middleware SHALL forward the request without modifying any cookie and without redirecting. Rationale: under refresh-token rotation, a middleware invocation cannot distinguish losing a concurrent-refresh race from genuine refresh-token revocation, so it never has enough information to destroy session state safely.

#### Scenario: Concurrent-refresh race loser does not destroy the session

- **WHEN** multiple simultaneous requests each trigger a middleware refresh with the same
  rotated-away refresh token and the IdP rejects the losers with `invalid_grant`
- **THEN** each losing request is passed through with cookies untouched, and the winning
  request's refreshed cookies remain in effect for subsequent requests

#### Scenario: Network error during resume does not end the session

- **WHEN** the middleware's fetch to the IdP token endpoint throws (e.g. the device's
  network stack is not yet ready after tab resume)
- **THEN** the request is passed through with cookies untouched and the user is not
  redirected

#### Scenario: Expired token with missing refresh materials passes through

- **WHEN** the access token cookie is expired and one or more of the refresh token,
  client-id, or issuer cookies are absent
- **THEN** the middleware passes the request through without clearing the remaining
  cookies; downstream auth resolution and the client probe decide the outcome

### Requirement: Every middleware refresh attempt emits a structured diagnostic log

The Edge middleware SHALL emit exactly one structured log line per OIDC refresh attempt, carrying at minimum: an event identifier, the outcome class (refreshed, IdP-rejected, network-error, discovery-failed, malformed-response, or skipped-for-missing-materials), the IdP HTTP status and OAuth error code when applicable, the triggering request path, the access token's expiry delta at decision time, and the token-endpoint round-trip duration. Failure outcomes SHALL log at warning level. The diagnostics SHALL be server-console logs only and SHALL NOT create database or activity records.

#### Scenario: A resume burst is identifiable from the logs

- **WHEN** several requests trigger refresh attempts within a short window after a tab
  resume
- **THEN** the logs show one line per attempt with the triggering path and outcome, making
  the winner and any race losers individually attributable

#### Scenario: Failure logs carry the IdP error detail

- **WHEN** the IdP token endpoint returns a non-OK response with an OAuth error body
- **THEN** the log line records the HTTP status and, when parseable, the OAuth `error`
  code such as `invalid_grant`
