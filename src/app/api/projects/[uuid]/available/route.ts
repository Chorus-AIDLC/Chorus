// src/app/api/projects/[uuid]/available/route.ts
// Agent Self-Service API - Get Claimable Ideas + Tasks (PRD §5.4)
// UUID-Based Architecture: All operations use UUIDs

import { NextRequest } from "next/server";
import { withErrorHandler } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { getAuthContext, isAgent, hasPermission, checkAgentPermission } from "@/lib/auth";
import { getProjectByUuid } from "@/services/project.service";
import { getAvailableItems } from "@/services/assignment.service";

type RouteContext = { params: Promise<{ uuid: string }> };

// GET /api/projects/[uuid]/available - Get claimable Ideas + Tasks
export const GET = withErrorHandler<{ uuid: string }>(
  async (request: NextRequest, context: RouteContext) => {
    const auth = await getAuthContext(request);
    if (!auth) {
      return errors.unauthorized();
    }
    const denied = checkAgentPermission(auth, "project:read");
    if (denied) return denied;

    const { uuid: projectUuid } = await context.params;

    // Find project
    const project = await getProjectByUuid(auth.companyUuid, projectUuid);
    if (!project) {
      return errors.notFound("Project");
    }

    // Return different content based on permission
    // Agent with idea:write can claim Ideas; task:write for Tasks
    // User sees everything
    const canClaimIdeas = isAgent(auth) ? hasPermission(auth, "idea:write") : true;
    const canClaimTasks = isAgent(auth) ? hasPermission(auth, "task:write") : true;

    const result = await getAvailableItems(
      auth.companyUuid,
      projectUuid,
      canClaimIdeas,
      canClaimTasks
    );

    return success({
      project: {
        uuid: project.uuid,
        name: project.name,
      },
      ...result,
    });
  }
);
