// src/app/api/projects/[uuid]/ideas/tracker/route.ts
// Idea Tracker API — thin route, business logic in idea.service.ts

import { NextRequest } from "next/server";
import { withErrorHandler } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { getAuthContext, checkAgentPermission } from "@/lib/auth";
import { projectExists } from "@/services/project.service";
import { getTrackerGroups } from "@/services/idea.service";

type RouteContext = { params: Promise<{ uuid: string }> };

// GET /api/projects/[uuid]/ideas/tracker — used for client-side realtime refetch
export const GET = withErrorHandler<{ uuid: string }>(
  async (request: NextRequest, context: RouteContext) => {
    const auth = await getAuthContext(request);
    if (!auth) {
      return errors.unauthorized();
    }
    const denied = checkAgentPermission(auth, "idea:read");
    if (denied) return denied;

    const { uuid: projectUuid } = await context.params;

    if (!(await projectExists(auth.companyUuid, projectUuid))) {
      return errors.notFound("Project");
    }

    const result = await getTrackerGroups(auth.companyUuid, projectUuid);
    return success(result);
  }
);
