// src/app/api/projects/[uuid]/proposals/summary/route.ts
// Proposal Summary API - Lightweight proposal list with task counts (for filter dropdown)

import { NextRequest } from "next/server";
import { withErrorHandler } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { getAuthContext } from "@/lib/auth";
import { projectExists } from "@/services/project.service";
import { getProjectProposals } from "@/services/proposal.service";

type RouteContext = { params: Promise<{ uuid: string }> };

// GET /api/projects/[uuid]/proposals/summary - Get lightweight proposal list
export const GET = withErrorHandler<{ uuid: string }>(
  async (request: NextRequest, context: RouteContext) => {
    const auth = await getAuthContext(request);
    if (!auth) {
      return errors.unauthorized();
    }

    const { uuid: projectUuid } = await context.params;

    // Validate project exists and belongs to company
    if (!(await projectExists(auth.companyUuid, projectUuid))) {
      return errors.notFound("Project");
    }

    const data = await getProjectProposals(auth.companyUuid, projectUuid);

    return success(data);
  }
);
