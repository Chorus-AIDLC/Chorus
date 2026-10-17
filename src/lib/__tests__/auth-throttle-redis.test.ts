import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// Minimal ioredis stand-in: one shared store models a single Redis server that
// several app instances (separately imported modules) talk to.
const store = new Map<string, { value: number; expiresAt: number }>();
const fakeRedis = {
  status: "ready" as string,
  defineCommand: vi.fn(),
  // RateLimiterRedis builds a MULTI before choosing the Lua path; it is unused for consume().
  multi: vi.fn(() => ({})),
  rlflxIncr: vi.fn(async ([key, points, secDuration]: string[]) => {
    const now = Date.now();
    let entry = store.get(key);
    if (!entry || entry.expiresAt <= now) entry = { value: 0, expiresAt: now + Number(secDuration) * 1000 };
    entry.value += Number(points);
    store.set(key, entry);
    return [entry.value, entry.expiresAt - now];
  }),
};
let redisConfigured = true;

const { mockLogger } = vi.hoisted(() => {
  const mockLogger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { mockLogger };
});

vi.mock("@/lib/redis", () => ({ getRedisGeneral: () => (redisConfigured ? fakeRedis : null) }));
vi.mock("@/lib/logger", () => ({ default: { child: () => mockLogger } }));

type ThrottleModule = typeof import("../auth-throttle");

// Each fresh import is an independent app instance with its own in-memory state.
async function newInstance(): Promise<ThrottleModule> {
  vi.resetModules();
  return import("../auth-throttle");
}

function request(address?: string) {
  return new NextRequest("http://localhost/api/auth/login", {
    headers: address ? { "x-forwarded-for": address } : {},
  });
}

