// @vitest-environment jsdom
//
// Behavioral unit tests for AuthProvider's session-death contract (Chorus 0.11.2
// OIDC-refresh fix). The single refresh authority is the Edge middleware (cookie);
// the frontend must NOT redirect to /login just because an access token expired or a
// silent renew errored. It redirects ONLY on a true 401 from /api/auth/session (a
// request that already passed through middleware), and never on a transient/network
// failure.
//
// Test seams:
//   - `authFetch` is mocked so we drive the /api/auth/session response.
//   - `getUserManager` is mocked to expose the OIDC event registry, so we can assert
//     which events are (not) wired and fire them directly.
//   - `next/navigation`'s router.push is mocked to observe redirects.

import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, waitFor , act } from "@testing-library/react";

const authFetch = vi.fn();
const push = vi.fn();
const getOidcUser = vi.fn().mockResolvedValue(null);
const primeSessionCookie = vi.fn().mockResolvedValue(undefined);
const resyncRefreshTokenFromStore = vi.fn().mockResolvedValue(false);

// OIDC manager event registry captured per-test.
let registeredEvents: Record<string, ((...a: unknown[]) => void) | undefined>;
let manager: { events: Record<string, (cb: (...a: unknown[]) => void) => void> } | null;

vi.mock("@/lib/auth-client", () => ({
  authFetch: (url: string, opts?: RequestInit) => authFetch(url, opts),
  getOidcUser: () => getOidcUser(),
  syncTokenToCookie: vi.fn().mockResolvedValue(true),
  resyncRefreshTokenFromStore: () => resyncRefreshTokenFromStore(),
  primeSessionCookie: () => primeSessionCookie(),
  logout: vi.fn().mockResolvedValue(undefined),
  clearUserManager: vi.fn(),
  getUserManager: () => manager,
}));
vi.mock("@/lib/logger-client", () => ({
  clientLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
// Observe keepalive scheduling without real timers/network. computeKeepaliveDelayMs is
// mocked to a tiny delay so the timer fires within the test; pingKeepalive is a spy.
const pingKeepalive = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/oidc-keepalive", () => ({
  computeKeepaliveDelayMs: () => 1,
  pingKeepalive: () => pingKeepalive(),
}));
// Return a STABLE router object across renders — a fresh object each call would make
// the memoized handleSessionExpired/fetchSession identities churn and re-fire the init
// effect (a test artifact, not a production issue: the real Next router is stable).
const stableRouter = { push };
vi.mock("next/navigation", () => ({
  useRouter: () => stableRouter,
}));

import { AuthProvider, useAuth } from "@/contexts/auth-context";

function makeManager() {
  registeredEvents = {};
  return {
    events: {
      addUserLoaded: (cb: (...a: unknown[]) => void) => { registeredEvents.userLoaded = cb; },
      removeUserLoaded: () => { registeredEvents.userLoaded = undefined; },
      addAccessTokenExpired: (cb: (...a: unknown[]) => void) => { registeredEvents.expired = cb; },
      removeAccessTokenExpired: () => { registeredEvents.expired = undefined; },
      addAccessTokenExpiring: (cb: (...a: unknown[]) => void) => { registeredEvents.expiring = cb; },
      removeAccessTokenExpiring: () => { registeredEvents.expiring = undefined; },
      addSilentRenewError: (cb: (...a: unknown[]) => void) => { registeredEvents.renewError = cb; },
      removeSilentRenewError: () => { registeredEvents.renewError = undefined; },
    },
  };
}

// Minimal consumer so the provider's effects run.
function Consumer() {
  useAuth();
  return <div data-testid="ready" />;
}

function renderProvider() {
  return render(
    <AuthProvider>
      <Consumer />
    </AuthProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  push.mockReset();
  getOidcUser.mockResolvedValue(null);
  pingKeepalive.mockClear();
  primeSessionCookie.mockClear();
  primeSessionCookie.mockResolvedValue(undefined);
  resyncRefreshTokenFromStore.mockClear();
  resyncRefreshTokenFromStore.mockResolvedValue(false);
  manager = makeManager();
});

