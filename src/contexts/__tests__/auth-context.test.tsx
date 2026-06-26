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
import { render, waitFor } from "@testing-library/react";

const authFetch = vi.fn();
const push = vi.fn();
const getOidcUser = vi.fn().mockResolvedValue(null);

// OIDC manager event registry captured per-test.
let registeredEvents: Record<string, ((...a: unknown[]) => void) | undefined>;
let manager: { events: Record<string, (cb: (...a: unknown[]) => void) => void> } | null;

vi.mock("@/lib/auth-client", () => ({
  authFetch: (url: string, opts?: RequestInit) => authFetch(url, opts),
  getOidcUser: () => getOidcUser(),
  syncTokenToCookie: vi.fn().mockResolvedValue(true),
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

  it("redirects to /login on a true 401 from the session fetch", async () => {
    authFetch.mockResolvedValue({ status: 401, json: async () => ({ success: false }) });

    renderProvider();

    await waitFor(() => expect(push).toHaveBeenCalledWith("/login"));
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
