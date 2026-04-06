// src/app/api/projects/[uuid]/route.ts
// Projects API - Detail, Update, Delete (ARCHITECTURE.md §5.1)
// UUID-Based Architecture: All operations use UUIDs

import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { withErrorHandler, parseBody } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { getAuthContext, isUser } from "@/lib/auth";

type RouteContext = { params: Promise<{ uuid: string }> };

// GET /api/projects/[uuid] - Project Detail
export const GET = withErrorHandler(async (request: NextRequest, context: RouteContext) => {
  const auth = await getAuthContext(request);
  if (!auth) {
    return errors.unauthorized();
  }

  const { uuid } = await context.params;

  const project = await prisma.project.findFirst({
    where: {
      uuid,
      companyUuid: auth.companyUuid,
    },
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
          activities: true,
        },
      },
    },
  });

  if (!project) {
    return errors.notFound("Project");
  }

  return success({
    uuid: project.uuid,
    name: project.name,
    description: project.description,
    groupUuid: project.groupUuid,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
    counts: {
      ideas: project._count.ideas,
      documents: project._count.documents,
      tasks: project._count.tasks,
      proposals: project._count.proposals,
      activities: project._count.activities,
    },
  });
});

// PATCH /api/projects/[uuid] - Update Project
export const PATCH = withErrorHandler(async (request: NextRequest, context: RouteContext) => {
  const auth = await getAuthContext(request);
  if (!auth) {
    return errors.unauthorized();
  }

  // Only users can update projects
  if (!isUser(auth)) {
    return errors.forbidden("Only users can update projects");
  }

  const { uuid } = await context.params;

  // Validate project exists and belongs to the current company (query by UUID)
  const existing = await prisma.project.findFirst({
    where: { uuid, companyUuid: auth.companyUuid },
    select: { uuid: true },
  });

  if (!existing) {
    return errors.notFound("Project");
  }

  const body = await parseBody<{
    name?: string;
    description?: string;
  }>(request);

  // Build update data
  const updateData: { name?: string; description?: string | null } = {};

  if (body.name !== undefined) {
    if (body.name.trim() === "") {
      return errors.validationError({ name: "Name cannot be empty" });
    }
    updateData.name = body.name.trim();
  }

  if (body.description !== undefined) {
    updateData.description = body.description?.trim() || null;
  }

  const project = await prisma.project.update({
    where: { uuid: existing.uuid },
    data: updateData,
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

// DELETE /api/projects/[uuid] - Delete Project
export const DELETE = withErrorHandler(async (request: NextRequest, context: RouteContext) => {
  const auth = await getAuthContext(request);
  if (!auth) {
    return errors.unauthorized();
  }

  // Only users can delete projects
  if (!isUser(auth)) {
    return errors.forbidden("Only users can delete projects");
  }

  const { uuid } = await context.params;

  // Validate project exists and belongs to the current company (query by UUID)
  const existing = await prisma.project.findFirst({
    where: { uuid, companyUuid: auth.companyUuid },
    select: { uuid: true },
  });

  if (!existing) {
    return errors.notFound("Project");
  }

  // Delete project (Prisma handles cascade deletes at the application level)
  await prisma.project.delete({
    where: { uuid: existing.uuid },
  });

  return success({ deleted: true });
});
