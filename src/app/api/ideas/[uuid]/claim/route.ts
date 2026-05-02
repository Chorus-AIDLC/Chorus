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
      const updated = await claimIdea({
        ideaUuid: idea.uuid,
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
