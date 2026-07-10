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
const resyncRefreshTokenFromStore = vi.fn().mockResolvedValue(false);
const purgeDeadSession = vi.fn().mockResolvedValue(undefined);

// OIDC manager event registry captured per-test.
let registeredEvents: Record<string, ((...a: unknown[]) => void) | undefined>;
let manager: { events: Record<string, (cb: (...a: unknown[]) => void) => void> } | null;

vi.mock("@/lib/auth-client", () => ({
  authFetch: (url: string, opts?: RequestInit) => authFetch(url, opts),
  getOidcUser: () => getOidcUser(),
  resyncRefreshTokenFromStore: () => resyncRefreshTokenFromStore(),
  purgeDeadSession: () => purgeDeadSession(),
  logout: vi.fn().mockResolvedValue(undefined),
  clearUserManager: vi.fn(),
  getUserManager: () => manager,
}));
vi.mock("@/lib/logger-client", () => ({
  clientLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
// Return a STABLE router object across renders — a fresh object each call would make
// the memoized handleSessionExpired/fetchSession identities churn and re-fire the init
// effect (a test artifact, not a production issue: the real Next router is stable).
const stableRouter = { push };
vi.mock("next/navigation", () => ({
  useRouter: () => stableRouter,
}));
vi.mock("@/hooks/use-progress-router", () => ({
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
  resyncRefreshTokenFromStore.mockClear();
  resyncRefreshTokenFromStore.mockResolvedValue(false);
  purgeDeadSession.mockClear();
  manager = makeManager();
});

describe("AuthProvider session-death contract", () => {
  it("registers NO OIDC event handlers at all (middleware owns renewal; callback owns cookies)", async () => {
    authFetch.mockResolvedValue({
      status: 200,
      json: async () => ({ success: true, data: { user: { uuid: "u1" }, company: {} } }),
    });

    renderProvider();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(registeredEvents.userLoaded).toBeUndefined();
    expect(registeredEvents.expired).toBeUndefined();
    expect(registeredEvents.renewError).toBeUndefined();
  });

  it("redirects to /login only after probe+retry still 401 (true session death)", async () => {
    // Both probe attempts 401 → genuinely dead → redirect.
    authFetch.mockResolvedValue({ status: 401, json: async () => ({ success: false }) });

    renderProvider();

    await waitFor(() => expect(push).toHaveBeenCalledWith("/login"));
    // Two probe calls (initial + retry) — the covered probe IS the refresh attempt.
    expect(authFetch.mock.calls.filter((c) => c[0] === "/api/session").length).toBeGreaterThanOrEqual(2);
    // Death purges the localStorage user so /login doesn't re-attempt doomed recoveries.
    expect(purgeDeadSession).toHaveBeenCalled();
  });

  it("does NOT purge the stored user on a healthy session", async () => {
    authFetch.mockResolvedValue({
      status: 200,
      json: async () => ({ success: true, data: { user: { uuid: "u1" }, company: {} } }),
    });

    renderProvider();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(purgeDeadSession).not.toHaveBeenCalled();
  });

  it("does NOT redirect when a 401 is rescued by the retry (the iOS bfcache case)", async () => {
    // First probe 401 (cookie expired in background); the retry probe is itself
    // middleware-covered, returns 200 → user stays logged in, no redirect.
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

    await waitFor(() => expect(authFetch.mock.calls.filter((c) => c[0] === "/api/session").length).toBe(2));
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
    expect(authFetch.mock.calls[0][0]).toBe("/api/session");
    expect(push).not.toHaveBeenCalled();
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
    const probesAfterInit = authFetch.mock.calls.filter((c) => c[0] === "/api/session").length;

    // Simulate iOS restoring the tab from bfcache.
    const evt = new Event("pageshow") as PageTransitionEvent;
    Object.defineProperty(evt, "persisted", { value: true });
    window.dispatchEvent(evt);

    await waitFor(() =>
      expect(authFetch.mock.calls.filter((c) => c[0] === "/api/session").length).toBeGreaterThan(probesAfterInit)
    );
  });

  it("does NOT re-validate on a non-persisted pageshow (normal load)", async () => {
    authFetch.mockResolvedValue({ status: 200, json: async () => ({ success: false }) });

    renderProvider();
    await waitFor(() => expect(authFetch).toHaveBeenCalled());
    const probesAfterInit = authFetch.mock.calls.filter((c) => c[0] === "/api/session").length;

    const evt = new Event("pageshow") as PageTransitionEvent;
    Object.defineProperty(evt, "persisted", { value: false });
    window.dispatchEvent(evt);

    await new Promise((r) => setTimeout(r, 20));
    expect(authFetch.mock.calls.filter((c) => c[0] === "/api/session").length).toBe(probesAfterInit);
  });

  it("primes + re-validates when the tab becomes visible again", async () => {
    authFetch.mockResolvedValue({ status: 200, json: async () => ({ success: false }) });

    renderProvider();
    await waitFor(() => expect(authFetch).toHaveBeenCalled());
    const probesAfterInit = authFetch.mock.calls.filter((c) => c[0] === "/api/session").length;

    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));

    await waitFor(() =>
      expect(authFetch.mock.calls.filter((c) => c[0] === "/api/session").length).toBeGreaterThan(probesAfterInit)
    );
  });

  it("coalesces the pageshow + visibilitychange burst into a single prime (in-flight guard)", async () => {
    authFetch.mockResolvedValue({ status: 200, json: async () => ({ success: false }) });

    renderProvider();
    await waitFor(() => expect(authFetch).toHaveBeenCalled());
    const probesAfterInit = authFetch.mock.calls.filter((c) => c[0] === "/api/session").length;

    // iOS bfcache restore fires BOTH signals in the same sync tick. The first revalidate
    // sets the in-flight flag before its first await yields, so the second signal's
    // revalidate returns immediately → exactly one extra probe, not two.
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    const ps = new Event("pageshow") as PageTransitionEvent;
    Object.defineProperty(ps, "persisted", { value: true });
    window.dispatchEvent(ps);
    document.dispatchEvent(new Event("visibilitychange"));

    await waitFor(() =>
      expect(authFetch.mock.calls.filter((c) => c[0] === "/api/session").length).toBe(probesAfterInit + 1)
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(authFetch.mock.calls.filter((c) => c[0] === "/api/session").length).toBe(probesAfterInit + 1);
  });
});

describe("AuthProvider iOS cookie-purge recovery (verdict-level, single site)", () => {
  it("does NOT resync during a healthy init — recovery belongs to the verdict only", async () => {
    getOidcUser.mockResolvedValue({ expired: true, access_token: "at", refresh_token: "rt" });
    authFetch.mockResolvedValue({ status: 200, json: async () => ({ success: true, data: { user: {}, company: {} } }) });

    renderProvider();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(resyncRefreshTokenFromStore).not.toHaveBeenCalled();
  });

  it("does NOT resync on a healthy resume revalidation", async () => {
    getOidcUser.mockResolvedValue({ expired: true, access_token: "at", refresh_token: "rt" });
    authFetch.mockResolvedValue({ status: 200, json: async () => ({ success: true, data: { user: {}, company: {} } }) });

    renderProvider();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    await act(async () => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    });

    expect(resyncRefreshTokenFromStore).not.toHaveBeenCalled();
  });

  it("resyncs only AFTER the double-401, then reprobes (the purge path)", async () => {
    getOidcUser.mockResolvedValue({ expired: true, access_token: "at", refresh_token: "rt" });
    const order: string[] = [];
    authFetch
      .mockImplementationOnce(async () => { order.push("probe1"); return { status: 401 }; })
      .mockImplementationOnce(async () => { order.push("probe2"); return { status: 401 }; })
      .mockImplementationOnce(async () => {
        order.push("probe3");
        return { status: 200, json: async () => ({ success: true, data: { user: {}, company: {} } }) };
      });
    resyncRefreshTokenFromStore.mockImplementation(async () => { order.push("resync"); return true; });

    renderProvider();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    expect(order).toEqual(["probe1", "probe2", "resync", "probe3"]);
    expect(push).not.toHaveBeenCalled();
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
    expect(authFetch.mock.calls.filter((c) => c[0] === "/api/session").length).toBe(2);
  });
});
