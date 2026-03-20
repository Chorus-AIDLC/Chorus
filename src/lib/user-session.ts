// src/lib/user-session.ts
// User session management for OIDC-authenticated users
// UUID-Based Architecture: All IDs are UUIDs

import { SignJWT, jwtVerify } from "jose";
import { NextRequest, NextResponse } from "next/server";
import { UserAuthContext } from "@/types/auth";
import { getCookieOptions } from "@/lib/cookie-utils";

const COOKIE_NAME = "user_session";
export const ACCESS_TOKEN_EXPIRY = "1h"; // Access token expiry
export const ACCESS_TOKEN_MAX_AGE = 60 * 60; // Cookie maxAge in seconds — must match ACCESS_TOKEN_EXPIRY
const REFRESH_TOKEN_EXPIRY = "7d"; // Long-lived refresh token
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

// Create user refresh token (long-lived)
export async function createUserRefreshToken(
  payload: UserSessionPayload
): Promise<string> {
  return new SignJWT({
    userUuid: payload.userUuid,
    companyUuid: payload.companyUuid,
    tokenType: "refresh",
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(REFRESH_TOKEN_EXPIRY)
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

// Verify refresh token (returns minimal payload for token refresh)
export async function verifyRefreshToken(token: string): Promise<{
  userUuid: string;
  companyUuid: string;
} | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret());
    if (payload.tokenType === "refresh") {
      return {
        userUuid: payload.userUuid as string,
        companyUuid: payload.companyUuid as string,
      };
    }
    return null;
  } catch {
    return null;
  }
}

// Extract Bearer token from Authorization header
export function extractBearerToken(authHeader: string | null): string | null {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

// Get user session from request (Bearer token or cookies) - UUID-based
export async function getUserSessionFromRequest(
  request: NextRequest
): Promise<UserAuthContext | null> {
  // 1. Try Bearer token from Authorization header first
  const authHeader = request.headers.get("authorization");
  const bearerToken = extractBearerToken(authHeader);

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

// Get full session payload (including OIDC tokens) from request
export async function getFullSessionFromRequest(
  request: NextRequest
): Promise<UserSessionPayload | null> {
  const token = request.cookies.get(COOKIE_NAME)?.value;
  if (!token) {
    return null;
  }
  return verifyAccessToken(token);
}

// Set user session cookies
export function setUserSessionCookies(
  response: NextResponse,
  accessToken: string,
  refreshToken: string,
  accessTokenMaxAge: number = ACCESS_TOKEN_MAX_AGE
): void {
  response.cookies.set(COOKIE_NAME, accessToken, getCookieOptions(accessTokenMaxAge));

  // Refresh token cookie (long-lived)
  response.cookies.set(REFRESH_COOKIE_NAME, refreshToken, getCookieOptions(7 * 24 * 60 * 60));
}

// Clear user session cookies
export function clearUserSessionCookies(response: NextResponse): void {
  response.cookies.set(COOKIE_NAME, "", getCookieOptions(0));

  response.cookies.set(REFRESH_COOKIE_NAME, "", getCookieOptions(0));
}

// Get refresh token from request
export function getRefreshTokenFromRequest(request: NextRequest): string | null {
  return request.cookies.get(REFRESH_COOKIE_NAME)?.value || null;
}

// Cookie names for client-side reference
export const USER_SESSION_COOKIE = COOKIE_NAME;
export const USER_REFRESH_COOKIE = REFRESH_COOKIE_NAME;
