// src/lib/cookie-utils.ts
// Shared cookie utilities for consistent secure cookie handling across all routes

/**
 * Get cookie options with correct secure flag based on environment
 *
 * Allows disabling secure cookies via COOKIE_SECURE=false for HTTP-only deployments.
 * By default, cookies are secure in production mode.
 *
 * @param maxAge - Cookie max age in seconds
 * @returns Cookie options object
 */
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