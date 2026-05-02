// src/app/api/projects/[uuid]/activity/route.ts
// Activity API - Project Activity Stream (ARCHITECTURE.md §4.2)
// UUID-Based Architecture: All operations use UUIDs

import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { withErrorHandler, parsePagination } from "@/lib/api-handler";
import { paginated, errors } from "@/lib/api-response";
import { getAuthContext, checkAgentPermission } from "@/lib/auth";

type RouteContext = { params: Promise<{ uuid: string }> };

// GET /api/projects/[uuid]/activity - Project Activity Stream
export const GET = withErrorHandler<{ uuid: string }>(
  async (request: NextRequest, context: RouteContext) => {
    const auth = await getAuthContext(request);
    if (!auth) {
      return errors.unauthorized();
    }
    const denied = checkAgentPermission(auth, "project:read");
    if (denied) return denied;

    const { uuid: projectUuid } = await context.params;
    const { page, pageSize, skip, take } = parsePagination(request);

    // Find project (query by UUID)
    const project = await prisma.project.findFirst({
      where: { uuid: projectUuid, companyUuid: auth.companyUuid },
      select: { uuid: true },
    });

    if (!project) {
      return errors.notFound("Project");
    }

    const where = {
      projectUuid: project.uuid,
      companyUuid: auth.companyUuid,
    };

    const [activities, total] = await Promise.all([
      prisma.activity.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: "desc" },
        select: {
          uuid: true,
          targetType: true,
          targetUuid: true,
          actorType: true,
          actorUuid: true,
          action: true,
          value: true,
          createdAt: true,
        },
      }),
      prisma.activity.count({ where }),
    ]);

    const data = activities.map((a) => ({
      uuid: a.uuid,
      targetType: a.targetType,
      targetUuid: a.targetUuid,
      actor: {
        type: a.actorType,
        uuid: a.actorUuid,
      },
      action: a.action,
      value: a.value,
      createdAt: a.createdAt.toISOString(),
    }));

    return paginated(data, page, pageSize, total);
  }
);
