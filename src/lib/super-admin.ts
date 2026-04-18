// src/lib/super-admin.ts
// Super Admin Authentication Utilities

import { SignJWT, jwtVerify } from "jose";
import bcrypt from "bcryptjs";
import { NextRequest, NextResponse } from "next/server";
import { SuperAdminAuthContext } from "@/types/auth";
import { getCookieOptions } from "@/lib/cookie-utils";
import logger from "@/lib/logger";

const COOKIE_NAME = "admin_session";
const TOKEN_EXPIRY = "24h";

// Get JWT signing secret
function getSecret(): Uint8Array {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) {
    throw new Error("NEXTAUTH_SECRET is not set");
  }
  return new TextEncoder().encode(secret);
}

// Check if email is Super Admin
export function isSuperAdminEmail(email: string): boolean {
  const superAdminEmail = process.env.SUPER_ADMIN_EMAIL;
  if (!superAdminEmail) {
    return false;
  }
  return email.toLowerCase() === superAdminEmail.toLowerCase();
}

// Verify Super Admin password
export async function verifySuperAdminPassword(
  password: string
): Promise<boolean> {
  const passwordHash = process.env.SUPER_ADMIN_PASSWORD_HASH;
  if (!passwordHash) {
    logger.error("SUPER_ADMIN_PASSWORD_HASH is not set");
    return false;
  }
  try {
    return await bcrypt.compare(password, passwordHash);
  } catch (error) {
    logger.error({ err: error }, "Password verification error");
    return false;
  }
}

// Create Admin JWT Token
export async function createAdminToken(): Promise<string> {
  const email = process.env.SUPER_ADMIN_EMAIL;
  if (!email) {
    throw new Error("SUPER_ADMIN_EMAIL is not set");
  }

  return new SignJWT({ type: "super_admin", email })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(TOKEN_EXPIRY)
    .sign(getSecret());
}

// Verify Admin JWT Token
export async function verifyAdminToken(
  token: string
): Promise<SuperAdminAuthContext | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret());
    if (payload.type === "super_admin" && typeof payload.email === "string") {
      return {
        type: "super_admin",
        email: payload.email,
      };
    }
    return null;
  } catch {
    return null;
  }
}

// Get Super Admin auth context from request
export async function getSuperAdminFromRequest(
  request: NextRequest
): Promise<SuperAdminAuthContext | null> {
  const token = request.cookies.get(COOKIE_NAME)?.value;
  if (!token) {
    return null;
  }
  return verifyAdminToken(token);
}

// Set Admin Cookie
export function setAdminCookie(response: NextResponse, token: string): void {
  response.cookies.set(COOKIE_NAME, token, getCookieOptions(60 * 60 * 24));
}

// Clear Admin Cookie
export function clearAdminCookie(response: NextResponse): void {
  response.cookies.set(COOKIE_NAME, "", getCookieOptions(0));
}

// Get Cookie name (for client-side checks)
export function getAdminCookieName(): string {
  return COOKIE_NAME;
}
