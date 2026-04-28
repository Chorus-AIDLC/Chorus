// src/app/api/auth/company-oidc/route.ts
// Fetch a Company's OIDC config by UUID (for workspace picker flow)

import { NextRequest } from "next/server";
import { withErrorHandler, parseQuery } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import * as companyService from "@/services/company.service";

export const GET = withErrorHandler(async (request: NextRequest) => {
  const { uuid } = parseQuery(request);

  if (!uuid) {
    return errors.validationError({ uuid: "uuid is required" });
  }

  const company = await companyService.getCompanyByUuid(uuid);

  if (
    !company ||
    !company.oidcEnabled ||
    !company.oidcIssuer ||
    !company.oidcClientId
  ) {
    return errors.notFound("Company");
  }

  return success({
    uuid: company.uuid,
    name: company.name,
    oidcIssuer: company.oidcIssuer,
    oidcClientId: company.oidcClientId,
  });
});
