// src/app/api/projects/[uuid]/observability/idea/[ideaUuid]/route.ts
// User-facing endpoint: lifecycle phase breakdown for a single idea.

import { NextRequest } from "next/server";
import { withErrorHandler } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { getAuthContext } from "@/lib/auth";
import { getProject } from "@/services/project.service";
import { getIdeaLifecycleTokens } from "@/services/observability.service";
import { prisma } from "@/lib/prisma";

type RouteContext = { params: Promise<{ uuid: string; ideaUuid: string }> };

export const GET = withErrorHandler<{ uuid: string; ideaUuid: string }>(
  async (request: NextRequest, context: RouteContext) => {
    const auth = await getAuthContext(request);
    if (!auth) return errors.unauthorized();

    const { uuid: projectUuid, ideaUuid } = await context.params;
    const project = await getProject(auth.companyUuid, projectUuid);
    if (!project) return errors.notFound("Project");

    // Ensure the idea belongs to this project+company.
    const idea = await prisma.idea.findFirst({
      where: { uuid: ideaUuid, companyUuid: auth.companyUuid, projectUuid },
      select: { uuid: true },
    });
    if (!idea) return errors.notFound("Idea");

    const data = await getIdeaLifecycleTokens(auth.companyUuid, ideaUuid);
    return success(data);
  }
);
