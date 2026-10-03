// src/app/api/projects/[uuid]/ideas/tracker/route.ts
// Idea Tracker API — thin route, business logic in idea.service.ts

import { NextRequest } from "next/server";
import { withErrorHandler } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { getAuthContext, checkAgentPermission } from "@/lib/auth";
import { requireProjectAccess } from "@/services/project-access.service";
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

    // Project access (404 when not visible, 403 below required level)
    await requireProjectAccess(auth, projectUuid, "viewer");

    const result = await getTrackerGroups(auth.companyUuid, projectUuid);
    return success(result);
  }
);
