// src/lib/auth-server.ts
// Server-side auth utilities for Server Components and Server Actions
// Reads auth token from HTTP-only cookies (OIDC or default auth JWT)

import { cookies } from "next/headers";
import { verifyOidcAccessToken } from "./oidc-auth";
import { verifyAccessToken, resolveUserSession } from "./user-session";
import type { UserAuthContext } from "@/types/auth";

/**
 * Get auth context from HTTP-only cookie
 * Use this in Server Components and Server Actions
 * Supports both OIDC (oidc_access_token) and default auth (user_session) cookies
 */
export async function getServerAuthContext(): Promise<UserAuthContext | null> {
  const cookieStore = await cookies();

  // 1. Try OIDC access token cookie
  const oidcToken = cookieStore.get("oidc_access_token")?.value;
  if (oidcToken) {
    return verifyOidcAccessToken(oidcToken);
  }

  // 2. Try default auth JWT cookie (user_session)
  const userSessionToken = cookieStore.get("user_session")?.value;
  if (userSessionToken) {
    const payload = await verifyAccessToken(userSessionToken);
    if (payload) {
      return resolveUserSession(payload);
    }
  }

  return null;
}
