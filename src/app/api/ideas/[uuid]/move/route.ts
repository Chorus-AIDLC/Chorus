// src/app/api/ideas/[uuid]/move/route.ts
// Move Idea to a different project

import { NextRequest } from "next/server";
import { withErrorHandler, parseBody } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { getAuthContext, checkAgentPermission } from "@/lib/auth";
import { moveIdea } from "@/services/idea.service";
import type { AuthContext } from "@/types/auth";
import { requireEntityAccess, requireProjectAccess, ProjectNotFoundError } from "@/services/project-access.service";

type RouteContext = { params: Promise<{ uuid: string }> };

// Target-project access: a hidden target reads exactly like a missing one.
async function requireTargetProject(
  auth: AuthContext,
  targetProjectUuid: string,
  min: "viewer" | "editor",
) {
  try {
    await requireProjectAccess(auth, targetProjectUuid, min);
  } catch (e) {
    if (e instanceof ProjectNotFoundError) return errors.notFound("Target project");
    throw e;
  }
  return null;
}

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

    // Editor on the idea's current project AND on the target project.
    await requireEntityAccess(auth, "idea", uuid, "editor");
    const targetDenied = await requireTargetProject(auth, body.targetProjectUuid, "editor");
    if (targetDenied) return targetDenied;

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
