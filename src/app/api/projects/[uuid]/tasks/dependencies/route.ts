// src/app/api/projects/[uuid]/tasks/dependencies/route.ts
// Project Task Dependencies API - DAG Visualization Data

import { NextRequest } from "next/server";
import { withErrorHandler } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { getAuthContext, checkAgentPermission } from "@/lib/auth";
import { requireProjectAccess } from "@/services/project-access.service";
import { getProjectTaskDependencies } from "@/services/task.service";

type RouteContext = { params: Promise<{ uuid: string }> };

// GET /api/projects/[uuid]/tasks/dependencies - Get project task dependencies (DAG)
export const GET = withErrorHandler<{ uuid: string }>(
  async (request: NextRequest, context: RouteContext) => {
    const auth = await getAuthContext(request);
    if (!auth) {
      return errors.unauthorized();
    }
    const denied = checkAgentPermission(auth, "task:read");
    if (denied) return denied;

    const { uuid: projectUuid } = await context.params;

    // Project access (404 when not visible, 403 below required level)
    await requireProjectAccess(auth, projectUuid, "viewer");

    const dag = await getProjectTaskDependencies(auth.companyUuid, projectUuid);
    return success(dag);
  }
);
