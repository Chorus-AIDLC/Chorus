// src/lib/oidc-keepalive.ts
//
// DEFENSE-IN-DEPTH ONLY — session continuity does NOT depend on this.
//
// The Edge middleware is the single OIDC refresh authority (see src/middleware.ts and
// src/lib/oidc.ts). It refreshes the `oidc_access_token` cookie on any request to a
// matcher-covered path. But a user idle on a single SPA page may issue no such request
// for a while, so their cookie could lapse mid-idle (dropping SSE/streaming first).
//
// This keepalive simply pings a middleware-covered path shortly before the access token
// expires, so the middleware refreshes the cookie even while the user is idle. If this
// keepalive is removed or disabled, the session is still correct: the first request the
// user makes after resuming activity passes through the middleware and is refreshed
// (getAuthContext falls through to the refreshed cookie). The keepalive only shrinks the
// idle window in which a streaming connection might drop.

// The ping target MUST be inside the middleware matcher (NOT an `api/auth` path, which
// the matcher excludes) so the middleware's OIDC refresh runs for it.
export const KEEPALIVE_PATH = "/api/keepalive";

// Fire this many seconds BEFORE the access token's expiry. Must be smaller than the
// middleware's own near-expiry refresh threshold (30s) so the ping lands inside the
// refresh window and the middleware actually rotates the cookie.
export const DEFAULT_KEEPALIVE_SKEW_SECONDS = 20;

// Never schedule faster than this (avoids a busy loop on a near-expired/short token).
export const MIN_KEEPALIVE_DELAY_MS = 5_000;

// Used only when the access token cannot be decoded for iat/exp. This is an explicit
// fallback for an undecodable token, not the primary scheduling path (which derives the
// interval from the token's own exp/iat).
export const FALLBACK_KEEPALIVE_DELAY_MS = 5 * 60_000; // 5 minutes

/** Decode a JWT's `iat` and `exp` (seconds) without verifying the signature. */
export function decodeJwtTimes(jwt: string): { iat?: number; exp?: number } | null {
  try {
    const parts = jwt.split(".");
    if (parts.length !== 3) return null;
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = typeof atob === "function" ? atob(base64) : Buffer.from(base64, "base64").toString("utf-8");
    const payload = JSON.parse(json);
    const iat = typeof payload.iat === "number" ? payload.iat : undefined;
    const exp = typeof payload.exp === "number" ? payload.exp : undefined;
    return { iat, exp };
  } catch {
    return null;
  }
}

/**
 * Compute the delay (ms) until the next keepalive ping, derived from the access token's
 * own `exp`/`iat` — never a hardcoded interval.
 *
 * - While the current token still has more than `skew` seconds of life, fire just before
 *   its expiry (`exp - skew`). This handles the first interval, when the token may be
 *   partway through its life.
 * - Once the token is within (or past) its `skew` window — which is the steady state, since
 *   the localStorage token is frozen at login while the cookie is what actually rotates —
 *   re-arm for one nominal token lifetime (`exp - iat`) minus `skew`, so the next ping lands
 *   in the refreshed cookie's expiry window.
 *
 * Clamped to at least MIN_KEEPALIVE_DELAY_MS; falls back to FALLBACK_KEEPALIVE_DELAY_MS if
 * the token cannot be decoded.
 */
export function computeKeepaliveDelayMs(
  jwt: string | undefined | null,
  nowMs: number,
  skewSeconds: number = DEFAULT_KEEPALIVE_SKEW_SECONDS
): number {
  if (!jwt) return FALLBACK_KEEPALIVE_DELAY_MS;
  const times = decodeJwtTimes(jwt);
  if (!times || typeof times.exp !== "number") return FALLBACK_KEEPALIVE_DELAY_MS;

  const skewMs = skewSeconds * 1000;
  const fireAtMs = times.exp * 1000 - skewMs;

  if (fireAtMs > nowMs) {
    // First interval: fire just before this token's expiry.
    return Math.max(fireAtMs - nowMs, MIN_KEEPALIVE_DELAY_MS);
  }

  // Steady state: re-arm one nominal lifetime (minus skew) from now.
  if (typeof times.iat === "number" && times.exp > times.iat) {
    const lifetimeMs = (times.exp - times.iat) * 1000;
    return Math.max(lifetimeMs - skewMs, MIN_KEEPALIVE_DELAY_MS);
  }

  return FALLBACK_KEEPALIVE_DELAY_MS;
}

/**
 * Ping the keepalive path so the middleware refreshes the cookie. Best-effort: errors are
 * swallowed (the next real request, or the next tick, recovers). `credentials: "same-origin"`
 * ensures the cookies ride along so the middleware can read/rotate them.
 */
export async function pingKeepalive(): Promise<void> {
  try {
    await fetch(KEEPALIVE_PATH, { method: "GET", credentials: "same-origin", cache: "no-store" });
  } catch {
    // Best-effort only — keepalive is not a correctness dependency.
  }
}
