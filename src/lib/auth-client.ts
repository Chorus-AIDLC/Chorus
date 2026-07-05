// src/lib/auth-client.ts
// Client-side auth utilities for OIDC token management
// Uses oidc-client-ts UserManager for token storage and refresh

import { UserManager, User } from "oidc-client-ts";
import { createUserManager, getStoredOidcConfig, storeOidcConfig, clearOidcConfig, type OidcConfig } from "./oidc";
import { clientLogger } from "@/lib/logger-client";

// Singleton UserManager instance
let userManager: UserManager | null = null;

// Get or create UserManager
export function getUserManager(): UserManager | null {
  if (typeof window === "undefined") return null;

  if (!userManager) {
    const config = getStoredOidcConfig();
    if (config) {
      userManager = createUserManager(config);
    }
  }
  return userManager;
}

// Initialize UserManager with config
export function initUserManager(config: OidcConfig): UserManager {
  storeOidcConfig(config);
  userManager = createUserManager(config);
  return userManager;
}

// Clear UserManager (on logout)
export function clearUserManager(): void {
  userManager = null;
}

// Get current user from UserManager
export async function getOidcUser(): Promise<User | null> {
  const manager = getUserManager();
  if (!manager) return null;

  try {
    return await manager.getUser();
  } catch {
    return null;
  }
}

// Get the current OIDC access token, if any.
//
// The frontend does NOT renew the token here. Renewal is owned solely by the Edge
// middleware (cookie path) — see src/middleware.ts and src/lib/oidc.ts. If the token
// is expired we still return it: the request is sent with the (stale) Bearer header,
// the middleware refreshes the `oidc_access_token` cookie for that same request, and
// getAuthContext (src/lib/auth.ts) falls through from the expired Bearer token to the
// freshly-refreshed cookie. Calling signinSilent() here would make the frontend a
// second consumer of the rotating refresh token and reintroduce the invalid_grant race.
export async function getAccessToken(): Promise<string | null> {
  const user = await getOidcUser();

  if (!user) return null;

  return user.access_token;
}

// Check if user is authenticated
export async function isAuthenticated(): Promise<boolean> {
  const user = await getOidcUser();
  return user !== null && !user.expired;
}

// Sync a new access token (and optionally refresh token) to HTTP-only cookies via the server endpoint
export async function syncTokenToCookie(accessToken: string, refreshToken?: string): Promise<boolean> {
  try {
    const response = await fetch("/api/auth/sync-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accessToken, refreshToken }),
    });
    return response.ok;
  } catch {
    clientLogger.error("Failed to sync token to cookie");
    return false;
  }
}

// Session recovery after an iOS cookie purge (idea 3bf0819c).
//
// iOS Safari can purge ALL httpOnly auth cookies from a backgrounded tab, leaving the
// middleware nothing to refresh — a guaranteed bounce — while oidc-client-ts's
// localStorage user still holds a live refresh token (its ACCESS token is typically
// expired by then, so the strict sync path won't run). This posts the stored pair in
// `recoverSession` mode: the server verifies the access token's signature (bounded exp
// tolerance; it identifies the company, it does not authenticate) and rebuilds the
// refresh-materials cookies. The REAL authentication still happens when the middleware
// exchanges the refresh token at the IdP on the next covered request — a dead refresh
// token still bounces via the existing double-401 path.
//
// Returns true when a recovery request was made and accepted; false when there is
// nothing to recover from (no stored user / no refresh token) or the server declined.
export async function resyncRefreshTokenFromStore(): Promise<boolean> {
  const user = await getOidcUser();
  if (!user?.refresh_token || !user.access_token) return false;
  try {
    const response = await fetch("/api/auth/sync-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accessToken: user.access_token,
        refreshToken: user.refresh_token,
        recoverSession: true,
      }),
    });
    return response.ok;
  } catch {
    // Best-effort — the subsequent prime/probe path decides the outcome either way.
    return false;
  }
}

// Create authenticated fetch wrapper
export async function authFetch(
  url: string,
  options: RequestInit = {}
): Promise<Response> {
  const token = await getAccessToken();

  const headers = new Headers(options.headers);

  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  const response = await fetch(url, {
    ...options,
    headers,
  });

  // On 401: OIDC users rely on the middleware-refreshed cookie (no retry here);
  // default-auth users get one cookie-based refresh + retry.
  if (response.status === 401) {
    const manager = getUserManager();
    if (manager) {
      // OIDC user: do NOT silent-renew here. Renewal is owned by the Edge middleware,
      // which already had its chance to refresh the cookie on this same request before
      // it reached the route. A 401 that survives the middleware means the refresh
      // token is genuinely expired/revoked — a true session-death condition. Surface
      // the 401 so the single redirect site (auth-context) handles re-login. Calling
      // signinSilent() here would re-race the rotating refresh token.
    } else {
      // Default auth user: refresh via cookie-based refresh token
      try {
        const refreshRes = await fetch("/api/auth/refresh", { method: "POST" });
        if (refreshRes.ok) {
          // Refresh succeeded — cookies are updated, retry without Bearer header
          headers.delete("Authorization");
          return fetch(url, { ...options, headers });
        }
      } catch {
        // Refresh failed, return original 401
      }
    }
  }

  return response;
}

// Create fetch hook for SWR or React Query
export function createAuthFetcher() {
  return async (url: string) => {
    const response = await authFetch(url);
    if (!response.ok) {
      const error = new Error("Fetch failed");
      throw error;
    }
    return response.json();
  };
}

// Login redirect
export async function login(): Promise<void> {
  const manager = getUserManager();
  if (manager) {
    await manager.signinRedirect();
  }
}

// Logout — clears local session only. Does NOT call OIDC end_session;
// the user keeps their IdP session and next login can SSO back in silently.
export async function logout(): Promise<void> {
  try {
    await fetch("/api/auth/logout", { method: "POST" });
  } catch {
    // Ignore errors, continue with local cleanup
  }

  const manager = getUserManager();
  if (manager) {
    try {
      await manager.removeUser();
    } catch {
      // Ignore
    }
  }
  clearUserManager();
  clearOidcConfig();
}
