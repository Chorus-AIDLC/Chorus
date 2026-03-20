// src/lib/cookie-utils.ts
// Shared cookie utilities for consistent secure cookie handling across all routes

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