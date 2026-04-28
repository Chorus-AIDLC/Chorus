// src/app/api/admin/companies/[uuid]/route.ts
// Company Detail, Update, Delete API (Super Admin Only)

import { NextRequest } from "next/server";
import { withErrorHandler, parseBody } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { requireSuperAdmin } from "@/lib/auth";
import * as companyService from "@/services/company.service";
import { CompanyUpdateInput } from "@/types/admin";

type RouteContext = { params: Promise<{ uuid: string }> };

// GET /api/admin/companies/:uuid - Detail
export const GET = withErrorHandler<{ uuid: string }>(
  requireSuperAdmin(async (_request: NextRequest, context: RouteContext) => {
    const { uuid } = await context.params;

    const company = await companyService.getCompanyByUuid(uuid);

    if (!company) {
      return errors.notFound("Company");
    }

    return success({
      uuid: company.uuid,
      name: company.name,
      emailDomains: company.emailDomains,
      oidcIssuer: company.oidcIssuer,
      oidcClientId: company.oidcClientId,
      oidcEnabled: company.oidcEnabled,
      userCount: company._count.users,
      agentCount: company._count.agents,
      projectCount: company._count.projects,
      createdAt: company.createdAt.toISOString(),
      updatedAt: company.updatedAt.toISOString(),
    });
  })
);

// PATCH /api/admin/companies/:uuid - Update
export const PATCH = withErrorHandler<{ uuid: string }>(
  requireSuperAdmin(async (request: NextRequest, context: RouteContext) => {
    const { uuid } = await context.params;

    const company = await companyService.getCompanyByUuid(uuid);

    if (!company) {
      return errors.notFound("Company");
    }

    const body = await parseBody<CompanyUpdateInput>(request);

    // Validate name
    if (body.name !== undefined && body.name.trim() === "") {
      return errors.validationError({ name: "Name cannot be empty" });
    }

    // Build update data
    const updateData: CompanyUpdateInput = {};
    if (body.name !== undefined) updateData.name = body.name.trim();
    if (body.emailDomains !== undefined)
      updateData.emailDomains = body.emailDomains;
    if (body.oidcIssuer !== undefined) updateData.oidcIssuer = body.oidcIssuer;
    if (body.oidcClientId !== undefined)
      updateData.oidcClientId = body.oidcClientId;
    if (body.oidcEnabled !== undefined)
      updateData.oidcEnabled = body.oidcEnabled;

    const updated = await companyService.updateCompany(company.id, updateData);

    return success({
      uuid: updated.uuid,
      name: updated.name,
      emailDomains: updated.emailDomains,
      oidcIssuer: updated.oidcIssuer,
      oidcClientId: updated.oidcClientId,
      oidcEnabled: updated.oidcEnabled,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
    });
  })
);

// DELETE /api/admin/companies/:uuid - Delete
export const DELETE = withErrorHandler<{ uuid: string }>(
  requireSuperAdmin(async (_request: NextRequest, context: RouteContext) => {
    const { uuid } = await context.params;

    const company = await companyService.getCompanyByUuid(uuid);

    if (!company) {
      return errors.notFound("Company");
    }

    await companyService.deleteCompany(company.id);

    return success({ deleted: true });
  })
);
