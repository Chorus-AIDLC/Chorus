// src/app/api/auth/refresh/route.ts
// Token refresh API - For SuperAdmin session only
// UUID-Based Architecture: All operations use UUIDs
//
// NOTE: Normal OIDC users do NOT use this endpoint.
// OIDC token refresh is handled entirely on the frontend by oidc-client-ts.
// This endpoint is ONLY for SuperAdmin users who use cookie-based sessions.

import { NextRequest, NextResponse } from "next/server";
import { success, errors } from "@/lib/api-response";
import {
  verifyRefreshToken,
  getRefreshTokenFromRequest,
  createUserAccessToken,
  createUserRefreshToken,
  setUserSessionCookies,
  type UserSessionPayload,
} from "@/lib/user-session";
import { getUserByUuid } from "@/services/user.service";
import logger from "@/lib/logger";

// POST /api/auth/refresh
// Refreshes the SuperAdmin session tokens (cookie-based)
export async function POST(request: NextRequest) {
  try {
    // Get refresh token from cookie
    const refreshToken = getRefreshTokenFromRequest(request);
    if (!refreshToken) {
      return errors.unauthorized("No refresh token");
    }

    // Verify refresh token
    const tokenPayload = await verifyRefreshToken(refreshToken);
    if (!tokenPayload) {
      return errors.unauthorized("Invalid refresh token");
    }

    // Get user from database (UUID-based)
    const user = await getUserByUuid(tokenPayload.userUuid);
    if (!user) {
      return errors.unauthorized("User not found");
    }

    // Create new session payload (UUID-based)
    const sessionPayload: UserSessionPayload = {
      type: "user",
      userUuid: user.uuid,
      companyUuid: user.companyUuid,
      email: user.email || "",
      name: user.name || undefined,
      oidcSub: user.oidcSub || "",
    };

    // Create new tokens
    const [newAccessToken, newRefreshToken] = await Promise.all([
      createUserAccessToken(sessionPayload),
      createUserRefreshToken(sessionPayload),
    ]);

    // Build response with cookies
    const response = NextResponse.json(
      success({
        user: {
          uuid: user.uuid,
          email: user.email,
          name: user.name,
        },
        company: {
          uuid: user.company.uuid,
          name: user.company.name,
        },
        refreshed: true,
      })
    );

    // Set new session cookies
    setUserSessionCookies(response, newAccessToken, newRefreshToken);

    return response;
  } catch (error) {
    logger.error({ err: error }, "Token refresh error");
    return errors.internal("Failed to refresh token");
  }
}
