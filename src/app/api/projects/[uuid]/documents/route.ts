// src/app/api/projects/[uuid]/documents/route.ts
// Documents API - List and Create (ARCHITECTURE.md §5.1)
// UUID-Based Architecture: All operations use UUIDs

import { NextRequest } from "next/server";
import { withErrorHandler, parseBody, parsePagination } from "@/lib/api-handler";
import { success, paginated, errors } from "@/lib/api-response";
import { getAuthContext, isUser, isAgent, hasPermission, checkAgentPermission } from "@/lib/auth";
import { projectExists } from "@/services/project.service";
import { listDocuments, createDocument } from "@/services/document.service";

type RouteContext = { params: Promise<{ uuid: string }> };

// GET /api/projects/[uuid]/documents - List Documents
export const GET = withErrorHandler<{ uuid: string }>(
  async (request: NextRequest, context: RouteContext) => {
    const auth = await getAuthContext(request);
    if (!auth) {
      return errors.unauthorized();
    }
    const denied = checkAgentPermission(auth, "document:read");
    if (denied) return denied;

    const { uuid: projectUuid } = await context.params;
    const { page, pageSize, skip, take } = parsePagination(request);

    // Parse filter parameters
    const url = new URL(request.url);
    const typeFilter = url.searchParams.get("type") || undefined;

    // Validate project exists
    if (!(await projectExists(auth.companyUuid, projectUuid))) {
      return errors.notFound("Project");
    }

    const { documents, total } = await listDocuments({
      companyUuid: auth.companyUuid,
      projectUuid,
      skip,
      take,
      type: typeFilter,
    });

    return paginated(documents, page, pageSize, total);
  }
);

// POST /api/projects/[uuid]/documents - Create Document
export const POST = withErrorHandler<{ uuid: string }>(
  async (request: NextRequest, context: RouteContext) => {
    const auth = await getAuthContext(request);
    if (!auth) {
      return errors.unauthorized();
    }

    // Creating requires document:write for agents, or a human user
    if (isAgent(auth)) {
      if (!hasPermission(auth, "document:write")) {
        return errors.forbidden("Missing permission: document:write");
      }
    } else if (!isUser(auth)) {
      return errors.forbidden("Only users or permitted agents can create documents");
    }

    const { uuid: projectUuid } = await context.params;

    // Validate project exists
    if (!(await projectExists(auth.companyUuid, projectUuid))) {
      return errors.notFound("Project");
    }

    const body = await parseBody<{
      type: string;
      title: string;
      content?: string;
    }>(request);

    // Validate required fields
    if (!body.type || body.type.trim() === "") {
      return errors.validationError({ type: "Type is required" });
    }
    if (!body.title || body.title.trim() === "") {
      return errors.validationError({ title: "Title is required" });
    }

    const document = await createDocument({
      companyUuid: auth.companyUuid,
      projectUuid,
      type: body.type.trim(),
      title: body.title.trim(),
      content: body.content?.trim() || null,
      createdByUuid: auth.actorUuid,
    });

    return success(document);
  }
);
