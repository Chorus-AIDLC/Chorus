// src/app/api/tasks/[uuid]/release/route.ts
// Tasks API - Release Task (PRD §3.3.1)
// UUID-Based Architecture: All operations use UUIDs

import { NextRequest } from "next/server";
import { withErrorHandler } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { getAuthContext, isUser, isAssignee, checkAgentPermission } from "@/lib/auth";
import { getTaskByUuid, releaseTask } from "@/services/task.service";
import { NotClaimedError } from "@/lib/errors";

type RouteContext = { params: Promise<{ uuid: string }> };

// POST /api/tasks/[uuid]/release - Release Task
export const POST = withErrorHandler<{ uuid: string }>(
  async (request: NextRequest, context: RouteContext) => {
    const auth = await getAuthContext(request);
    if (!auth) {
      return errors.unauthorized();
    }
    const denied = checkAgentPermission(auth, "task:write");
    if (denied) return denied;

    const { uuid } = await context.params;

    const task = await getTaskByUuid(auth.companyUuid, uuid);
    if (!task) {
      return errors.notFound("Task");
    }

    // Check permissions: users can release any Task, Agents can only release their own
    if (!isUser(auth)) {
      if (!isAssignee(auth, task.assigneeType, task.assigneeUuid)) {
        return errors.permissionDenied("Only assignee can release this task");
      }
    }

    try {
      const updated = await releaseTask(task.uuid);
      return success(updated);
    } catch (e) {
      if (e instanceof NotClaimedError) {
        return errors.badRequest("Can only release tasks with assigned status");
      }
      throw e;
    }
  }
);
