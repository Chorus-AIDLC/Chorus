// src/app/api/projects/[uuid]/stats/route.ts
// Project Stats API - Returns aggregated stats for dashboard display

import { NextRequest } from "next/server";
import { withErrorHandler } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { getAuthContext } from "@/lib/auth";
import { getProject, getProjectStats } from "@/services/project.service";
import { listActivitiesWithActorNames } from "@/services/activity.service";

type RouteContext = { params: Promise<{ uuid: string }> };

// GET /api/projects/[uuid]/stats - Project Stats + Recent Activity
export const GET = withErrorHandler<{ uuid: string }>(
  async (request: NextRequest, context: RouteContext) => {
    const auth = await getAuthContext(request);
    if (!auth) {
      return errors.unauthorized();
    }

    const { uuid: projectUuid } = await context.params;

    const project = await getProject(auth.companyUuid, projectUuid);
    if (!project) {
      return errors.notFound("Project");
    }

    const [stats, { activities }] = await Promise.all([
      getProjectStats(auth.companyUuid, projectUuid),
      listActivitiesWithActorNames({
        companyUuid: auth.companyUuid,
        projectUuid,
        skip: 0,
        take: 5,
      }),
    ]);

    return success({
      stats,
      recentActivities: activities,
    });
  }
);
