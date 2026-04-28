// src/app/api/admin/companies/route.ts
// Company List and Create API (Super Admin Only)

import { NextRequest } from "next/server";
import { withErrorHandler, parseBody, parsePagination } from "@/lib/api-handler";
import { success, paginated, errors } from "@/lib/api-response";
import { requireSuperAdmin } from "@/lib/auth";
import * as companyService from "@/services/company.service";
import { CompanyCreateInput } from "@/types/admin";

// GET /api/admin/companies - List
export const GET = withErrorHandler(
  requireSuperAdmin(async (request: NextRequest) => {
    const { page, pageSize, skip, take } = parsePagination(request);

    const { companies, total } = await companyService.listCompanies({
      skip,
      take,
    });

    const data = companies.map((c) => ({
      uuid: c.uuid,
      name: c.name,
      emailDomains: c.emailDomains,
      oidcEnabled: c.oidcEnabled,
      userCount: c._count.users,
      agentCount: c._count.agents,
      createdAt: c.createdAt.toISOString(),
    }));

    return paginated(data, page, pageSize, total);
  })
);

// POST /api/admin/companies - Create
export const POST = withErrorHandler(
  requireSuperAdmin(async (request: NextRequest) => {
    const body = await parseBody<CompanyCreateInput>(request);

    // Validate input
    if (!body.name || body.name.trim() === "") {
      return errors.validationError({ name: "Name is required" });
    }

    // Validate OIDC config (issuer and clientId must be provided together)
    if (body.oidcIssuer && !body.oidcClientId) {
      return errors.validationError({ oidcClientId: "Client ID is required when OIDC Issuer is provided" });
    }
    if (body.oidcClientId && !body.oidcIssuer) {
      return errors.validationError({ oidcIssuer: "OIDC Issuer is required when Client ID is provided" });
    }

    const company = await companyService.createCompany({
      name: body.name.trim(),
      emailDomains: body.emailDomains,
      oidcIssuer: body.oidcIssuer?.trim(),
      oidcClientId: body.oidcClientId?.trim(),
    });

    return success({
      uuid: company.uuid,
      name: company.name,
      emailDomains: company.emailDomains,
      oidcIssuer: company.oidcIssuer,
      oidcClientId: company.oidcClientId,
      oidcEnabled: company.oidcEnabled,
      userCount: 0,
      agentCount: 0,
      createdAt: company.createdAt.toISOString(),
    });
  })
);
