// src/app/api/agents/[uuid]/sessions/route.ts
// Agent Sessions API - list sessions for an agent (UI-facing: filtered)
// UUID-Based Architecture: All operations use UUIDs

import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { withErrorHandler } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { getAuthContext, isUser } from "@/lib/auth";
import { listAgentSessionsForUI } from "@/services/session.service";

type RouteContext = { params: Promise<{ uuid: string }> };

// GET /api/agents/[uuid]/sessions - List sessions for an agent
// This is the Settings-page-facing endpoint and applies the staleness filter
// (status='active' AND lastActiveAt > now - 1h). MCP-facing reads use
// /api/sessions/[uuid] / chorus_list_sessions which remain unfiltered.
export const GET = withErrorHandler<{ uuid: string }>(
  async (request: NextRequest, context: RouteContext) => {
    const auth = await getAuthContext(request);
    if (!auth) {
      return errors.unauthorized();
    }

    if (!isUser(auth)) {
      return errors.forbidden("Only users can view agent sessions");
    }

    const { uuid } = await context.params;

    // Verify agent belongs to company
    const agent = await prisma.agent.findFirst({
      where: { uuid, companyUuid: auth.companyUuid },
      select: { uuid: true },
    });

    if (!agent) {
      return errors.notFound("Agent");
    }

    const sessions = await listAgentSessionsForUI(auth.companyUuid, uuid);

    return success(sessions);
  }
);
