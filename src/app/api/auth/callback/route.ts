// src/app/api/auth/callback/route.ts
// OIDC Callback API - Registers user in database
// UUID-Based Architecture: All operations use UUIDs
// Stores OIDC access token in HTTP-only cookie for Server Actions

import { NextRequest, NextResponse } from "next/server";
import { errors } from "@/lib/api-response";
import { findOrCreateUserByOidc, getCompanyByUuid } from "@/services/user.service";
import { getCookieOptions, getMaxAgeFromJwt, resolveRefreshCookieMaxAge, REFRESH_TOKEN_COOKIE_MAX_AGE } from "@/lib/cookie-utils";
import { tokenFingerprint } from "@/lib/token-fingerprint";
import logger from "@/lib/logger";

const callbackLogger = logger.child({ module: "oidc-callback" });

// POST /api/auth/callback
// Body: { companyUuid, oidcSub, email, name?, accessToken }
// Creates or updates user in database after OIDC login
// Stores access token in HTTP-only cookie for Server Actions
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { companyUuid, oidcSub, email, name, accessToken, refreshToken } = body;

    // Validate required fields
    if (!companyUuid || !oidcSub || !email) {
      return errors.badRequest("Missing required fields: companyUuid, oidcSub, email");
    }

    // Get company
    const company = await getCompanyByUuid(companyUuid);
    if (!company) {
      return errors.notFound("Company not found");
    }

    if (!company.oidcEnabled) {
      return errors.badRequest("OIDC is not enabled for this company");
    }

    // Find or create user in database (UUID-based)
    const user = await findOrCreateUserByOidc({
      oidcSub,
      email,
      name,
      companyUuid: company.uuid,
    });

    // Create response with user info
    const response = NextResponse.json({
      success: true,
      data: {
        user: {
          uuid: user.uuid,
          email: user.email,
          name: user.name,
        },
        company: {
          uuid: company.uuid,
          name: company.name,
        },
      },
    });

    // Store access token in HTTP-only cookie for Server Actions
    if (accessToken) {
      response.cookies.set("oidc_access_token", accessToken, getCookieOptions(getMaxAgeFromJwt(accessToken)));
    }

    // Store refresh token for server-side token refresh (middleware). This token comes
    // from the client body (oidc-client-ts), not a server-side IdP token response, so
    // refresh_expires_in is not observable here — use the centralized default lifetime.
    if (refreshToken && typeof refreshToken === "string") {
      response.cookies.set("oidc_refresh_token", refreshToken, getCookieOptions(resolveRefreshCookieMaxAge()));
    }

    // Store client_id and issuer for server-side token refresh (middleware). These
    // config cookies must live at least as long as the refresh token (the middleware
    // needs them to perform a refresh), so they share its centralized lifetime.
    if (company.oidcClientId) {
      response.cookies.set("oidc_client_id", company.oidcClientId, getCookieOptions(REFRESH_TOKEN_COOKIE_MAX_AGE));
    }
    if (company.oidcIssuer) {
      response.cookies.set("oidc_issuer", company.oidcIssuer, getCookieOptions(REFRESH_TOKEN_COOKIE_MAX_AGE));
    }

    // Diagnostics (idea 3bf0819c): record the refresh token's fingerprint at BIRTH so
    // its lineage is traceable through middleware oidc_refresh / sync_token log lines.
    // Fingerprints only — never token material.
    callbackLogger.info(
      {
        event: "login_tokens_issued",
        rtFp: await tokenFingerprint(refreshToken && typeof refreshToken === "string" ? refreshToken : undefined),
        userUuid: user.uuid,
      },
      "OIDC login tokens issued"
    );

    return response;
  } catch (error) {
    logger.error({ err: error }, "OIDC callback error");
    return errors.internal("Failed to process OIDC callback");
  }
}
