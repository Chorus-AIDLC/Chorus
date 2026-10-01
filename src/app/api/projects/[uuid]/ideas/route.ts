// src/app/api/projects/[uuid]/ideas/route.ts
// Ideas API - List and Create (ARCHITECTURE.md §5.1, PRD §4.1 F5)
// UUID-Based Architecture: All operations use UUIDs

import { NextRequest } from "next/server";
import { withErrorHandler, parseBody, parsePagination } from "@/lib/api-handler";
import { success, paginated, errors } from "@/lib/api-response";
import { getAuthContext, isUser, isAgent, hasPermission, checkAgentPermission } from "@/lib/auth";
import { requireProjectAccess, requireEntityAccess, ProjectNotFoundError } from "@/services/project-access.service";
import { listIdeas, createIdea } from "@/services/idea.service";

type RouteContext = { params: Promise<{ uuid: string }> };

// GET /api/projects/[uuid]/ideas - List Ideas
export const GET = withErrorHandler<{ uuid: string }>(
  async (request: NextRequest, context: RouteContext) => {
    const auth = await getAuthContext(request);
    if (!auth) {
      return errors.unauthorized();
    }
    const denied = checkAgentPermission(auth, "idea:read");
    if (denied) return denied;

    const { uuid: projectUuid } = await context.params;
    const { page, pageSize, skip, take } = parsePagination(request);

    // Parse filter parameters
    const url = new URL(request.url);
    const statusFilter = url.searchParams.get("status") || undefined;

    // Project access (404 when not visible, 403 below required level)
    await requireProjectAccess(auth, projectUuid, "viewer");

    const { ideas, total } = await listIdeas({
      companyUuid: auth.companyUuid,
      projectUuid,
      skip,
      take,
      status: statusFilter,
    });

    return paginated(ideas, page, pageSize, total);
  }
);

// POST /api/projects/[uuid]/ideas - Create Idea
export const POST = withErrorHandler<{ uuid: string }>(
  async (request: NextRequest, context: RouteContext) => {
    const auth = await getAuthContext(request);
    if (!auth) {
      return errors.unauthorized();
    }

    // Creating requires idea:write for agents, or a human user
    if (isAgent(auth)) {
      if (!hasPermission(auth, "idea:write")) {
        return errors.forbidden("Missing permission: idea:write");
      }
    } else if (!isUser(auth)) {
      return errors.forbidden("Only users or permitted agents can create ideas");
    }

    const { uuid: projectUuid } = await context.params;

    // Project access (404 when not visible, 403 below required level)
    await requireProjectAccess(auth, projectUuid, "editor");

    const body = await parseBody<{
      title: string;
      content?: string;
      attachments?: unknown;
      parentUuid?: string | null;
      isContainer?: boolean;
    }>(request);

    // Validate required fields
    if (!body.title || body.title.trim() === "") {
      return errors.validationError({ title: "Title is required" });
    }

    // A hidden private parent must be indistinguishable from a missing one
    // (the service would otherwise answer "must be in the same project").
    if (body.parentUuid) {
      try {
        await requireEntityAccess(auth, "idea", body.parentUuid, "viewer");
      } catch (error) {
        if (error instanceof ProjectNotFoundError) return errors.badRequest("Parent idea not found");
        throw error;
      }
    }

    try {
      const idea = await createIdea({
        companyUuid: auth.companyUuid,
        projectUuid,
        title: body.title.trim(),
        content: body.content?.trim() || null,
        attachments: body.attachments,
        createdByUuid: auth.actorUuid,
        parentUuid: body.parentUuid ?? null,
        isContainer: body.isContainer,
      });

      return success(idea);
    } catch (error) {
      // Lineage validation (missing / cross-project parent) surfaces as a 400.
      return errors.badRequest(
        error instanceof Error ? error.message : "Failed to create idea",
      );
    }
  }
);
