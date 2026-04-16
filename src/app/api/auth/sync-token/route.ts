// src/app/api/auth/sync-token/route.ts
// Receives a refreshed OIDC access token from the client and updates the HTTP-only cookie.
// Called after oidc-client-ts performs a silent token renewal on the frontend.

import { NextRequest, NextResponse } from "next/server";
import { errors } from "@/lib/api-response";
import { verifyOidcAccessToken } from "@/lib/oidc-auth";
import { getCookieOptions, getMaxAgeFromJwt } from "@/lib/cookie-utils";
import logger from "@/lib/logger";

// POST /api/auth/sync-token
// Body: { accessToken: string }
// Verifies the token, then updates the oidc_access_token cookie
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { accessToken, refreshToken } = body;

    if (!accessToken || typeof accessToken !== "string") {
      return errors.badRequest("Missing required field: accessToken");
    }

    // Verify the token is legitimate before storing it in a cookie
    const authContext = await verifyOidcAccessToken(accessToken);
    if (!authContext) {
      return errors.unauthorized("Invalid or expired access token");
    }

    const response = NextResponse.json({ success: true });

    // Update the HTTP-only cookie with the new token
    response.cookies.set("oidc_access_token", accessToken, getCookieOptions(getMaxAgeFromJwt(accessToken)));

    // Update refresh token if provided (e.g. after token rotation)
    if (refreshToken && typeof refreshToken === "string") {
      response.cookies.set("oidc_refresh_token", refreshToken, getCookieOptions(30 * 24 * 3600));
    }

    return response;
  } catch (error) {
    logger.error({ err: error }, "Sync token error");
    return errors.internal("Failed to sync token");
  }
}
