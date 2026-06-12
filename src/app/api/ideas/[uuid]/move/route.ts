// src/app/api/ideas/[uuid]/move/route.ts
// Move Idea to a different project

import { NextRequest } from "next/server";
import { withErrorHandler, parseBody } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { getAuthContext, checkAgentPermission } from "@/lib/auth";
import { moveIdea } from "@/services/idea.service";

type RouteContext = { params: Promise<{ uuid: string }> };

// PATCH /api/ideas/[uuid]/move
export const PATCH = withErrorHandler<{ uuid: string }>(
  async (request: NextRequest, context: RouteContext) => {
    const auth = await getAuthContext(request);
    if (!auth) {
      return errors.unauthorized();
    }
    const denied = checkAgentPermission(auth, "idea:write");
    if (denied) return denied;

    const { uuid } = await context.params;
    const body = await parseBody<{ targetProjectUuid: string }>(request);

    if (!body.targetProjectUuid) {
      return errors.badRequest("targetProjectUuid is required");
    }

    // moveIdea returns { ...IdeaResponse, moved: { ideas, proposals, documents, tasks, activities } }
    // — spread directly into success() so REST callers get the cascade counts
    // alongside the updated idea fields.
    const updated = await moveIdea(
      auth.companyUuid,
      uuid,
      body.targetProjectUuid,
      auth.actorUuid,
      auth.type
    );

    return success(updated);
  }
);
