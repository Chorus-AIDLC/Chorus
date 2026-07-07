# sse-resume-timing Specification

## Purpose
Records the retirement of the resume gate. The gate existed to suppress the burst of
concurrent middleware-covered requests fired when a backgrounded tab becomes visible,
under the hypothesis that Cognito refresh-token rotation made concurrent refreshes
lethal (race losers get `invalid_grant`). Production fingerprint evidence disproved the
hypothesis: rotation is OFF for this deployment (`RefreshTokenRotation: null`), and
concurrent refreshes of the same refresh token all succeed. The gate was therefore
deleted in the auth slim-down (idea 3bf0819c) — visibility handlers reconnect and fetch
immediately.

## Requirements
### Requirement: Resume-time request bursts are tolerated, with a rotation precondition on record

Client contexts that react to `visibilitychange` to visible (notification, realtime, and agent-presence) SHALL reconnect their streams and issue their accompanying fetches immediately, without deferring on any shared gate. This is safe because the deployment's IdP does not rotate refresh tokens: concurrent middleware refreshes of the same refresh token all succeed, and the middleware's lenient-failure contract (see the oidc-session-refresh spec) absorbs any transient rejection without destroying session state. **Precondition on record:** if refresh-token rotation is ever enabled at the IdP, resume burst suppression MUST be reintroduced before or with that change — under rotation, concurrent refreshes produce `invalid_grant` for every race loser and can trip IdP reuse detection, revoking the whole token family.

#### Scenario: Resume reconnects fire immediately

- **WHEN** a backgrounded tab becomes visible and the SSE contexts' visibility handlers run
- **THEN** stream reconnects and their accompanying fetches are issued without waiting on
  any auth-revalidation gate, and any refresh contention is absorbed by the middleware's
  lenient-failure contract

#### Scenario: Rotation re-enablement requires burst suppression

- **WHEN** refresh-token rotation is enabled at the IdP for this application's client
- **THEN** a resume burst-suppression mechanism is reintroduced as part of the same change,
  before concurrent resume refreshes can race the rotated token
