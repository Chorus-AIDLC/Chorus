// src/app/api/tasks/[uuid]/dependencies/[dependsOnUuid]/route.ts
// Task Dependency DELETE API - Remove Dependency

import { NextRequest } from "next/server";
import { withErrorHandler } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { getAuthContext, checkAgentPermission } from "@/lib/auth";
import { getTaskByUuid, removeTaskDependency } from "@/services/task.service";

type RouteContext = { params: Promise<{ uuid: string; dependsOnUuid: string }> };

// DELETE /api/tasks/[uuid]/dependencies/[dependsOnUuid] - Remove Dependency
export const DELETE = withErrorHandler<{ uuid: string; dependsOnUuid: string }>(
  async (request: NextRequest, context: RouteContext) => {
    const auth = await getAuthContext(request);
    if (!auth) {
      return errors.unauthorized();
    }
    const denied = checkAgentPermission(auth, "task:write");
    if (denied) return denied;

    const { uuid, dependsOnUuid } = await context.params;

    // Validate task exists
    const task = await getTaskByUuid(auth.companyUuid, uuid);
    if (!task) {
      return errors.notFound("Task");
    }

    await removeTaskDependency(auth.companyUuid, uuid, dependsOnUuid);
    return success({ deleted: true });
  }
);