describe("AuthProvider session-death contract", () => {
  it("does NOT register an access-token-expired or silent-renew-error handler", async () => {
    authFetch.mockResolvedValue({ status: 200, json: async () => ({ success: false }) });

    renderProvider();

    // The only OIDC event wired is userLoaded (initial-login cookie sync).
    await waitFor(() => expect(registeredEvents.userLoaded).toBeTypeOf("function"));
    expect(registeredEvents.expired).toBeUndefined();
    expect(registeredEvents.renewError).toBeUndefined();
  });

  it("redirects to /login only after prime+retry still 401 (true session death)", async () => {
    // Both probe attempts 401 → genuinely dead → redirect. prime is called between them.
    authFetch.mockResolvedValue({ status: 401, json: async () => ({ success: false }) });

    renderProvider();

    await waitFor(() => expect(push).toHaveBeenCalledWith("/login"));
    expect(primeSessionCookie).toHaveBeenCalled(); // primed before declaring death
    // Two probe calls (initial + post-prime retry).
    expect(authFetch.mock.calls.filter((c) => c[0] === "/api/auth/session").length).toBeGreaterThanOrEqual(2);
  });

  it("does NOT redirect when a 401 is rescued by prime+retry (the iOS bfcache case)", async () => {
    // First probe 401 (cookie expired in background); after prime, middleware refreshed the
    // cookie, retry returns 200 → user stays logged in, no redirect.
    authFetch
      .mockResolvedValueOnce({ status: 401, json: async () => ({ success: false }) })
      .mockResolvedValueOnce({
        status: 200,
        json: async () => ({
          success: true,
          data: { user: { uuid: "u1", email: "a@b.c" }, company: { uuid: "c1", name: "Co" } },
        }),
      });

    renderProvider();

    await waitFor(() => expect(primeSessionCookie).toHaveBeenCalled());
    await waitFor(() => expect(authFetch.mock.calls.filter((c) => c[0] === "/api/auth/session").length).toBe(2));
    expect(push).not.toHaveBeenCalled();
  });

  it("does NOT redirect on a transient/network failure of the session fetch", async () => {
    authFetch.mockRejectedValue(new Error("network down"));

    renderProvider();

    // Give the init effect a chance to settle.
    await waitFor(() => expect(authFetch).toHaveBeenCalled());
    expect(push).not.toHaveBeenCalled();
  });

  it("does NOT redirect on a successful session (200 + success:true)", async () => {
    authFetch.mockResolvedValue({
      status: 200,
      json: async () => ({
        success: true,
        data: { user: { uuid: "u1", email: "a@b.c" }, company: { uuid: "c1", name: "Co" } },
      }),
    });

    renderProvider();

    await waitFor(() => expect(authFetch).toHaveBeenCalled());
    expect(authFetch.mock.calls[0][0]).toBe("/api/auth/session");
    expect(push).not.toHaveBeenCalled();
  });
});

describe("AuthProvider OIDC keepalive (defense-in-depth)", () => {
  it("arms the keepalive and pings when an OIDC session exists", async () => {
    authFetch.mockResolvedValue({ status: 200, json: async () => ({ success: false }) });
    // OIDC session present → keepalive should arm and (with mocked tiny delay) ping.
    getOidcUser.mockResolvedValue({ access_token: "tok", expired: false });

    renderProvider();

    await waitFor(() => expect(pingKeepalive).toHaveBeenCalled());
  });

  it("does NOT arm the keepalive for default-auth (no OIDC manager)", async () => {
    authFetch.mockResolvedValue({ status: 200, json: async () => ({ success: false }) });
    manager = null; // no OIDC manager ⇒ default-auth/superadmin
    getOidcUser.mockResolvedValue(null);

    renderProvider();

    // Let the init effect settle, then confirm no keepalive ping fired.
    await waitFor(() => expect(authFetch).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(pingKeepalive).not.toHaveBeenCalled();
  });

  it("does NOT ping when there is a manager but no OIDC user (logged out)", async () => {
    authFetch.mockResolvedValue({ status: 200, json: async () => ({ success: false }) });
    getOidcUser.mockResolvedValue(null); // manager present (default), but no user

    renderProvider();

    await waitFor(() => expect(authFetch).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(pingKeepalive).not.toHaveBeenCalled();
  });
});

describe("AuthProvider resume re-validation (iOS bfcache/visibility fix)", () => {
  it("primes + re-validates on a bfcache pageshow (persisted)", async () => {
    authFetch.mockResolvedValue({
      status: 200,
      json: async () => ({
        success: true,
        data: { user: { uuid: "u1", email: "a@b.c" }, company: { uuid: "c1", name: "Co" } },
      }),
    });

    renderProvider();
    await waitFor(() => expect(authFetch).toHaveBeenCalled());
    const probesAfterInit = authFetch.mock.calls.filter((c) => c[0] === "/api/auth/session").length;
    primeSessionCookie.mockClear();

    // Simulate iOS restoring the tab from bfcache.
    const evt = new Event("pageshow") as PageTransitionEvent;
    Object.defineProperty(evt, "persisted", { value: true });
    window.dispatchEvent(evt);

    await waitFor(() => expect(primeSessionCookie).toHaveBeenCalled());
    await waitFor(() =>
      expect(authFetch.mock.calls.filter((c) => c[0] === "/api/auth/session").length).toBeGreaterThan(probesAfterInit)
    );
  });

  it("does NOT re-validate on a non-persisted pageshow (normal load)", async () => {
    authFetch.mockResolvedValue({ status: 200, json: async () => ({ success: false }) });

    renderProvider();
    await waitFor(() => expect(authFetch).toHaveBeenCalled());
    primeSessionCookie.mockClear();

    const evt = new Event("pageshow") as PageTransitionEvent;
    Object.defineProperty(evt, "persisted", { value: false });
    window.dispatchEvent(evt);

    await new Promise((r) => setTimeout(r, 20));
    expect(primeSessionCookie).not.toHaveBeenCalled();
  });

  it("primes + re-validates when the tab becomes visible again", async () => {
    authFetch.mockResolvedValue({ status: 200, json: async () => ({ success: false }) });

    renderProvider();
    await waitFor(() => expect(authFetch).toHaveBeenCalled());
    primeSessionCookie.mockClear();

    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));

    await waitFor(() => expect(primeSessionCookie).toHaveBeenCalled());
  });

  it("coalesces the pageshow + visibilitychange burst into a single prime (in-flight guard)", async () => {
    authFetch.mockResolvedValue({ status: 200, json: async () => ({ success: false }) });

    renderProvider();
    await waitFor(() => expect(authFetch).toHaveBeenCalled());
    primeSessionCookie.mockClear();

    // iOS bfcache restore fires BOTH signals in the same sync tick. The first revalidate
    // sets the in-flight flag before its `await primeSessionCookie()` yields, so the second
    // signal's revalidate returns immediately → prime runs once, not twice.
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    const ps = new Event("pageshow") as PageTransitionEvent;
    Object.defineProperty(ps, "persisted", { value: true });
    window.dispatchEvent(ps);
    document.dispatchEvent(new Event("visibilitychange"));

    await waitFor(() => expect(primeSessionCookie).toHaveBeenCalledTimes(1));
    // Let the cycle settle and confirm the burst did not stack a second prime.
    await new Promise((r) => setTimeout(r, 20));
    expect(primeSessionCookie).toHaveBeenCalledTimes(1);
  });
});

