// src/lib/auth-client.ts
// Client-side auth utilities for OIDC token management
// Uses oidc-client-ts UserManager for token storage and refresh

import { UserManager, User } from "oidc-client-ts";
import { createUserManager, getStoredOidcConfig, storeOidcConfig, clearOidcConfig, type OidcConfig } from "./oidc";

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

// Session recovery after an iOS cookie purge (idea 3bf0819c).
//
// iOS Safari can purge ALL httpOnly auth cookies from a backgrounded tab, leaving the
// middleware nothing to refresh — a guaranteed bounce — while oidc-client-ts's
// localStorage user still holds a live refresh token (its ACCESS token is typically
// expired by then). The server verifies the access token's signature (bounded exp
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
      }),
    });
    return response.ok;
  } catch {
    // Best-effort — the subsequent prime/probe path decides the outcome either way.
    return false;
  }
}

// Authenticated fetch — cookie-based.
//
// The browser authenticates with COOKIES only, for every login mode. The Edge
// middleware is the single renewal authority: any matcher-covered request (including
// these) gets an expiring/expired access cookie refreshed before the route runs, and
// getAuthContext resolves the cookie. No Bearer header is attached — the localStorage
// OIDC token is frozen at login and would only ever be a stale duplicate of what the
// cookie already proves (SSE, which cannot send headers, has always worked this way).
// A 401 here means the middleware could not refresh; the caller's probe/verdict logic
// (auth-context fetchSession) owns retry, recovery, and the re-login decision.
export async function authFetch(
  url: string,
  options: RequestInit = {}
): Promise<Response> {
  return fetch(url, { ...options, credentials: "same-origin" });
}

// Purge the dead session's client-side traces (localStorage OIDC user + manager).
//
// Called when the probe verdict declares session death: the stored refresh token has
// PROVEN dead (the verdict's recovery attempt already failed at the IdP), so keeping
// the localStorage user only makes every future /login visit re-attempt a doomed
// recovery (one sync-token POST + one failed IdP round-trip of pure log noise).
// Unlike logout(), no server call — there is nothing left to log out of.
export async function purgeDeadSession(): Promise<void> {
  const manager = getUserManager();
  if (manager) {
    try {
      await manager.removeUser();
    } catch {
      // Ignore — clearing the manager below still detaches the stored user.
    }
  }
  clearUserManager();
  clearOidcConfig();
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
