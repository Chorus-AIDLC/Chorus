// src/lib/cookie-utils.ts
// Shared cookie utilities for consistent secure cookie handling across all routes

/**
 * Default lifetime (in seconds) for the OIDC refresh-token cookie when the IdP does
 * not tell us how long the refresh token actually lives.
 *
 * Rationale: refresh tokens are long-lived, but a cookie that outlives the IdP's real
 * refresh-token lifetime is worse than useless — it keeps presenting a token the IdP
 * will reject, which surfaces to users as "random" session expiry. We default to 30
 * days (a common refresh-token horizon) but ALWAYS prefer the IdP's stated
 * `refresh_expires_in` when it is observable (see resolveRefreshCookieMaxAge). This is
 * the single source of truth for the refresh-cookie lifetime — do NOT inline the
 * literal at call sites.
 */
export const REFRESH_TOKEN_COOKIE_MAX_AGE = 30 * 24 * 3600; // 30 days

/**
 * Resolve the max-age (seconds) for the `oidc_refresh_token` cookie.
 *
 * Only the site that calls the IdP token endpoint (the Edge middleware refresh path)
 * can observe `refresh_expires_in`; pass it there to track the IdP's real lifetime.
 * Sites that write the cookie from a client-supplied body (the OIDC callback and the
 * token-sync route) have no token response to read — they omit the argument and get
 * the centralized default. IdP-agnostic: `refresh_expires_in` is a standard OIDC token
 * response field, not provider-specific.
 *
 * @param refreshExpiresIn the IdP's `refresh_expires_in` (seconds), if present
 */
export function resolveRefreshCookieMaxAge(refreshExpiresIn?: unknown): number {
  if (typeof refreshExpiresIn === "number" && Number.isFinite(refreshExpiresIn) && refreshExpiresIn > 0) {
    return Math.floor(refreshExpiresIn);
  }
  return REFRESH_TOKEN_COOKIE_MAX_AGE;
}

/**
 * Compute cookie maxAge from a JWT's `exp` claim.
 * Returns seconds until expiry + a small buffer, or the provided fallback.
 */
export function getMaxAgeFromJwt(token: string, fallback: number = 3600): number {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return fallback;
    const payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf-8")
    );
    if (typeof payload.exp === "number") {
      const secondsLeft = payload.exp - Math.floor(Date.now() / 1000);
      // Add 60s buffer so cookie outlives the token — middleware handles refresh
      return Math.max(secondsLeft + 60, 0);
    }
    return fallback;
  } catch {
    return fallback;
  }
}

export function getCookieOptions(maxAge: number) {
  // Allow disabling secure cookies via env var (for HTTP-only deployments)
  const forceInsecure = process.env.COOKIE_SECURE === "false";
  const isProduction = process.env.NODE_ENV === "production" && !forceInsecure;

  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax" as const,
    path: "/",
    maxAge,
  };
}