describe("AuthProvider iOS cookie-purge recovery (resync before prime)", () => {
  it("attempts the localStorage RT resync BEFORE priming at init when the stored user is expired", async () => {
    getOidcUser.mockResolvedValue({ expired: true, access_token: "at", refresh_token: "rt" });
    authFetch.mockResolvedValue({ status: 200, json: async () => ({ success: true, data: { user: {}, company: {} } }) });
    const order: string[] = [];
    resyncRefreshTokenFromStore.mockImplementation(async () => { order.push("resync"); return true; });
    primeSessionCookie.mockImplementation(async () => { order.push("prime"); });

    renderProvider();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(order[0]).toBe("resync");
    expect(order.indexOf("prime")).toBeGreaterThan(order.indexOf("resync"));
  });

  it("resyncs before priming on resume revalidation when the stored user is expired", async () => {
    getOidcUser.mockResolvedValue({ expired: true, access_token: "at", refresh_token: "rt" });
    authFetch.mockResolvedValue({ status: 200, json: async () => ({ success: true, data: { user: {}, company: {} } }) });

    renderProvider();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    resyncRefreshTokenFromStore.mockClear();
    primeSessionCookie.mockClear();
    const order: string[] = [];
    resyncRefreshTokenFromStore.mockImplementation(async () => { order.push("resync"); return true; });
    primeSessionCookie.mockImplementation(async () => { order.push("prime"); });

    await act(async () => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    });

    expect(order[0]).toBe("resync");
    expect(order.indexOf("prime")).toBeGreaterThan(order.indexOf("resync"));
  });

  it("does not resync on resume when the stored user is fresh (cookies intact fast-path)", async () => {
    getOidcUser.mockResolvedValue({ expired: false, access_token: "at", refresh_token: "rt" });
    authFetch.mockResolvedValue({ status: 200, json: async () => ({ success: true, data: { user: {}, company: {} } }) });

    renderProvider();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    resyncRefreshTokenFromStore.mockClear();

    await act(async () => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    });

    expect(resyncRefreshTokenFromStore).not.toHaveBeenCalled();
  });
});

describe("AuthProvider last-resort recovery in the death verdict", () => {
  it("does NOT redirect when the second 401 is rescued by resync + reprobe (iOS purge race)", async () => {
    getOidcUser.mockResolvedValue(null);
    // Probe: 401, (prime), 401, [resync true], (prime), 200
    authFetch
      .mockResolvedValueOnce({ status: 401 })
      .mockResolvedValueOnce({ status: 401 })
      .mockResolvedValueOnce({ status: 200, json: async () => ({ success: true, data: { user: { uuid: "u1" }, company: {} } }) });
    resyncRefreshTokenFromStore.mockResolvedValue(true);

    renderProvider();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    expect(resyncRefreshTokenFromStore).toHaveBeenCalled();
    expect(push).not.toHaveBeenCalledWith("/login");
  });

  it("still redirects when recovery was attempted but the third probe is 401 (dead RT)", async () => {
    getOidcUser.mockResolvedValue(null);
    authFetch.mockResolvedValue({ status: 401 });
    resyncRefreshTokenFromStore.mockResolvedValue(true);

    renderProvider();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    await waitFor(() => expect(push).toHaveBeenCalledWith("/login"));
  });

  it("still redirects immediately when there is nothing to recover from (resync false)", async () => {
    getOidcUser.mockResolvedValue(null);
    authFetch.mockResolvedValue({ status: 401 });
    resyncRefreshTokenFromStore.mockResolvedValue(false);

    renderProvider();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    await waitFor(() => expect(push).toHaveBeenCalledWith("/login"));
    // Only two probes happened (401 + post-prime 401) — no third.
    expect(authFetch.mock.calls.filter((c) => c[0] === "/api/auth/session").length).toBe(2);
  });
});
