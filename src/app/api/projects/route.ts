// src/app/api/projects/route.ts
// Projects API - List and Create (ARCHITECTURE.md §5.1)
// UUID-Based Architecture: All operations use UUIDs

import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { withErrorHandler, parseBody, parsePagination } from "@/lib/api-handler";
import { success, paginated, errors } from "@/lib/api-response";
import { getAuthContext, isUser, isAgent, hasPermission, checkAgentPermission } from "@/lib/auth";
import { listProjectsWithStats, createProject } from "@/services/project.service";

// GET /api/projects - List Projects
export const GET = withErrorHandler(async (request: NextRequest) => {
  const auth = await getAuthContext(request);
  if (!auth) {
    return errors.unauthorized();
  }
  const denied = checkAgentPermission(auth, "project:read");
  if (denied) return denied;

  const { page, pageSize, skip, take } = parsePagination(request);

  // Restrict results to the projects this actor can access (service injects the
  // accessible-projects filter via `auth`).
  const { projects, total } = await listProjectsWithStats({
    companyUuid: auth.companyUuid,
    skip,
    take,
    auth,
  });

  // Transform to API response format
  const data = projects.map((p) => ({
    uuid: p.uuid,
    name: p.name,
    description: p.description,
    groupUuid: p.groupUuid,
    visibility: p.visibility,
    ownerType: p.ownerType,
    ownerUuid: p.ownerUuid,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
    counts: {
      ideas: p._count.ideas,
      documents: p._count.documents,
      tasks: p._count.tasks,
      doneTasks: p.tasksDone,
      proposals: p._count.proposals,
    },
  }));

  return paginated(data, page, pageSize, total);
});

// POST /api/projects - Create Project
export const POST = withErrorHandler(async (request: NextRequest) => {
  const auth = await getAuthContext(request);
  if (!auth) {
    return errors.unauthorized();
  }

  // Creating requires project:write for agents, or a human user
  if (isAgent(auth)) {
    if (!hasPermission(auth, "project:write")) {
      return errors.forbidden("Missing permission: project:write");
    }
  } else if (!isUser(auth)) {
    return errors.forbidden("Only users or permitted agents can create projects");
  }

  const body = await parseBody<{
    name: string;
    description?: string;
    groupUuid?: string;
    visibility?: "shared" | "private";
    memberUuids?: { memberType: "user" | "agent"; memberUuid: string }[];
  }>(request);

  // Validate required fields
  if (!body.name || body.name.trim() === "") {
    return errors.validationError({ name: "Name is required" });
  }

  // Validate visibility if provided
  if (body.visibility !== undefined && !["shared", "private"].includes(body.visibility)) {
    return errors.validationError({ visibility: "Visibility must be 'shared' or 'private'" });
  }

  // Validate groupUuid belongs to the same company if provided
  if (body.groupUuid) {
    const group = await prisma.projectGroup.findFirst({
      where: { uuid: body.groupUuid, companyUuid: auth.companyUuid },
    });
    if (!group) {
      return errors.notFound("Project Group");
    }
  }

  // The owner is the acting actor. super_admin has no actorUuid, so the project
  // is created ownerless (only super_admin / shared visibility grants access).
  const isOwnerActor = auth.type === "user" || auth.type === "agent";
  const ownerType = isOwnerActor ? auth.type : null;
  const ownerUuid = isOwnerActor ? auth.actorUuid : null;

  const project = await createProject({
    companyUuid: auth.companyUuid,
    name: body.name.trim(),
    description: body.description?.trim() || null,
    groupUuid: body.groupUuid || null,
    visibility: body.visibility, // service defaults to "private" when undefined
    ownerType,
    ownerUuid,
    memberUuids: body.memberUuids,
  });

  return success({
    uuid: project.uuid,
    name: project.name,
    description: project.description,
    groupUuid: project.groupUuid,
    visibility: project.visibility,
    ownerType: project.ownerType,
    ownerUuid: project.ownerUuid,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
  });
});
