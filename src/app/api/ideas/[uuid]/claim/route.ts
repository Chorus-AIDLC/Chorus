// src/app/api/ideas/[uuid]/claim/route.ts
// Ideas API - Claim Idea (PRD §4.1 F5 claiming rules)
// UUID-Based Architecture: All operations use UUIDs

import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { withErrorHandler, parseBody } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { getAuthContext, isUser, isAgent, hasPermission } from "@/lib/auth";
import { computeEffectivePermissions } from "@/lib/authz/permissions";
import { getIdeaByUuid, claimIdea } from "@/services/idea.service";
import { AlreadyClaimedError } from "@/lib/errors";

type RouteContext = { params: Promise<{ uuid: string }> };

// POST /api/ideas/[uuid]/claim - Claim Idea
export const POST = withErrorHandler<{ uuid: string }>(
  async (request: NextRequest, context: RouteContext) => {
    const auth = await getAuthContext(request);
    if (!auth) {
      return errors.unauthorized();
    }

    const { uuid } = await context.params;

    const idea = await getIdeaByUuid(auth.companyUuid, uuid);
    if (!idea) {
      return errors.notFound("Idea");
    }

    let assigneeType: string;
    let assigneeUuid: string;
    let assignedByUuid: string | null = null;
    // Optional durable AgentInstance pin (add-agent-instance-addressing). When a
    // user assigns an idea to an agent, they may pin which (agent, host, cwd)
    // instance the idea is rooted at by passing the instance's uuid. Presence →
    // the idea is persisted as assigneeType="agent_instance" (the authoritative
    // pin root that proposals/tasks/wakes inherit); absence → plain agent
    // (backward-compatible). An agent self-claim never pins one.
    let instanceUuid: string | null = null;

    if (isAgent(auth)) {
      // Agents need idea:write permission to claim
      if (!hasPermission(auth, "idea:write")) {
        return errors.forbidden("Missing permission: idea:write");
      }
      assigneeType = "agent";
      assigneeUuid = auth.actorUuid;
    } else if (isUser(auth)) {
      // User claim - can choose to assign to self or a specific Agent
      const body = await parseBody<{
        assignToSelf?: boolean;
        agentUuid?: string;
        // Optional durable AgentInstance pin: the uuid of the (agent, host, cwd)
        // instance to root this idea at. The instance must belong to this
        // company (validated server-side in claimIdea); a non-existent or
        // foreign-company uuid is rejected. Omitted → no pin (plain agent).
        instanceUuid?: string | null;
      }>(request);

      if (body.agentUuid) {
        // Assign to any agent with idea:write — the assignee is whoever the
        // user picks from the agent modal, gated by the same permission the
        // agent itself would need to claim directly. We verify the permission
        // post-lookup rather than filtering in the DB so custom-preset agents
        // with idea-relevant bits are eligible too.
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
        if (!agentPerms.has("idea:write")) {
          return errors.forbidden(
            "Selected agent does not have idea:write permission",
          );
        }

        assigneeType = "agent";
        assigneeUuid = agent.uuid;
        assignedByUuid = auth.actorUuid;
        // Carry the optional instance pin only when assigning to an agent. The
        // service validates the instance belongs to this company and, when
        // present, persists the idea as assigneeType="agent_instance".
        instanceUuid = body.instanceUuid ?? null;
      } else {
        // Assign to self (all owned PM Agents can handle it)
        assigneeType = "user";
        assigneeUuid = auth.actorUuid;
        assignedByUuid = auth.actorUuid;
      }
    } else {
      return errors.forbidden("Invalid authentication context");
    }

    try {
      // Thread the optional instance pin through to the service. When present,
      // claimIdea validates the instance belongs to this company and persists
      // the idea as assigneeType="agent_instance"/assigneeUuid=<instance uuid>;
      // when null it is byte-identical to a plain-agent claim. Pass it only when
      // set so an un-pinned claim's args are unchanged from before.
      const updated = await claimIdea({
        ideaUuid: idea.uuid,
        companyUuid: auth.companyUuid,
        assigneeType,
        assigneeUuid,
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
