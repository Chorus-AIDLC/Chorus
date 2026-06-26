# fix-oidc-refresh-single-authority

Fix SSO/OIDC token refresh: make Edge middleware the single refresh authority (IdP-agnostic), stop frontend silent-renew racing the rotating refresh token, redirect to login only on true 401