beforeEach(() => {
  store.clear();
  fakeRedis.status = "ready";
  fakeRedis.rlflxIncr.mockClear();
  redisConfigured = true;
  vi.clearAllMocks();
  vi.stubEnv("AUTH_TRUST_PROXY", "false");
  vi.stubEnv("AUTH_TRUST_PROXY_HOPS", "1");
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

describe("distributed auth throttle (Redis backend)", () => {
  it("counts attempts against Redis with namespaced keys", async () => {
    const { throttleAuth } = await newInstance();
    expect(await throttleAuth(request(), "login", "tenant:alice")).toBeNull();
    expect(fakeRedis.rlflxIncr).toHaveBeenCalledTimes(1);
    expect([...store.keys()][0]).toMatch(/^chorus:auth_rl:login:identity::[0-9a-f]{64}$/);
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it.each([["identify", 30], ["login", 10], ["accept", 10]] as const)("merges %s attempts across instances sharing Redis", async (action, limit) => {
    const a = await newInstance();
    const b = await newInstance();
    expect(a.throttleAuth).not.toBe(b.throttleAuth);
    for (let i = 0; i < limit; i++) {
      expect(await (i % 2 ? a : b).throttleAuth(request(), action, "same-identity")).toBeNull();
    }
    for (const instance of [a, b]) {
      const blocked = await instance.throttleAuth(request(), action, "same-identity");
      expect(blocked?.status).toBe(429);
      expect(Number(blocked?.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
      expect(await blocked?.json()).toMatchObject({ success: false, error: { code: "RATE_LIMITED" } });
    }
    expect(await a.throttleAuth(request(), action, "other-identity")).toBeNull();
  });

  it("shares the trusted-address bucket across instances despite identity rotation", async () => {
    vi.stubEnv("AUTH_TRUST_PROXY", "true");
    const a = await newInstance();
    const b = await newInstance();
    for (let i = 0; i < 10; i++) {
      expect(await (i % 2 ? a : b).throttleAuth(request(`198.51.100.${i}, 203.0.113.10`), "login", `id-${i}`)).toBeNull();
    }
    expect((await a.throttleAuth(request("203.0.113.10"), "login", "fresh"))?.status).toBe(429);
    expect(await b.throttleAuth(request("203.0.113.11"), "login", "fresh")).toBeNull();
    expect(store.has("chorus:auth_rl:login:address:203.0.113.10")).toBe(true);
  });

  it("expires shared counters after the window", async () => {
    vi.useFakeTimers();
    const { throttleAuth } = await newInstance();
    for (let i = 0; i < 10; i++) await throttleAuth(request(), "login", "alice");
    expect((await throttleAuth(request(), "login", "alice"))?.status).toBe(429);
    vi.advanceTimersByTime(60_001);
    expect(await throttleAuth(request(), "login", "alice")).toBeNull();
  });
});

describe("Redis absent", () => {
  it("falls back to in-memory limiting and warns once", async () => {
    redisConfigured = false;
    const { throttleAuth } = await newInstance();
    for (let i = 0; i < 10; i++) expect(await throttleAuth(request(), "login", "alice")).toBeNull();
    expect((await throttleAuth(request(), "login", "alice"))?.status).toBe(429);
    expect(fakeRedis.rlflxIncr).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn.mock.calls[0][0]).toMatch(/single-instance in-memory mode/);
  });

  it("does not share counters between instances (documented per-instance limits)", async () => {
    redisConfigured = false;
    const a = await newInstance();
    const b = await newInstance();
    for (let i = 0; i < 10; i++) await a.throttleAuth(request(), "login", "alice");
    expect((await a.throttleAuth(request(), "login", "alice"))?.status).toBe(429);
    expect(await b.throttleAuth(request(), "login", "alice")).toBeNull();
  });
});

describe("Redis outage at runtime", () => {
  it("degrades to per-instance insurance limits without touching Redis, then recovers", async () => {
    const { throttleAuth } = await newInstance();
    expect(await throttleAuth(request(), "login", "alice")).toBeNull();

    fakeRedis.status = "reconnecting";
    fakeRedis.rlflxIncr.mockClear();
    for (let i = 0; i < 10; i++) expect(await throttleAuth(request(), "login", "bob")).toBeNull();
    // Still limited while Redis is down — the outage does not disable throttling.
    expect((await throttleAuth(request(), "login", "bob"))?.status).toBe(429);
    expect(fakeRedis.rlflxIncr).not.toHaveBeenCalled();
    const degradedWarns = mockLogger.warn.mock.calls.filter(([meta]) => meta?.status === "reconnecting");
    expect(degradedWarns).toHaveLength(1);

    fakeRedis.status = "ready";
    expect(await throttleAuth(request(), "login", "carol")).toBeNull();
    expect(fakeRedis.rlflxIncr).toHaveBeenCalledTimes(1);
    expect(mockLogger.info).toHaveBeenCalledWith(expect.stringMatching(/distributed limits restored/));
  });

  it("falls back to insurance limits when a Redis command fails", async () => {
    const { throttleAuth } = await newInstance();
    const impl = fakeRedis.rlflxIncr.getMockImplementation()!;
    fakeRedis.rlflxIncr.mockRejectedValue(new Error("Connection is closed."));
    try {
      for (let i = 0; i < 10; i++) expect(await throttleAuth(request(), "login", "dave")).toBeNull();
      expect((await throttleAuth(request(), "login", "dave"))?.status).toBe(429);
      // Client still reports "ready", so only the insurance hook can surface the degradation.
      const insuranceWarns = mockLogger.warn.mock.calls.filter(([, msg]) => /insurance limits/.test(String(msg)));
      expect(insuranceWarns).toHaveLength(1);
      expect(insuranceWarns[0][0]).toMatchObject({ action: "login", scope: "identity" });
    } finally {
      fakeRedis.rlflxIncr.mockImplementation(impl);
    }
  });

  it("fails open with a warning on unexpected backend errors", async () => {
    redisConfigured = false;
    const mod = await newInstance();
    const { RateLimiterMemory } = await import("rate-limiter-flexible");
    const spy = vi.spyOn(RateLimiterMemory.prototype, "consume").mockRejectedValue(new Error("boom"));
    try {
      expect(await mod.throttleAuth(request(), "login", "erin")).toBeNull();
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ action: "login", scope: "identity" }), expect.stringMatching(/fail-open/));
    } finally {
      spy.mockRestore();
    }
  });
});
