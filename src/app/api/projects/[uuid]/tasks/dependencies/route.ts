// src/app/api/projects/[uuid]/tasks/dependencies/route.ts
// Project Task Dependencies API - DAG Visualization Data

import { NextRequest } from "next/server";
import { withErrorHandler } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { getAuthContext, checkAgentPermission } from "@/lib/auth";
import { projectExists } from "@/services/project.service";
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

    // Validate project exists
    if (!(await projectExists(auth.companyUuid, projectUuid))) {
      return errors.notFound("Project");
    }

    const dag = await getProjectTaskDependencies(auth.companyUuid, projectUuid);
    return success(dag);
  }
);
