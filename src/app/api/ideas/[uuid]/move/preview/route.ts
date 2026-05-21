// src/app/api/ideas/[uuid]/move/preview/route.ts
// Cross-project Idea cascade-move preview — non-mutating count of what would
// be migrated. Drives the UI confirmation dialog (see openspec change
// idea-cross-project-cascade-move §D4). Mirrors moveIdea's validation
// (auth, target-project UUID format, same-project guard, multi-tenancy).

import { NextRequest } from "next/server";
import { withErrorHandler } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { getAuthContext, checkAgentPermission } from "@/lib/auth";
import { getIdeaByUuid, moveIdeaPreview } from "@/services/idea.service";

type RouteContext = { params: Promise<{ uuid: string }> };

// Same RFC4122-ish UUID shape Prisma emits — keeps the 400 path purely
// client-side without round-tripping to the DB for an obviously-bad query.
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// GET /api/ideas/[uuid]/move/preview?targetProjectUuid=<uuid>
export const GET = withErrorHandler<{ uuid: string }>(
  async (request: NextRequest, context: RouteContext) => {
    const auth = await getAuthContext(request);
    if (!auth) {
      return errors.unauthorized();
    }
    // Preview is read-only on idea/proposal/document/task/activity rows but
    // semantically belongs to the move operation, so we gate it on the same
    // permission as the actual move. Humans pass through unchanged.
    const denied = checkAgentPermission(auth, "idea:write");
    if (denied) return denied;

    const { uuid: ideaUuid } = await context.params;

    const targetProjectUuid = request.nextUrl.searchParams.get("targetProjectUuid");
    if (!targetProjectUuid) {
      return errors.badRequest("targetProjectUuid is required");
    }
    if (!UUID_REGEX.test(targetProjectUuid)) {
      return errors.badRequest("targetProjectUuid must be a valid UUID");
    }

    // Cross-tenant scoped lookup — getIdeaByUuid filters on companyUuid so a
    // foreign idea (or a non-existent uuid) collapses to 404 here, never leaks.
    const idea = await getIdeaByUuid(auth.companyUuid, ideaUuid);
    if (!idea) {
      return errors.notFound("Idea");
    }

    // Mirror moveIdea's same-project guard so the UI confirmation dialog
    // can't ever be opened against the idea's current project.
    if (idea.projectUuid === targetProjectUuid) {
      return errors.badRequest("Idea is already in the target project");
    }

    const result = await moveIdeaPreview(auth.companyUuid, ideaUuid, targetProjectUuid);
    return success({ moved: result.moved });
  }
);
