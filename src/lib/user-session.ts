// src/lib/user-session.ts
// Default-auth (`user_session`) JWT session management. UUID-based.
//
// The session is a single self-signed JWT cookie. There is NO refresh-token arm:
// the default-login route mints a long-lived token directly (local dev gets 365d),
// and expiry simply routes through the client probe's normal re-login path. (A
// user_refresh cookie + refresh plumbing existed here historically but had no
// producer anywhere — the whole arm was verified unreachable and deleted in the
// auth slim-down, idea 3bf0819c.)

import { SignJWT, jwtVerify } from "jose";
import { NextRequest, NextResponse } from "next/server";
import { UserAuthContext } from "@/types/auth";
import { getCookieOptions } from "@/lib/cookie-utils";

const COOKIE_NAME = "user_session";
export const ACCESS_TOKEN_EXPIRY = "1h"; // Access token expiry
export const ACCESS_TOKEN_MAX_AGE = 60 * 60; // Cookie maxAge in seconds — must match ACCESS_TOKEN_EXPIRY
// Legacy cookie name — only cleared on logout (its producer was deleted).
const REFRESH_COOKIE_NAME = "user_refresh";

// Get JWT signing secret
function getSecret(): Uint8Array {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) {
    throw new Error("NEXTAUTH_SECRET is not set");
  }
  return new TextEncoder().encode(secret);
}

// User session payload stored in JWT (UUID-based)
export interface UserSessionPayload {
  type: "user";
  userUuid: string;
  companyUuid: string;
  email: string;
  name?: string;
  oidcSub: string;
  // OIDC tokens for external API calls
  oidcAccessToken?: string;
  oidcRefreshToken?: string;
  oidcExpiresAt?: number;
}

// Create user access token (short-lived by default, overridable for local dev)
export async function createUserAccessToken(
  payload: UserSessionPayload,
  expiresIn: string = ACCESS_TOKEN_EXPIRY
): Promise<string> {
  return new SignJWT({
    ...payload,
    tokenType: "access",
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(getSecret());
}

// Verify access token
export async function verifyAccessToken(
  token: string
): Promise<UserSessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret());
    if (payload.type === "user" && payload.tokenType === "access") {
      return {
        type: "user",
        userUuid: payload.userUuid as string,
        companyUuid: payload.companyUuid as string,
        email: payload.email as string,
        name: payload.name as string | undefined,
        oidcSub: payload.oidcSub as string,
        oidcAccessToken: payload.oidcAccessToken as string | undefined,
        oidcRefreshToken: payload.oidcRefreshToken as string | undefined,
        oidcExpiresAt: payload.oidcExpiresAt as number | undefined,
      };
    }
    return null;
  } catch {
    return null;
  }
}

// Get user session from request (Bearer token or cookies) - UUID-based
export async function getUserSessionFromRequest(
  request: NextRequest
): Promise<UserAuthContext | null> {
  // 1. Try Bearer token from Authorization header first (external integrations;
  //    the browser is cookie-only)
  const authHeader = request.headers.get("authorization");
  const match = authHeader?.match(/^Bearer\s+(.+)$/i);
  const bearerToken = match ? match[1] : null;

  if (bearerToken) {
    const payload = await verifyAccessToken(bearerToken);
    if (payload) {
      return {
        type: "user",
        companyUuid: payload.companyUuid,
        actorUuid: payload.userUuid,
        email: payload.email,
        name: payload.name,
      };
    }
  }

  // 2. Fallback to cookie
  const cookieToken = request.cookies.get(COOKIE_NAME)?.value;
  if (!cookieToken) {
    return null;
  }

  const payload = await verifyAccessToken(cookieToken);
  if (!payload) {
    return null;
  }

  return {
    type: "user",
    companyUuid: payload.companyUuid,
    actorUuid: payload.userUuid,
    email: payload.email,
    name: payload.name,
  };
}

// Clear user session cookies (also expires the legacy user_refresh cookie)
export function clearUserSessionCookies(response: NextResponse): void {
  response.cookies.set(COOKIE_NAME, "", getCookieOptions(0));

  response.cookies.set(REFRESH_COOKIE_NAME, "", getCookieOptions(0));
}
