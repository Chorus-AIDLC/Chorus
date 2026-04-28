// src/lib/oidc-utils.ts
// Pure, server-safe OIDC helpers. Keep free of client-only deps
// (e.g. oidc-client-ts) so it can be imported from API routes.

// Extract the hostname of an OIDC issuer URL. When the input is not
// a parseable URL, return the original string unchanged so the caller
// still has something to render.
export function parseHost(issuer: string): string {
  try {
    return new URL(issuer).host;
  } catch {
    return issuer;
  }
}
