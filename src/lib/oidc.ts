// src/lib/oidc.ts
// OIDC Client utilities using oidc-client-ts (PKCE mode)

import { UserManager, UserManagerSettings, User, WebStorageStateStore } from "oidc-client-ts";

// OIDC configuration for a company
export interface OidcConfig {
  issuer: string;
  clientId: string;
  companyUuid: string;
  companyName: string;
}

// Generate OIDC settings for UserManager
export function createOidcSettings(config: OidcConfig): UserManagerSettings {
  const baseUrl =
    typeof window !== "undefined"
      ? window.location.origin
      : process.env.NEXTAUTH_URL || "http://localhost:3000";

  // Use localStorage for persistent token storage
  const userStore = typeof window !== "undefined"
    ? new WebStorageStateStore({ store: window.localStorage })
    : undefined;

  return {
    authority: config.issuer,
    client_id: config.clientId,
    redirect_uri: `${baseUrl}/login/callback`,
    post_logout_redirect_uri: `${baseUrl}/login`,
    response_type: "code", // Authorization Code flow
    scope: "openid profile email",
    automaticSilentRenew: true, // Auto refresh tokens
    silent_redirect_uri: `${baseUrl}/login/silent-refresh`,
    accessTokenExpiringNotificationTimeInSeconds: 60, // Notify 60s before expiry
    // PKCE is enabled by default in oidc-client-ts
    // Use localStorage for user/token storage (persistent across tabs/sessions)
    userStore,
    // Extra query params to pass company context
    extraQueryParams: {
      company: config.companyUuid,
    },
  };
}

// Create UserManager instance (client-side only)
export function createUserManager(config: OidcConfig): UserManager {
  const settings = createOidcSettings(config);
  return new UserManager(settings);
}

// Store OIDC config in localStorage for persistent use
// This config is needed to recreate UserManager after page navigation
export function storeOidcConfig(config: OidcConfig): void {
  if (typeof window !== "undefined") {
    localStorage.setItem("oidc_config", JSON.stringify(config));
  }
}

// Retrieve OIDC config from localStorage
export function getStoredOidcConfig(): OidcConfig | null {
  if (typeof window === "undefined") return null;

  const stored = localStorage.getItem("oidc_config");
  if (!stored) return null;

  try {
    return JSON.parse(stored) as OidcConfig;
  } catch {
    return null;
  }
}

// Clear stored OIDC config (called on logout)
export function clearOidcConfig(): void {
  if (typeof window !== "undefined") {
    localStorage.removeItem("oidc_config");
  }
}

// Extract user info from OIDC User object
export interface OidcUserInfo {
  sub: string; // Subject identifier (unique user ID from OIDC provider)
  email?: string;
  name?: string;
  picture?: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  idToken?: string;
}

export function extractUserInfo(user: User): OidcUserInfo {
  return {
    sub: user.profile.sub,
    email: user.profile.email,
    name: user.profile.name,
    picture: user.profile.picture,
    accessToken: user.access_token,
    refreshToken: user.refresh_token,
    expiresAt: user.expires_at,
    idToken: user.id_token,
  };
}

// Server-side: Validate ID token using OIDC discovery
// This is a lightweight verification - the token was already verified by oidc-client-ts
export async function getOidcDiscoveryDocument(issuer: string) {
  const wellKnownUrl = `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`;

  const response = await fetch(wellKnownUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch OIDC discovery: ${response.statusText}`);
  }

  return response.json();
}
