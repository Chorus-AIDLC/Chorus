// src/app/api/projects/[uuid]/observability/route.ts
// User-facing agent observability dashboard data for a project.

import { NextRequest } from "next/server";
import { withErrorHandler, parseQuery } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { getAuthContext } from "@/lib/auth";
import { getProject } from "@/services/project.service";
import { getAgentObservability } from "@/services/observability.service";

type RouteContext = { params: Promise<{ uuid: string }> };

const ALLOWED_DAYS = new Set([7, 30, 90]);

export const GET = withErrorHandler<{ uuid: string }>(
  async (request: NextRequest, context: RouteContext) => {
    const auth = await getAuthContext(request);
    if (!auth) return errors.unauthorized();

    const { uuid: projectUuid } = await context.params;
    const project = await getProject(auth.companyUuid, projectUuid);
    if (!project) return errors.notFound("Project");

    const q = parseQuery(request);
    const parsed = parseInt(q.days ?? "30", 10);
    const days = ALLOWED_DAYS.has(parsed) ? parsed : 30;

    const data = await getAgentObservability(auth.companyUuid, projectUuid, days);
    return success(data);
  }
);
