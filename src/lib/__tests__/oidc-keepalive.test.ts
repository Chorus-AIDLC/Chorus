import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  KEEPALIVE_PATH,
  DEFAULT_KEEPALIVE_SKEW_SECONDS,
  MIN_KEEPALIVE_DELAY_MS,
  FALLBACK_KEEPALIVE_DELAY_MS,
  decodeJwtTimes,
  computeKeepaliveDelayMs,
  pingKeepalive,
} from "../oidc-keepalive";

// Build a JWT with given iat/exp (seconds). Signature is irrelevant — we only decode.
function makeJwt(claims: { iat?: number; exp?: number }): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${header}.${payload}.sig`;
}

describe("KEEPALIVE_PATH is middleware-covered but outside api/auth", () => {
  // Mirror of src/middleware.ts `config.matcher`.
  const MATCHER = "^/((?!_next|login|api/auth|skill|favicon\\.ico|.*\\.).*)$";

  it("the keepalive path is matched by the middleware (so the refresh runs for it)", () => {
    expect(new RegExp(MATCHER).test(KEEPALIVE_PATH)).toBe(true);
  });

  it("api/auth paths are NOT matched (cookie-write races stay protected)", () => {
    expect(new RegExp(MATCHER).test("/api/auth/sync-token")).toBe(false);
    expect(new RegExp(MATCHER).test("/api/auth/callback")).toBe(false);
  });

  it("the session probe path IS matched (the probe refreshes its own cookie)", () => {
    expect(new RegExp(MATCHER).test("/api/session")).toBe(true);
  });

  it("the keepalive path is not under api/auth", () => {
    expect(KEEPALIVE_PATH.startsWith("/api/auth")).toBe(false);
  });
});

describe("decodeJwtTimes", () => {
  it("decodes iat and exp", () => {
    expect(decodeJwtTimes(makeJwt({ iat: 1000, exp: 4600 }))).toEqual({ iat: 1000, exp: 4600 });
  });

  it("returns undefined fields when claims are absent", () => {
    expect(decodeJwtTimes(makeJwt({}))).toEqual({ iat: undefined, exp: undefined });
  });

  it("returns null for a malformed token", () => {
    expect(decodeJwtTimes("not-a-jwt")).toBeNull();
    expect(decodeJwtTimes("")).toBeNull();
  });
});

describe("computeKeepaliveDelayMs", () => {
  const skewMs = DEFAULT_KEEPALIVE_SKEW_SECONDS * 1000;

  it("derives the first interval from the token's exp (fires skew before expiry)", () => {
    const now = 1_000_000_000_000; // arbitrary ms
    const exp = Math.floor(now / 1000) + 3600; // 1h ahead
    const delay = computeKeepaliveDelayMs(makeJwt({ iat: Math.floor(now / 1000), exp }), now);
    // Should be ~ (3600s - skew) in ms.
    expect(delay).toBe(3600 * 1000 - skewMs);
  });

  it("re-arms one nominal lifetime (minus skew) once the token is within its skew window", () => {
    const now = 1_000_000_000_000;
    const iat = Math.floor(now / 1000) - 3600; // issued 1h ago
    const exp = Math.floor(now / 1000) + 5; // ~expired (inside skew window)
    const delay = computeKeepaliveDelayMs(makeJwt({ iat, exp }), now);
    // lifetime = exp - iat = 3605s; minus skew.
    expect(delay).toBe((exp - iat) * 1000 - skewMs);
  });

  it("never schedules below the minimum delay", () => {
    const now = 1_000_000_000_000;
    // Token already expired and lifetime ~0 ⇒ clamps to MIN.
    const exp = Math.floor(now / 1000) - 1;
    const iat = exp; // lifetime 0 → falls through to fallback path, but ensure no sub-min
    const delay = computeKeepaliveDelayMs(makeJwt({ iat, exp }), now);
    expect(delay).toBeGreaterThanOrEqual(MIN_KEEPALIVE_DELAY_MS);
  });

  it("clamps a near-but-still-future expiry to the minimum delay", () => {
    const now = 1_000_000_000_000;
    const exp = Math.floor(now / 1000) + DEFAULT_KEEPALIVE_SKEW_SECONDS + 1; // fireAt ~1s ahead
    const delay = computeKeepaliveDelayMs(makeJwt({ iat: Math.floor(now / 1000), exp }), now);
    expect(delay).toBe(MIN_KEEPALIVE_DELAY_MS);
  });

  it("falls back to the fixed fallback when the token is undecodable or missing exp", () => {
    const now = 1_000_000_000_000;
    expect(computeKeepaliveDelayMs(null, now)).toBe(FALLBACK_KEEPALIVE_DELAY_MS);
    expect(computeKeepaliveDelayMs(undefined, now)).toBe(FALLBACK_KEEPALIVE_DELAY_MS);
    expect(computeKeepaliveDelayMs("bad", now)).toBe(FALLBACK_KEEPALIVE_DELAY_MS);
    expect(computeKeepaliveDelayMs(makeJwt({ iat: 1 }), now)).toBe(FALLBACK_KEEPALIVE_DELAY_MS);
  });
});

describe("pingKeepalive", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("GETs the keepalive path with same-origin credentials", async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true } as any);
    await pingKeepalive();
    expect(fetch).toHaveBeenCalledWith(
      KEEPALIVE_PATH,
      expect.objectContaining({ method: "GET", credentials: "same-origin" })
    );
  });

  it("swallows errors (best-effort, not a correctness dependency)", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("offline"));
    await expect(pingKeepalive()).resolves.toBeUndefined();
  });
});
