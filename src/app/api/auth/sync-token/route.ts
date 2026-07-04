// src/app/api/auth/sync-token/route.ts
// Receives a refreshed OIDC access token from the client and updates the HTTP-only cookie.
// Called after oidc-client-ts performs a silent token renewal on the frontend.

import { NextRequest, NextResponse } from "next/server";
import { errors } from "@/lib/api-response";
import { verifyOidcAccessToken } from "@/lib/oidc-auth";
import { getCookieOptions, getMaxAgeFromJwt, resolveRefreshCookieMaxAge } from "@/lib/cookie-utils";
import { tokenFingerprint } from "@/lib/token-fingerprint";
import logger from "@/lib/logger";

const syncLogger = logger.child({ module: "sync-token" });

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

    // Diagnostics (idea 3bf0819c): this route can OVERWRITE the refresh-token cookie
    // with a client-supplied (localStorage) token. If the incoming token differs from
    // the cookie's current one, that is a potential downgrade — the localStorage copy
    // is frozen at login while the middleware may have rotated the cookie since. Log
    // fingerprints so this path is attributable when a refresh token "mysteriously"
    // dies. Fingerprints only — never token material.
    const incomingRtFp = await tokenFingerprint(
      refreshToken && typeof refreshToken === "string" ? refreshToken : undefined
    );
    const cookieRtFp = await tokenFingerprint(request.cookies.get("oidc_refresh_token")?.value);

    // Update refresh token if provided (e.g. after token rotation).
    // This token comes from the client body, not an IdP token response, so we cannot
    // observe refresh_expires_in here — use the centralized default lifetime.
    if (refreshToken && typeof refreshToken === "string") {
      response.cookies.set("oidc_refresh_token", refreshToken, getCookieOptions(resolveRefreshCookieMaxAge()));
    }

    const replacedRt = Boolean(incomingRtFp && cookieRtFp && incomingRtFp !== cookieRtFp);
    syncLogger.info(
      {
        event: "sync_token",
        incomingRtFp, // absent when the client sent no refresh token
        cookieRtFp, // absent when no refresh cookie existed
        replacedRt, // true = cookie's refresh token was OVERWRITTEN by a different one
      },
      "Token sync"
    );

    return response;
  } catch (error) {
    logger.error({ err: error }, "Sync token error");
    return errors.internal("Failed to sync token");
  }
}
