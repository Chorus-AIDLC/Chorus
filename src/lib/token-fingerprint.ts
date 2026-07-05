// src/lib/token-fingerprint.ts
//
// Short, non-reversible token fingerprints for auth diagnostics.
//
// The iOS login-bounce recurrence (idea 3bf0819c) left an unexplained refresh-token
// death: the outcome logs alone cannot distinguish "one token genuinely died" from
// "the cookie was silently overwritten with an older token" (e.g. the sync-token
// localStorage resurrect path) from "two devices, two tokens". Logging a stable
// 8-hex SHA-256 prefix per token makes token IDENTITY traceable across the
// middleware refresh path, /api/auth/sync-token, and the login callback — without
// ever logging token material (8 hex chars of a SHA-256 is not reversible or
// usable as a credential).
//
// Uses WebCrypto (crypto.subtle), available in BOTH the Edge runtime (middleware)
// and Node >= 20 route handlers — no imports, no runtime branching.

export const TOKEN_FINGERPRINT_HEX_CHARS = 8;

/**
 * SHA-256 fingerprint of a token, truncated to the first 8 hex chars.
 * Returns undefined for missing/empty input so call sites can spread it
 * straight into a log object ({ rtFp } stays absent when there is no token).
 */
export async function tokenFingerprint(token: string | undefined | null): Promise<string | undefined> {
  if (!token) return undefined;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const bytes = new Uint8Array(digest).slice(0, TOKEN_FINGERPRINT_HEX_CHARS / 2);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
