// src/app/api/auth/identify/route.ts
// Email Identification API - Determine if Super Admin, default auth, or Company OIDC

import { NextRequest } from "next/server";
import { withErrorHandler, parseBody } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { isSuperAdminEmail } from "@/lib/super-admin";
import { isDefaultAuthEnabled, getDefaultUserEmail } from "@/lib/default-auth";
import { parseHost } from "@/lib/oidc-utils";
import * as companyService from "@/services/company.service";
import { IdentifyResponse } from "@/types/admin";

interface IdentifyRequest {
  email: string;
}

export const POST = withErrorHandler(async (request: NextRequest) => {
  const body = await parseBody<IdentifyRequest>(request);

  if (!body.email || typeof body.email !== "string") {
    return errors.validationError({ email: "Email is required" });
  }

  const email = body.email.trim().toLowerCase();

  // Validate email format
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return errors.validationError({ email: "Invalid email format" });
  }

  // Check if this is a Super Admin
  if (isSuperAdminEmail(email)) {
    const response: IdentifyResponse = {
      type: "super_admin",
    };
    return success(response);
  }

  // Check if default auth is enabled and email matches
  if (isDefaultAuthEnabled() && email === getDefaultUserEmail()) {
    const response: IdentifyResponse = {
      type: "default_auth",
    };
    return success(response);
  }

  const candidates = await companyService.getCandidateCompaniesForEmail(email);

  if (candidates.length === 0) {
    const response: IdentifyResponse = {
      type: "not_found",
      message: "No organization found for this email domain",
    };
    return success(response);
  }

  if (candidates.length === 1) {
    const c = candidates[0];
    const response: IdentifyResponse = {
      type: "oidc",
      company: {
        uuid: c.uuid,
        name: c.name,
        oidcIssuer: c.oidcIssuer,
        oidcClientId: c.oidcClientId,
      },
    };
    return success(response);
  }

  const response: IdentifyResponse = {
    type: "oidc_multi_match",
    candidates: candidates.map((c) => ({
      uuid: c.uuid,
      name: c.name,
      oidcIssuerHost: parseHost(c.oidcIssuer),
    })),
  };
  return success(response);
});
