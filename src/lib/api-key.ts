// src/lib/api-key.ts
// API Key Validation (ARCHITECTURE.md §6.2, §9.1)
// UUID-Based Architecture: All IDs are UUIDs

import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { prisma } from "./prisma";
import type { ApiKeyValidationResult } from "@/types/auth";
import logger from "@/lib/logger";
import { getUserAccountState } from "@/services/local-user.service";
import { rememberStreamCredential } from "@/lib/stream-credentials";

// API Key prefix
const KEY_PREFIX = "cho_";

// Generate new API Key
export function generateApiKey(): { key: string; hash: string; prefix: string } {
  // Generate 32 bytes of random data
  const randomPart = randomBytes(32).toString("base64url");
  const key = `${KEY_PREFIX}${randomPart}`;

  // Store using SHA-256 hash
  const hash = hashApiKey(key);

  // Prefix for display (e.g. "cho_abc...xyz")
  const prefix = `${KEY_PREFIX}${randomPart.slice(0, 4)}...${randomPart.slice(-4)}`;

  return { key, hash, prefix };
}

// Hash API Key
export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

// Extract API Key from Authorization header
export function extractApiKey(authHeader: string | null): string | null {
  if (!authHeader) return null;

  // Support "Bearer <key>" format
  if (authHeader.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }

  // Also support passing key directly
  if (authHeader.startsWith(KEY_PREFIX)) {
    return authHeader;
  }

  return null;
}

// Validate API Key (UUID-based)
export async function validateApiKey(
  key: string,
  options: { trackUsage?: boolean } = {},
): Promise<ApiKeyValidationResult> {
  try {
    // Check format
    if (!key.startsWith(KEY_PREFIX)) {
      return { valid: false, error: "Invalid API key format" };
    }

    // Compute hash
    const keyHash = hashApiKey(key);

    // Find API Key - using uuid references
    const apiKey = await prisma.apiKey.findUnique({
      where: { keyHash },
      include: {
        agent: true,
      },
    });

    // Key not found
    if (!apiKey) {
      return { valid: false, error: "API key not found" };
    }

    // Check if revoked
    if (apiKey.revokedAt) {
      return { valid: false, error: "API key has been revoked" };
    }

    // Check if expired
    if (apiKey.expiresAt && apiKey.expiresAt < new Date()) {
      return { valid: false, error: "API key has expired" };
    }

    if (apiKey.agent.ownerUuid) {
      const owner = await getUserAccountState(apiKey.agent.companyUuid, apiKey.agent.ownerUuid);
      if (!owner || owner.companyUuid !== apiKey.agent.companyUuid || owner.deletedAt || owner.status !== "active" ||
          (owner.authType === "local" && (!owner.company.localAuthEnabled || owner.company.oidcEnabled))) {
        return { valid: false, error: "Agent owner is not eligible" };
      }
    }

    // Update last used time (async, fire-and-forget) - use uuid
    if (options.trackUsage !== false) prisma.apiKey
      .update({
        where: { uuid: apiKey.uuid },
        data: { lastUsed: new Date() },
      })
      .catch(() => {
        // Ignore update errors, don't affect the request
      });

    // Return UUID-based result
    const result: ApiKeyValidationResult = {
      valid: true,
      agent: {
        uuid: apiKey.agent.uuid,
        companyUuid: apiKey.agent.companyUuid,
        name: apiKey.agent.name,
        roles: apiKey.agent.roles,
        permissions: apiKey.agent.permissions,
        ownerUuid: apiKey.agent.ownerUuid,
      },
      apiKey: {
        uuid: apiKey.uuid,
      },
    };
    rememberStreamCredential(result, { kind: "key", keyUuid: apiKey.uuid, expiresAt: apiKey.expiresAt?.getTime() });
    return result;
  } catch (error) {
    logger.error({ err: error }, "API key validation error");
    return { valid: false, error: "Internal validation error" };
  }
}

// Timing-safe string comparison (prevents timing attacks)
export function secureCompare(a: string, b: string): boolean {
  try {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);

    if (bufA.length !== bufB.length) {
      return false;
    }

    return timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}
