// src/app/api/projects/[uuid]/proposals/summary/route.ts
// Proposal Summary API - Lightweight proposal list with task counts (for filter dropdown)

import { NextRequest } from "next/server";
import { withErrorHandler } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { getAuthContext, checkAgentPermission } from "@/lib/auth";
import { requireProjectAccess } from "@/services/project-access.service";
import { getProjectProposals } from "@/services/proposal.service";

type RouteContext = { params: Promise<{ uuid: string }> };

// GET /api/projects/[uuid]/proposals/summary - Get lightweight proposal list
export const GET = withErrorHandler<{ uuid: string }>(
  async (request: NextRequest, context: RouteContext) => {
    const auth = await getAuthContext(request);
    if (!auth) {
      return errors.unauthorized();
    }
    const denied = checkAgentPermission(auth, "proposal:read");
    if (denied) return denied;

    const { uuid: projectUuid } = await context.params;

    // Project access (404 when not visible, 403 below required level)
    await requireProjectAccess(auth, projectUuid, "viewer");

    const data = await getProjectProposals(auth.companyUuid, projectUuid);

    return success(data);
  }
);
