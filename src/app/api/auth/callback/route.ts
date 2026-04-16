// src/app/api/auth/callback/route.ts
// OIDC Callback API - Registers user in database
// UUID-Based Architecture: All operations use UUIDs
// Stores OIDC access token in HTTP-only cookie for Server Actions

import { NextRequest, NextResponse } from "next/server";
import { errors } from "@/lib/api-response";
import { findOrCreateUserByOidc, getCompanyByUuid } from "@/services/user.service";
import { getCookieOptions, getMaxAgeFromJwt } from "@/lib/cookie-utils";
import logger from "@/lib/logger";

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

    // Store refresh token for server-side token refresh (middleware)
    if (refreshToken) {
      response.cookies.set("oidc_refresh_token", refreshToken, getCookieOptions(30 * 24 * 3600));
    }

    // Store client_id and issuer for server-side token refresh (middleware)
    if (company.oidcClientId) {
      response.cookies.set("oidc_client_id", company.oidcClientId, getCookieOptions(30 * 24 * 3600));
    }
    if (company.oidcIssuer) {
      response.cookies.set("oidc_issuer", company.oidcIssuer, getCookieOptions(30 * 24 * 3600));
    }

    return response;
  } catch (error) {
    logger.error({ err: error }, "OIDC callback error");
    return errors.internal("Failed to process OIDC callback");
  }
}
