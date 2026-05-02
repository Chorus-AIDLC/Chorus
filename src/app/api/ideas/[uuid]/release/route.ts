// src/app/api/ideas/[uuid]/release/route.ts
// Ideas API - Release Idea (PRD §4.1 F5)
// UUID-Based Architecture: All operations use UUIDs

import { NextRequest } from "next/server";
import { withErrorHandler } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { getAuthContext, isUser, isAssignee, checkAgentPermission } from "@/lib/auth";
import { getIdeaByUuid, releaseIdea } from "@/services/idea.service";
import { NotClaimedError } from "@/lib/errors";

type RouteContext = { params: Promise<{ uuid: string }> };

// POST /api/ideas/[uuid]/release - Release Idea
export const POST = withErrorHandler<{ uuid: string }>(
  async (request: NextRequest, context: RouteContext) => {
    const auth = await getAuthContext(request);
    if (!auth) {
      return errors.unauthorized();
    }
    const denied = checkAgentPermission(auth, "idea:write");
    if (denied) return denied;

    const { uuid } = await context.params;

    const idea = await getIdeaByUuid(auth.companyUuid, uuid);
    if (!idea) {
      return errors.notFound("Idea");
    }

    // Check permissions: users can release any Idea, Agents can only release their own
    if (!isUser(auth)) {
      if (!isAssignee(auth, idea.assigneeType, idea.assigneeUuid)) {
        return errors.permissionDenied("Only assignee can release this idea");
      }
    }

    try {
      const updated = await releaseIdea(idea.uuid);
      return success(updated);
    } catch (e) {
      if (e instanceof NotClaimedError) {
        return errors.badRequest("Can only release ideas with assigned status");
      }
      throw e;
    }
  }
);
