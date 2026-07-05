// src/app/api/auth/sync-token/route.ts
// Receives a refreshed OIDC access token from the client and updates the HTTP-only cookie.
// Called after oidc-client-ts performs a silent token renewal on the frontend.

import { NextRequest, NextResponse } from "next/server";
import { errors } from "@/lib/api-response";
import { verifyOidcAccessToken, verifyOidcAccessTokenAllowExpired } from "@/lib/oidc-auth";
import {
  getCookieOptions,
  getMaxAgeFromJwt,
  resolveRefreshCookieMaxAge,
  REFRESH_TOKEN_COOKIE_MAX_AGE,
} from "@/lib/cookie-utils";
import { tokenFingerprint } from "@/lib/token-fingerprint";
import logger from "@/lib/logger";

const syncLogger = logger.child({ module: "sync-token" });

// POST /api/auth/sync-token
// Body: { accessToken: string, refreshToken?: string, recoverSession?: boolean }
//
// Strict mode (default): verifies the access token (must be unexpired), then updates
// the oidc_access_token cookie (+ refresh cookie when provided).
//
// Recovery mode (recoverSession: true — idea 3bf0819c): iOS purges httpOnly cookies
// from backgrounded tabs, leaving the middleware with NOTHING to refresh (silent
// no-cookie pass-through → guaranteed login bounce) even though localStorage still
// holds a live refresh token. This mode rebuilds the middleware's refresh materials
// from the localStorage copy: the access token is verified for signature/issuer with
// a bounded exp tolerance (it identifies the company — it does NOT authenticate), a
// refresh token is required, and the oidc_refresh_token + oidc_client_id +
// oidc_issuer cookies are written (client_id/issuer from server-side company config,
// never from the client). The EXPIRED access token is deliberately NOT written — the
// next middleware-covered request performs the real refresh at the IdP, which is the
// actual authentication gate; a dead refresh token still fails there and bounces.
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { accessToken, refreshToken, recoverSession } = body;

    if (!accessToken || typeof accessToken !== "string") {
      return errors.badRequest("Missing required field: accessToken");
    }

    if (recoverSession === true) {
      if (!refreshToken || typeof refreshToken !== "string") {
        return errors.badRequest("recoverSession requires refreshToken");
      }
      // Signature/issuer strictly verified; exp tolerated up to the refresh cookie's
      // own lifetime — a token staler than any possible live refresh token is useless.
      const staleAuth = await verifyOidcAccessTokenAllowExpired(accessToken, REFRESH_TOKEN_COOKIE_MAX_AGE);
      if (!staleAuth) {
        return errors.unauthorized("Invalid access token");
      }
      if (!staleAuth.clientId) {
        return errors.badRequest("Company has no OIDC client configured");
      }

      const response = NextResponse.json({ success: true, data: { recovered: true } });
      const refreshMaxAge = resolveRefreshCookieMaxAge();
      response.cookies.set("oidc_refresh_token", refreshToken, getCookieOptions(refreshMaxAge));
      response.cookies.set("oidc_client_id", staleAuth.clientId, getCookieOptions(REFRESH_TOKEN_COOKIE_MAX_AGE));
      response.cookies.set("oidc_issuer", staleAuth.issuer, getCookieOptions(REFRESH_TOKEN_COOKIE_MAX_AGE));

      syncLogger.info(
        {
          event: "sync_token",
          mode: "recover",
          incomingRtFp: await tokenFingerprint(refreshToken),
          cookieRtFp: await tokenFingerprint(request.cookies.get("oidc_refresh_token")?.value),
        },
        "Session recovery: refresh materials rebuilt from client store"
      );

      return response;
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
