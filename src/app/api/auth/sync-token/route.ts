// src/app/api/auth/sync-token/route.ts
// Session recovery endpoint (idea 3bf0819c) — rebuilds the middleware's refresh
// materials after iOS purges the httpOnly auth cookies from a backgrounded tab.
//
// The ONLY client→cookie write path. The client posts its localStorage OIDC pair
// (typically an EXPIRED access token + a live refresh token). The access token is
// verified for signature/issuer/token_use with a bounded exp tolerance — it
// IDENTIFIES the company, it does not authenticate anything. On success the
// oidc_refresh_token + oidc_client_id + oidc_issuer cookies are rebuilt
// (client_id/issuer from the server-side company record, never the client body) and
// the expired access token is deliberately NOT written: the next matcher-covered
// request performs the real refresh at the IdP, which is the actual authentication
// gate — a dead refresh token still fails there and the client bounces to /login.
//
// The former "strict mode" (unexpired-token cookie sync) is gone: the login
// callback route writes all cookies at login, and with silent renew disabled there
// is no post-login client-side token to sync.

import { NextRequest, NextResponse } from "next/server";
import { errors } from "@/lib/api-response";
import { verifyOidcAccessTokenAllowExpired } from "@/lib/oidc-auth";
import {
  getCookieOptions,
  resolveRefreshCookieMaxAge,
  REFRESH_TOKEN_COOKIE_MAX_AGE,
} from "@/lib/cookie-utils";
import { tokenFingerprint } from "@/lib/token-fingerprint";
import logger from "@/lib/logger";

const syncLogger = logger.child({ module: "sync-token" });

// POST /api/auth/sync-token
// Body: { accessToken: string, refreshToken: string }
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { accessToken, refreshToken } = body;

    if (!accessToken || typeof accessToken !== "string") {
      return errors.badRequest("Missing required field: accessToken");
    }
    if (!refreshToken || typeof refreshToken !== "string") {
      return errors.badRequest("Missing required field: refreshToken");
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
  } catch (error) {
    logger.error({ err: error }, "Sync token error");
    return errors.internal("Failed to sync token");
  }
}
