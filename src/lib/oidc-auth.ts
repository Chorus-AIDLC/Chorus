// src/lib/oidc-auth.ts
// OIDC Access Token verification for backend API authentication
// Uses Cognito JWKS to verify JWT tokens

import { createRemoteJWKSet, jwtVerify, JWTPayload } from "jose";
import { prisma } from "./prisma";
import { UserAuthContext } from "@/types/auth";
import logger from "@/lib/logger";

// Cache for JWKS
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

// Get JWKS for an issuer
function getJwks(issuer: string) {
  if (!jwksCache.has(issuer)) {
    // Properly construct JWKS URL by appending to the issuer path
    // (not using relative URL which would resolve from host root)
    const jwksUrl = new URL(`${issuer.replace(/\/$/, '')}/.well-known/jwks.json`);
    jwksCache.set(issuer, createRemoteJWKSet(jwksUrl));
  }
  return jwksCache.get(issuer)!;
}

// OIDC token payload
export interface OidcTokenPayload extends JWTPayload {
  sub: string;
  email?: string;
  name?: string;
  "cognito:username"?: string;
  token_use?: string;
}

// Verify OIDC access token and return user context
export async function verifyOidcAccessToken(
  token: string
): Promise<UserAuthContext | null> {
  try {
    // First, decode the token to get the issuer (without verification)
    const parts = token.split(".");
    if (parts.length !== 3) return null;

    const payloadJson = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf-8")
    );
    const issuer = payloadJson.iss;

    if (!issuer) return null;

    // Get JWKS and verify the token
    const jwks = getJwks(issuer);
    const { payload } = await jwtVerify(token, jwks, {
      issuer,
    });

    const oidcPayload = payload as OidcTokenPayload;

    // Must be an access token (not id token)
    if (oidcPayload.token_use && oidcPayload.token_use !== "access") {
      return null;
    }

    // Find company by OIDC issuer
    const company = await prisma.company.findFirst({
      where: {
        oidcEnabled: true,
        oidcIssuer: issuer,
      },
    });

    if (!company) {
      return null;
    }

    // Find user by OIDC sub
    const user = await prisma.user.findFirst({
      where: {
        companyUuid: company.uuid,
        oidcSub: oidcPayload.sub,
      },
    });

    if (!user) {
      // User not found - they need to complete registration first
      return null;
    }

    return {
      type: "user",
      companyUuid: company.uuid,
      actorUuid: user.uuid,
      email: user.email || oidcPayload.email,
      name: user.name || oidcPayload.name,
    };
  } catch (error) {
    // Token verification failed
    logger.error({ err: error }, "OIDC token verification failed");
    return null;
  }
}

// Check if a token looks like an OIDC JWT (for routing purposes)
export function isOidcToken(token: string): boolean {
  // OIDC tokens are JWTs, API keys start with "cho_"
  if (token.startsWith("cho_")) return false;

  // Check if it's a valid JWT structure
  const parts = token.split(".");
  if (parts.length !== 3) return false;

  try {
    // Try to decode the header
    const header = JSON.parse(
      Buffer.from(parts[0], "base64url").toString("utf-8")
    );
    // OIDC tokens typically have RS256 or RS384 algorithm
    return header.alg && (header.alg.startsWith("RS") || header.alg.startsWith("ES"));
  } catch {
    return false;
  }
}
