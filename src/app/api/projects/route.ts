// src/app/api/projects/route.ts
// Projects API - List and Create (ARCHITECTURE.md §5.1)
// UUID-Based Architecture: All operations use UUIDs

import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { withErrorHandler, parseBody, parsePagination } from "@/lib/api-handler";
import { success, paginated, errors } from "@/lib/api-response";
import { getAuthContext, isUser, isAgent, hasPermission, checkAgentPermission } from "@/lib/auth";

// GET /api/projects - List Projects
export const GET = withErrorHandler(async (request: NextRequest) => {
  const auth = await getAuthContext(request);
  if (!auth) {
    return errors.unauthorized();
  }
  const denied = checkAgentPermission(auth, "project:read");
  if (denied) return denied;

  const { page, pageSize, skip, take } = parsePagination(request);

  const [projects, total] = await Promise.all([
    prisma.project.findMany({
      where: { companyUuid: auth.companyUuid },
      skip,
      take,
      orderBy: { updatedAt: "desc" },
      select: {
        uuid: true,
        name: true,
        description: true,
        groupUuid: true,
        createdAt: true,
        updatedAt: true,
        _count: {
          select: {
            ideas: true,
            documents: true,
            tasks: true,
            proposals: true,
          },
        },
        tasks: {
          where: { status: { in: ["done", "closed"] } },
          select: { uuid: true },
        },
      },
    }),
    prisma.project.count({
      where: { companyUuid: auth.companyUuid },
    }),
  ]);

  // Transform to API response format
  const data = projects.map((p) => ({
    uuid: p.uuid,
    name: p.name,
    description: p.description,
    groupUuid: p.groupUuid,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
    counts: {
      ideas: p._count.ideas,
      documents: p._count.documents,
      tasks: p._count.tasks,
      doneTasks: p.tasks.length,
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
  }>(request);

  // Validate required fields
  if (!body.name || body.name.trim() === "") {
    return errors.validationError({ name: "Name is required" });
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

  const project = await prisma.project.create({
    data: {
      companyUuid: auth.companyUuid,
      name: body.name.trim(),
      description: body.description?.trim() || null,
      groupUuid: body.groupUuid || null,
    },
    select: {
      uuid: true,
      name: true,
      description: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  return success({
    uuid: project.uuid,
    name: project.name,
    description: project.description,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
  });
});
