// src/app/api/project-groups/[uuid]/dashboard/route.ts
// Project Group Dashboard API - Aggregated stats

import { NextRequest } from "next/server";
import { withErrorHandler } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { getAuthContext, checkAgentPermission } from "@/lib/auth";
import { getGroupDashboard } from "@/services/project-group.service";

// GET /api/project-groups/[uuid]/dashboard
export const GET = withErrorHandler(
  async (request: NextRequest, context: { params: Promise<{ uuid: string }> }) => {
    const auth = await getAuthContext(request);
    if (!auth) return errors.unauthorized();
    const denied = checkAgentPermission(auth, "project:read");
    if (denied) return denied;

    const { uuid } = await context.params;
    const dashboard = await getGroupDashboard(auth.companyUuid, uuid);
    if (!dashboard) return errors.notFound("Project group");

    return success(dashboard);
  }
);
