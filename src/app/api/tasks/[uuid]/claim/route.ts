// src/app/api/tasks/[uuid]/claim/route.ts
// Tasks API - Claim Task (PRD §3.3.1 claiming rules)
// UUID-Based Architecture: All operations use UUIDs

import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { withErrorHandler, parseBody } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { getAuthContext, isUser, isAgent, hasPermission } from "@/lib/auth";
import { computeEffectivePermissions } from "@/lib/authz/permissions";
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
    let assignedByType: "user" | null = null;
    let assignedByUuid: string | null = null;
    // Optional durable AgentInstance pin (add-agent-instance-addressing). When a
    // user assigns to an agent, they may pin which (agent, host, cwd) instance
    // the work targets by passing the instance's uuid. Presence → the task is
    // persisted as assigneeType="agent_instance"; absence → plain agent
    // (backward-compatible). Only the user→agent path threads a pin; an agent
    // self-claim never pins one (it runs wherever it already is).
    let instanceUuid: string | null = null;

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
        // Optional durable AgentInstance pin: the uuid of the (agent, host, cwd)
        // instance the autonomous wake should target. The instance must belong
        // to this company (validated server-side in claimTask); a non-existent
        // or foreign-company uuid is rejected. Omitted → no pin (plain agent).
        instanceUuid?: string | null;
      }>(request);

      if (body.agentUuid) {
        // Assign to any agent with task:write — matches the permission gate a
        // self-claiming agent hits above, which keeps custom-preset agents
        // (e.g. pm preset + task:admin extras) eligible.
        const agent = await prisma.agent.findFirst({
          where: {
            uuid: body.agentUuid,
            companyUuid: auth.companyUuid,
          },
          select: { uuid: true, roles: true, permissions: true },
        });

        if (!agent) {
          return errors.notFound("Agent");
        }

        const agentPerms = computeEffectivePermissions(
          agent.roles,
          agent.permissions,
        );
        if (!agentPerms.has("task:write")) {
          return errors.forbidden(
            "Selected agent does not have task:write permission",
          );
        }

        assigneeType = "agent";
        assigneeUuid = agent.uuid;
        assignedByType = "user";
        assignedByUuid = auth.actorUuid;
        // Carry the optional instance pin only when assigning to an agent. The
        // service validates the instance belongs to this company and, when
        // present, persists the task as assigneeType="agent_instance".
        instanceUuid = body.instanceUuid ?? null;
      } else {
        // Assign to self (all owned Developer Agents can handle it)
        assigneeType = "user";
        assigneeUuid = auth.actorUuid;
        assignedByType = "user";
        assignedByUuid = auth.actorUuid;
      }
    } else {
      return errors.forbidden("Invalid authentication context");
    }

    try {
      // Thread the optional instance pin through to the service. When present,
      // claimTask validates the instance belongs to this company and persists
      // the task as assigneeType="agent_instance"/assigneeUuid=<instance uuid>;
      // when null it is byte-identical to a plain-agent assignment. Pass it only
      // when set so an un-pinned claim's args are unchanged from before.
      const updated = await claimTask({
        taskUuid: task.uuid,
        companyUuid: auth.companyUuid,
        assigneeType,
        assigneeUuid,
        assignedByType,
        assignedByUuid,
        ...(instanceUuid != null ? { instanceUuid } : {}),
      });

      return success(updated);
    } catch (e) {
      if (e instanceof AlreadyClaimedError) {
        return errors.alreadyClaimed();
      }
      // A foreign-company / non-existent instance pin is rejected by the
      // service with a plain Error; surface it as a 400 rather than a 500.
      if (e instanceof Error && e.message === "Agent instance not found") {
        return errors.badRequest(e.message);
      }
      throw e;
    }
  }
);
