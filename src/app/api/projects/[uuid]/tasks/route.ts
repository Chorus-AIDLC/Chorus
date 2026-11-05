// src/app/api/projects/[uuid]/tasks/route.ts
// Tasks API - List and Create (ARCHITECTURE.md §5.1, PRD §3.3.1)
// UUID-Based Architecture: All operations use UUIDs

import { NextRequest } from "next/server";
import { withErrorHandler, parseBody, parsePagination } from "@/lib/api-handler";
import { success, paginated, errors } from "@/lib/api-response";
import { getAuthContext, isUser, isAgent, hasPermission, checkAgentPermission } from "@/lib/auth";
import { requireProjectAccess } from "@/services/project-access.service";
import { listTasks, createTask } from "@/services/task.service";

type RouteContext = { params: Promise<{ uuid: string }> };

// GET /api/projects/[uuid]/tasks - List Tasks
export const GET = withErrorHandler<{ uuid: string }>(
  async (request: NextRequest, context: RouteContext) => {
    const auth = await getAuthContext(request);
    if (!auth) {
      return errors.unauthorized();
    }
    const denied = checkAgentPermission(auth, "task:read");
    if (denied) return denied;

    const { uuid: projectUuid } = await context.params;
    const { page, pageSize, skip, take } = parsePagination(request);

    // Parse filter parameters
    const url = new URL(request.url);
    const statusFilter = url.searchParams.get("status") || undefined;
    const priorityFilter = url.searchParams.get("priority") || undefined;
    const proposalUuids = url.searchParams.get("proposalUuids")?.split(",").filter(Boolean);
    const ideaUuid = url.searchParams.get("ideaUuid") || undefined;

    // Project access (404 when not visible, 403 below required level)
    await requireProjectAccess(auth, projectUuid, "viewer");

    const { tasks, total } = await listTasks({
      companyUuid: auth.companyUuid,
      projectUuid,
      skip,
      take,
      status: statusFilter,
      priority: priorityFilter,
      proposalUuids,
      ideaUuid,
    });

    return paginated(tasks, page, pageSize, total);
  }
);

// POST /api/projects/[uuid]/tasks - Create Task
export const POST = withErrorHandler<{ uuid: string }>(
  async (request: NextRequest, context: RouteContext) => {
    const auth = await getAuthContext(request);
    if (!auth) {
      return errors.unauthorized();
    }

    // Creating requires task:write for agents, or a human user
    if (isAgent(auth)) {
      if (!hasPermission(auth, "task:write")) {
        return errors.forbidden("Missing permission: task:write");
      }
    } else if (!isUser(auth)) {
      return errors.forbidden("Only users or permitted agents can create tasks");
    }

    const { uuid: projectUuid } = await context.params;

    // Project access (404 when not visible, 403 below required level)
    await requireProjectAccess(auth, projectUuid, "editor");

    const body = await parseBody<{
      title: string;
      description?: string;
      priority?: string;
      storyPoints?: number;
      ideaUuid?: string | null;
    }>(request);

    // Validate required fields
    if (!body.title || body.title.trim() === "") {
      return errors.validationError({ title: "Title is required" });
    }

    // Validate priority
    const validPriorities = ["low", "medium", "high"];
    const priority = body.priority || "medium";
    if (!validPriorities.includes(priority)) {
      return errors.validationError({
        priority: "Priority must be low, medium, or high",
      });
    }

    // Validate storyPoints (unit: agent hours)
    const storyPoints = body.storyPoints;
    if (storyPoints !== undefined && (storyPoints < 0 || storyPoints > 1000)) {
      return errors.validationError({
        storyPoints: "Story points must be between 0 and 1000 agent hours",
      });
    }

    // Direct Idea link (Quick Tasks). Shape-check here; the service enforces the
    // link invariants (same project, not a theme) and throws 400/404 ApiErrors.
    if (body.ideaUuid !== undefined && body.ideaUuid !== null && typeof body.ideaUuid !== "string") {
      return errors.badRequest("ideaUuid must be a string or null");
    }

    const task = await createTask({
      companyUuid: auth.companyUuid,
      projectUuid,
      title: body.title.trim(),
      description: body.description?.trim() || null,
      priority,
      storyPoints: storyPoints || null,
      ideaUuid: body.ideaUuid || null,
      createdByUuid: auth.actorUuid,
    });

    return success(task);
  }
);
