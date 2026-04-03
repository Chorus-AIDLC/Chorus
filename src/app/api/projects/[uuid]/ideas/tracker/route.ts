// src/app/api/projects/[uuid]/ideas/tracker/route.ts
// Idea Tracker API - Returns ideas grouped by derived status
// UUID-Based Architecture: All operations use UUIDs

import { NextRequest } from "next/server";
import { withErrorHandler } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { getAuthContext } from "@/lib/auth";
import { projectExists } from "@/services/project.service";
import {
  getIdeasWithDerivedStatus,
  groupIdeasByDerivedStatus,
} from "@/services/idea.service";

type RouteContext = { params: Promise<{ uuid: string }> };

// GET /api/projects/[uuid]/ideas/tracker - Ideas grouped by derived status
export const GET = withErrorHandler<{ uuid: string }>(
  async (request: NextRequest, context: RouteContext) => {
    const auth = await getAuthContext(request);
    if (!auth) {
      return errors.unauthorized();
    }

    const { uuid: projectUuid } = await context.params;

    // Validate project exists
    if (!(await projectExists(auth.companyUuid, projectUuid))) {
      return errors.notFound("Project");
    }

    const ideas = await getIdeasWithDerivedStatus(auth.companyUuid, projectUuid);
    const result = await groupIdeasByDerivedStatus(auth.companyUuid, ideas);
    return success(result);
  }
);
