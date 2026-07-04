// Unit tests for token fingerprinting (src/lib/token-fingerprint.ts) — the auth
// diagnostics primitive that traces refresh-token IDENTITY across the middleware,
// sync-token, and callback log lines (idea 3bf0819c).

import { describe, it, expect } from "vitest";
import { tokenFingerprint, TOKEN_FINGERPRINT_HEX_CHARS } from "@/lib/token-fingerprint";

describe("tokenFingerprint", () => {
  it("returns a deterministic 8-hex-char fingerprint", async () => {
    const a = await tokenFingerprint("some-refresh-token-value");
    const b = await tokenFingerprint("some-refresh-token-value");
    expect(a).toBe(b);
    expect(a).toMatch(new RegExp(`^[0-9a-f]{${TOKEN_FINGERPRINT_HEX_CHARS}}$`));
  });

  it("differs for different tokens", async () => {
    const a = await tokenFingerprint("token-A");
    const b = await tokenFingerprint("token-B");
    expect(a).not.toBe(b);
  });

  it("matches the known SHA-256 prefix (not reversible material)", async () => {
    // sha256("abc") = ba7816bf8f01cfea414140de5dae2223... → first 8 hex chars
    expect(await tokenFingerprint("abc")).toBe("ba7816bf");
  });

  it("passes through undefined/null/empty as undefined", async () => {
    expect(await tokenFingerprint(undefined)).toBeUndefined();
    expect(await tokenFingerprint(null)).toBeUndefined();
    expect(await tokenFingerprint("")).toBeUndefined();
  });
});
