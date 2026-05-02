// src/app/api/projects/[uuid]/proposals/route.ts
// Proposals API - List and Create (ARCHITECTURE.md §5.1, PRD §4.1 F5)
// UUID-Based Architecture: All operations use UUIDs
// Container Model: Proposal contains documentDrafts and taskDrafts

import { NextRequest } from "next/server";
import { withErrorHandler, parseBody, parsePagination } from "@/lib/api-handler";
import { success, paginated, errors } from "@/lib/api-response";
import { getAuthContext, isAgent, isUser, checkAgentPermission, hasPermission } from "@/lib/auth";
import { projectExists } from "@/services/project.service";
import { listProposals, createProposal, type DocumentDraft, type TaskDraft } from "@/services/proposal.service";

type RouteContext = { params: Promise<{ uuid: string }> };

// GET /api/projects/[uuid]/proposals - List Proposals
export const GET = withErrorHandler<{ uuid: string }>(
  async (request: NextRequest, context: RouteContext) => {
    const auth = await getAuthContext(request);
    if (!auth) {
      return errors.unauthorized();
    }
    const denied = checkAgentPermission(auth, "proposal:read");
    if (denied) return denied;

    const { uuid: projectUuid } = await context.params;
    const { page, pageSize, skip, take } = parsePagination(request);

    // Parse filter parameters
    const url = new URL(request.url);
    const statusFilter = url.searchParams.get("status") || undefined;

    // Validate project exists
    if (!(await projectExists(auth.companyUuid, projectUuid))) {
      return errors.notFound("Project");
    }

    const { proposals, total } = await listProposals({
      companyUuid: auth.companyUuid,
      projectUuid,
      skip,
      take,
      status: statusFilter,
    });

    return paginated(proposals, page, pageSize, total);
  }
);

// POST /api/projects/[uuid]/proposals - Create Proposal (container model)
export const POST = withErrorHandler<{ uuid: string }>(
  async (request: NextRequest, context: RouteContext) => {
    const auth = await getAuthContext(request);
    if (!auth) {
      return errors.unauthorized();
    }

    // Creating a proposal requires proposal:write for agents, or a human user
    if (isAgent(auth)) {
      if (!hasPermission(auth, "proposal:write")) {
        return errors.forbidden("Missing permission: proposal:write");
      }
    } else if (!isUser(auth)) {
      return errors.forbidden("Only users or permitted agents can create proposals");
    }

    const { uuid: projectUuid } = await context.params;

    // Validate project exists
    if (!(await projectExists(auth.companyUuid, projectUuid))) {
      return errors.notFound("Project");
    }

    const body = await parseBody<{
      title: string;
      description?: string;
      inputType: "idea" | "document";
      inputUuids: string[];
      documentDrafts?: DocumentDraft[];
      taskDrafts?: TaskDraft[];
    }>(request);

    // Validate required fields
    if (!body.title || body.title.trim() === "") {
      return errors.validationError({ title: "Title is required" });
    }
    if (!body.inputType || !["idea", "document"].includes(body.inputType)) {
      return errors.validationError({ inputType: "Invalid input type" });
    }
    if (!body.inputUuids || !Array.isArray(body.inputUuids) || body.inputUuids.length === 0) {
      return errors.validationError({ inputUuids: "Input UUIDs are required" });
    }

    // Determine creator type
    const createdByType = isUser(auth) ? "user" : "agent";

    const proposal = await createProposal({
      companyUuid: auth.companyUuid,
      projectUuid,
      title: body.title.trim(),
      description: body.description?.trim() || null,
      inputType: body.inputType,
      inputUuids: body.inputUuids,
      documentDrafts: body.documentDrafts,
      taskDrafts: body.taskDrafts,
      createdByUuid: auth.actorUuid,
      createdByType,
    });

    return success(proposal);
  }
);
