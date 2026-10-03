// src/app/api/ideas/[uuid]/parent/route.ts
// Set or clear an Idea's lineage parent (single-parent forest, weak relation).

import { NextRequest } from "next/server";
import { withErrorHandler, parseBody } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { getAuthContext, checkAgentPermission } from "@/lib/auth";
import { setIdeaParent } from "@/services/idea.service";
import { requireEntityAccess, ProjectNotFoundError } from "@/services/project-access.service";

type RouteContext = { params: Promise<{ uuid: string }> };

// PATCH /api/ideas/[uuid]/parent
// Body: { parentUuid: string | null } — null detaches the idea to top-level.
export const PATCH = withErrorHandler<{ uuid: string }>(
  async (request: NextRequest, context: RouteContext) => {
    const auth = await getAuthContext(request);
    if (!auth) {
      return errors.unauthorized();
    }
    const denied = checkAgentPermission(auth, "idea:write");
    if (denied) return denied;

    const { uuid } = await context.params;
    const body = await parseBody<{ parentUuid: string | null }>(request);

    // parentUuid is required in the body but may be explicitly null (detach).
    if (!("parentUuid" in body)) {
      return errors.badRequest("parentUuid is required (use null to detach)");
    }

    // Project access: editor on the child and (when attaching) on the new parent.
    // A hidden idea surfaces exactly like a missing one (the service's 400s).
    try {
      await requireEntityAccess(auth, "idea", uuid, "editor");
    } catch (e) {
      if (e instanceof ProjectNotFoundError) return errors.badRequest("Idea not found");
      throw e;
    }
    if (body.parentUuid) {
      try {
        await requireEntityAccess(auth, "idea", body.parentUuid, "editor");
      } catch (e) {
        if (e instanceof ProjectNotFoundError) return errors.badRequest("Parent idea not found");
        throw e;
      }
    }

    try {
      const updated = await setIdeaParent(uuid, body.parentUuid ?? null, auth.companyUuid, {
        actorType: auth.type,
        actorUuid: auth.actorUuid,
      });
      return success(updated);
    } catch (error) {
      // Cycle / same-project / not-found validation surfaces as a 400.
      return errors.badRequest(
        error instanceof Error ? error.message : "Failed to set idea parent",
      );
    }
  }
);
