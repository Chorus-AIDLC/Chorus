// src/app/api/projects/[uuid]/resource-graph/route.ts
// Project Resource Graph API — knowledge-graph aggregation data for the
// per-project "Graph" view. Returns the four entity types (idea / proposal /
// task / document) as graph nodes and their derive / lineage / depends
// relationships as typed edges.
//
// Auth model mirrors the sibling /api/projects/[uuid]/tasks/dependencies route:
// human users are admitted unconditionally; agents must carry task:read since
// the payload contains Task titles (the most sensitive of the four types
// surfaced — Ideas/Proposals/Documents are visible to any agent that can read
// the project, and this gate is the strictest one that already exists). Empty
// projects return { success: true, data: { nodes: [], edges: [] } } — not an
// error.

import { NextRequest } from "next/server";
import { withErrorHandler } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { getAuthContext, checkAgentPermission } from "@/lib/auth";
import { requireProjectAccess } from "@/services/project-access.service";
import { getProjectResourceGraph } from "@/services/resource-graph.service";

type RouteContext = { params: Promise<{ uuid: string }> };

// GET /api/projects/[uuid]/resource-graph
export const GET = withErrorHandler<{ uuid: string }>(
  async (request: NextRequest, context: RouteContext) => {
    const auth = await getAuthContext(request);
    if (!auth) {
      return errors.unauthorized();
    }
    const denied = checkAgentPermission(auth, "task:read");
    if (denied) return denied;

    const { uuid: projectUuid } = await context.params;

    // Project access (404 when not visible, 403 below required level)
    await requireProjectAccess(auth, projectUuid, "viewer");

    const graph = await getProjectResourceGraph(auth.companyUuid, projectUuid);
    return success(graph);
  }
);
