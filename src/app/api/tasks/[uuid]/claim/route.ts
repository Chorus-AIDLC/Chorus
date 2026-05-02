// src/app/api/tasks/[uuid]/claim/route.ts
// Tasks API - Claim Task (PRD §3.3.1 claiming rules)
// UUID-Based Architecture: All operations use UUIDs

import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { withErrorHandler, parseBody } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { getAuthContext, isUser, isAgent, hasPermission } from "@/lib/auth";
import { getTaskByUuid, claimTask } from "@/services/task.service";
import { AlreadyClaimedError } from "@/lib/errors";

type RouteContext = { params: Promise<{ uuid: string }> };

// POST /api/tasks/[uuid]/claim - Claim Task
export const POST = withErrorHandler<{ uuid: string }>(
  async (request: NextRequest, context: RouteContext) => {
    const auth = await getAuthContext(request);
    if (!auth) {
      return errors.unauthorized();
    }

    const { uuid } = await context.params;

    const task = await getTaskByUuid(auth.companyUuid, uuid);
    if (!task) {
      return errors.notFound("Task");
    }

    let assigneeType: string;
    let assigneeUuid: string;
    let assignedByUuid: string | null = null;

    if (isAgent(auth)) {
      // Agents need task:write permission to claim
      if (!hasPermission(auth, "task:write")) {
        return errors.forbidden("Missing permission: task:write");
      }
      assigneeType = "agent";
      assigneeUuid = auth.actorUuid;
    } else if (isUser(auth)) {
      // User claim - can choose to assign to self or a specific Agent
      const body = await parseBody<{
        assignToSelf?: boolean;
        agentUuid?: string;
      }>(request);

      if (body.agentUuid) {
        // Assign to a specific Agent (by UUID)
        const agent = await prisma.agent.findFirst({
          where: {
            uuid: body.agentUuid,
            companyUuid: auth.companyUuid,
            roles: { has: "developer" }, // Can only assign to Developer Agents
          },
        });

        if (!agent) {
          return errors.notFound("Developer Agent");
        }

        assigneeType = "agent";
        assigneeUuid = agent.uuid;
        assignedByUuid = auth.actorUuid;
      } else {
        // Assign to self (all owned Developer Agents can handle it)
        assigneeType = "user";
        assigneeUuid = auth.actorUuid;
        assignedByUuid = auth.actorUuid;
      }
    } else {
      return errors.forbidden("Invalid authentication context");
    }

    try {
      const updated = await claimTask({
        taskUuid: task.uuid,
        companyUuid: auth.companyUuid,
        assigneeType,
        assigneeUuid,
        assignedByUuid,
      });

      return success(updated);
    } catch (e) {
      if (e instanceof AlreadyClaimedError) {
        return errors.alreadyClaimed();
      }
      throw e;
    }
  }
);
