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

// Get valid access token (will trigger silent renew if needed)
export async function getAccessToken(): Promise<string | null> {
  const user = await getOidcUser();

  if (!user) return null;

  // Check if token is expired
  if (user.expired) {
    // Try silent renew
    const manager = getUserManager();
    if (manager) {
      try {
        const renewedUser = await manager.signinSilent();
        return renewedUser?.access_token || null;
      } catch {
        // Silent renew failed, user needs to re-login
        return null;
      }
    }
    return null;
  }

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

  // On 401, attempt token refresh, then retry once
  if (response.status === 401) {
    const manager = getUserManager();
    if (manager) {
      // OIDC user: try silent renew
      try {
        const renewed = await manager.signinSilent();
        if (renewed?.access_token) {
          await syncTokenToCookie(renewed.access_token);
          headers.set("Authorization", `Bearer ${renewed.access_token}`);
          return fetch(url, { ...options, headers });
        }
      } catch {
        // Silent renew failed, return original 401
      }
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
