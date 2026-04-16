// src/app/api/auth/me/route.ts
// Get current user info from our JWT session token
// UUID-Based Architecture: All operations use UUIDs

import { NextRequest } from "next/server";
import { success, errors } from "@/lib/api-response";
import { prisma } from "@/lib/prisma";
import logger from "@/lib/logger";

// Decode JWT without verification (just to extract claims)
function decodeJwt(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    return payload;
  } catch {
    return null;
  }
}

// GET /api/auth/me
export async function GET(request: NextRequest) {
  try {
    // Extract Bearer token
    const authHeader = request.headers.get("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return errors.unauthorized("Missing or invalid authorization header");
    }

    const token = authHeader.slice(7);

    // Decode the JWT to get user info
    const payload = decodeJwt(token);
    if (!payload) {
      return errors.unauthorized("Invalid token format");
    }

    // Our JWT format has: userUuid, companyUuid, email, oidcSub, etc.
    // Also support raw OIDC tokens which have: sub, email
    const userUuid = payload.userUuid as string | undefined;
    const companyUuid = payload.companyUuid as string | undefined;
    const oidcSub = (payload.oidcSub || payload.sub) as string | undefined;

    if (!userUuid && !oidcSub) {
      return errors.unauthorized("Token missing user identifier");
    }

    // Find user - prefer userUuid, fallback to oidcSub+companyUuid
    const user = await prisma.user.findFirst({
      where: userUuid
        ? { uuid: userUuid }
        : { oidcSub, ...(companyUuid ? { companyUuid } : {}) },
      select: {
        uuid: true,
        email: true,
        name: true,
        companyUuid: true,
        company: {
          select: {
            uuid: true,
            name: true,
          },
        },
      },
    });

    if (!user) {
      return errors.unauthorized("User not found");
    }

    return success({
      user: {
        uuid: user.uuid,
        email: user.email,
        name: user.name,
      },
      company: user.company,
    });
  } catch (error) {
    logger.error({ err: error }, "Auth me error");
    return errors.internal("Failed to get user info");
  }
}
