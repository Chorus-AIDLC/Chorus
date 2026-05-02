// src/app/api/tasks/[uuid]/dependencies/route.ts
// Task Dependencies API - Add Dependency, Query Dependencies

import { NextRequest } from "next/server";
import { withErrorHandler, parseBody } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { getAuthContext, checkAgentPermission } from "@/lib/auth";
import {
  getTaskByUuid,
  addTaskDependency,
  getTaskDependencies,
} from "@/services/task.service";

type RouteContext = { params: Promise<{ uuid: string }> };

// POST /api/tasks/[uuid]/dependencies - Add Dependency
export const POST = withErrorHandler<{ uuid: string }>(
  async (request: NextRequest, context: RouteContext) => {
    const auth = await getAuthContext(request);
    if (!auth) {
      return errors.unauthorized();
    }
    const denied = checkAgentPermission(auth, "task:write");
    if (denied) return denied;

    const { uuid } = await context.params;

    // Validate task exists
    const task = await getTaskByUuid(auth.companyUuid, uuid);
    if (!task) {
      return errors.notFound("Task");
    }

    const body = await parseBody<{ dependsOnUuid: string }>(request);
    if (!body.dependsOnUuid) {
      return errors.validationError({ dependsOnUuid: "dependsOnUuid is required" });
    }

    try {
      const dep = await addTaskDependency(auth.companyUuid, uuid, body.dependsOnUuid);
      return success(dep);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      if (message.includes("cycle")) {
        return errors.conflict(message);
      }
      if (message.includes("not found") || message.includes("same project")) {
        return errors.badRequest(message);
      }
      throw error;
    }
  }
);

// GET /api/tasks/[uuid]/dependencies - Query Task Dependencies
export const GET = withErrorHandler<{ uuid: string }>(
  async (request: NextRequest, context: RouteContext) => {
    const auth = await getAuthContext(request);
    if (!auth) {
      return errors.unauthorized();
    }
    const denied = checkAgentPermission(auth, "task:read");
    if (denied) return denied;

    const { uuid } = await context.params;

    const task = await getTaskByUuid(auth.companyUuid, uuid);
    if (!task) {
      return errors.notFound("Task");
    }

    const deps = await getTaskDependencies(auth.companyUuid, uuid);
    return success(deps);
  }
);
