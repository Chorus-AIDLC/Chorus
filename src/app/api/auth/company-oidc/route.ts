// src/app/api/auth/company-oidc/route.ts
// Fetch a Company's OIDC config by UUID (for workspace picker flow)

import { NextRequest } from "next/server";
import { withErrorHandler, parseQuery } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import * as companyService from "@/services/company.service";

export const GET = withErrorHandler(async (request: NextRequest) => {
  const { uuid, email } = parseQuery(request);

  // Require email — callers must prove the target Company is one of their
  // candidates before we hand out its OIDC config. Mirrors the contract of
  // /api/auth/identify and avoids UUID→config enumeration.
  if (!uuid || !email) {
    return errors.validationError({
      uuid: uuid ? undefined : "uuid is required",
      email: email ? undefined : "email is required",
    });
  }

  const candidates = await companyService.getCandidateCompaniesForEmail(email);
  const company = candidates.find((c) => c.uuid === uuid);

  if (!company) {
    return errors.notFound("Company");
  }

  return success({
    uuid: company.uuid,
    name: company.name,
    oidcIssuer: company.oidcIssuer,
    oidcClientId: company.oidcClientId,
  });
});
