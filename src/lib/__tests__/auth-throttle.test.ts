import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { resetAuthThrottleForTests, throttleAuth } from "../auth-throttle";

function request(address?: string) {
  return new NextRequest("http://localhost/api/auth/identify", {
    headers: address ? { "x-forwarded-for": address } : {},
  });
}

beforeEach(() => {
  resetAuthThrottleForTests();
  vi.stubEnv("AUTH_TRUST_PROXY", "false");
  vi.stubEnv("AUTH_TRUST_PROXY_HOPS", "1");
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

describe("authentication throttle client isolation", () => {
  it.each(["identify", "login", "accept"] as const)("does not globally exhaust %s when no address is trusted", action => {
    const limit = action === "identify" ? 30 : 10;
    for (let i = 0; i < limit + 1; i++) {
      expect(throttleAuth(request(`203.0.113.${i + 1}`), action, `identity-${i}`)).toBeNull();
    }
    for (let i = 1; i < limit; i++) expect(throttleAuth(request(), action, "identity-0")).toBeNull();
    const blocked = throttleAuth(request("198.51.100.1"), action, "identity-0");
    expect(blocked?.status).toBe(429);
    expect(blocked?.headers.get("Retry-After")).toBeTruthy();
    expect(throttleAuth(request(), action, "unrelated-identity")).toBeNull();
  });

  it("keys fallback local login by tenant and identifier", () => {
    for (let i = 0; i < 10; i++) expect(throttleAuth(request(), "login", "tenant-a:alice")).toBeNull();
    expect(throttleAuth(request(), "login", "tenant-a:alice")?.status).toBe(429);
    expect(throttleAuth(request(), "login", "tenant-b:alice")).toBeNull();
  });

  it("uses the ALB-appended rightmost IP despite rotating forged prefixes", () => {
    vi.stubEnv("AUTH_TRUST_PROXY", "true");
    for (let i = 0; i < 10; i++) {
      expect(throttleAuth(request(`198.51.100.${i + 1}, 203.0.113.10`), "login", `identity-${i}`)).toBeNull();
    }
    expect(throttleAuth(request("198.51.100.99, 203.0.113.10"), "login", "new-identity")?.status).toBe(429);
    expect(throttleAuth(request("198.51.100.99, 203.0.113.11"), "login", "new-identity")).toBeNull();
  });

  it("supports an explicitly configured trusted right-hand hop count", () => {
    vi.stubEnv("AUTH_TRUST_PROXY", "true");
    vi.stubEnv("AUTH_TRUST_PROXY_HOPS", "2");
    for (let i = 0; i < 10; i++) expect(throttleAuth(request(`198.51.100.${i + 1}, 203.0.113.10, 192.0.2.1`), "login", `a-${i}`)).toBeNull();
    expect(throttleAuth(request("198.51.100.99, 203.0.113.10, 192.0.2.1"), "login", "new")?.status).toBe(429);
    expect(throttleAuth(request("198.51.100.99, 203.0.113.11, 192.0.2.1"), "login", "new")).toBeNull();
  });

  it("normalizes equivalent IPv6 addresses into the same trusted bucket", () => {
    vi.stubEnv("AUTH_TRUST_PROXY", "true");
    for (let i = 0; i < 10; i++) expect(throttleAuth(request("2001:db8::1"), "login", `a-${i}`)).toBeNull();
    expect(throttleAuth(request("2001:0db8:0:0:0:0:0:1"), "login", "new")?.status).toBe(429);
    expect(throttleAuth(request("2001:db8::2"), "login", "new")).toBeNull();
  });

  it.each([undefined, "garbage", "203.0.113.1, garbage", "", "unknown", "fe80::1%eth0"])("does not create a global bucket for invalid/missing XFF %s", address => {
    vi.stubEnv("AUTH_TRUST_PROXY", "true");
    for (let i = 0; i < 11; i++) expect(throttleAuth(request(address), "accept", `token-${i}`)).toBeNull();
  });

  it.each(["0", "-1", "1.5", "abc", "17", "2"])("falls back to identity isolation for invalid/unavailable hop count %s", hops => {
    vi.stubEnv("AUTH_TRUST_PROXY", "true");
    vi.stubEnv("AUTH_TRUST_PROXY_HOPS", hops);
    for (let i = 0; i < 11; i++) expect(throttleAuth(request("203.0.113.1"), "login", `identity-${i}`)).toBeNull();
  });

  it.each(["203.0.113.1:12345", "[2001:db8::1]:12345"])("normalizes ALB client-port syntax %s", address => {
    vi.stubEnv("AUTH_TRUST_PROXY", "true");
    for (let i = 0; i < 10; i++) expect(throttleAuth(request(address), "login", `a-${i}`)).toBeNull();
    const bare = address.startsWith("[") ? "2001:db8::1" : "203.0.113.1";
    expect(throttleAuth(request(bare), "login", "new")?.status).toBe(429);
  });

  it("expires limits and preserves current identity at bounded-capacity eviction", () => {
    vi.useFakeTimers();
    for (let i = 0; i < 10001; i++) expect(throttleAuth(request(), "login", `identity-${i}`)).toBeNull();
    for (let i = 1; i < 10; i++) expect(throttleAuth(request(), "login", "identity-10000")).toBeNull();
    expect(throttleAuth(request(), "login", "identity-10000")?.status).toBe(429);
    expect(throttleAuth(request(), "login", "identity-0")).toBeNull();
    vi.advanceTimersByTime(60001);
    expect(throttleAuth(request(), "login", "identity-10000")).toBeNull();
  });
});
