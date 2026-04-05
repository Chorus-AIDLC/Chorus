// src/app/api/projects/[uuid]/proposals/route.ts
// Proposals API - List and Create (ARCHITECTURE.md §5.1, PRD §4.1 F5)
// UUID-Based Architecture: All operations use UUIDs
// Container Model: Proposal contains documentDrafts and taskDrafts

import { NextRequest } from "next/server";
import { withErrorHandler, parseBody, parsePagination } from "@/lib/api-handler";
import { success, paginated, errors } from "@/lib/api-response";
import { getAuthContext, isAgent, isPmAgent, isUser } from "@/lib/auth";
import { projectExists } from "@/services/project.service";
import { listProposals, createProposal, type DocumentDraft, type TaskDraft } from "@/services/proposal.service";
import { normalizeIdeaStatus } from "@/services/idea.service";
import { prisma } from "@/lib/prisma";

type RouteContext = { params: Promise<{ uuid: string }> };

// GET /api/projects/[uuid]/proposals - List Proposals
export const GET = withErrorHandler<{ uuid: string }>(
  async (request: NextRequest, context: RouteContext) => {
    const auth = await getAuthContext(request);
    if (!auth) {
      return errors.unauthorized();
    }

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

    // PM Agent or User can create Proposals
    const canCreate = isUser(auth) || (isAgent(auth) && isPmAgent(auth));
    if (!canCreate) {
      return errors.forbidden("Only PM agents or users can create proposals");
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

    // Validate that all input ideas are elaborated
    if (body.inputType === "idea") {
      const ideas = await prisma.idea.findMany({
        where: { uuid: { in: body.inputUuids }, companyUuid: auth.companyUuid },
        select: { uuid: true, title: true, status: true },
      });
      for (const idea of ideas) {
        if (normalizeIdeaStatus(idea.status) !== "elaborated") {
          return errors.badRequest(
            `Idea "${idea.title}" is not elaborated (status: ${idea.status}). Ideas must be elaborated before creating a proposal.`
          );
        }
      }
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
