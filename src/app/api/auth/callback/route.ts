// src/app/api/auth/callback/route.ts
// OIDC Callback API - Registers user in database
// UUID-Based Architecture: All operations use UUIDs
// Stores OIDC access token in HTTP-only cookie for Server Actions

import { NextRequest, NextResponse } from "next/server";
import { errors } from "@/lib/api-response";
import { findOrCreateUserByOidc, getCompanyByUuid } from "@/services/user.service";

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

    // Cookie options
    // Allow disabling secure cookies via env var (for HTTP-only deployments)
    const forceInsecure = process.env.COOKIE_SECURE === "false";
    const isProduction = process.env.NODE_ENV === "production" && !forceInsecure;
    const cookieBase = {
      httpOnly: true,
      secure: isProduction,
      sameSite: "lax" as const,
      path: "/",
    };

    // Store access token in HTTP-only cookie for Server Actions
    if (accessToken) {
      response.cookies.set("oidc_access_token", accessToken, {
        ...cookieBase,
        maxAge: 3600, // 1 hour (OIDC tokens typically expire in 1 hour)
      });
    }

    // Store refresh token for server-side token refresh (middleware)
    if (refreshToken) {
      response.cookies.set("oidc_refresh_token", refreshToken, {
        ...cookieBase,
        maxAge: 30 * 24 * 3600, // 30 days
      });
    }

    // Store client_id and issuer for server-side token refresh (middleware)
    if (company.oidcClientId) {
      response.cookies.set("oidc_client_id", company.oidcClientId, {
        ...cookieBase,
        maxAge: 30 * 24 * 3600, // 30 days
      });
    }
    if (company.oidcIssuer) {
      response.cookies.set("oidc_issuer", company.oidcIssuer, {
        ...cookieBase,
        maxAge: 30 * 24 * 3600, // 30 days
      });
    }

    return response;
  } catch (error) {
    console.error("OIDC callback error:", error);
    return errors.internal("Failed to process OIDC callback");
  }
}
