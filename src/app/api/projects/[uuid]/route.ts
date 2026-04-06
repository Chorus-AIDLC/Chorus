// src/app/api/projects/[uuid]/route.ts
// Projects API - Detail, Update, Delete (ARCHITECTURE.md §5.1)
// UUID-Based Architecture: All operations use UUIDs

import { NextRequest } from "next/server";
import { withErrorHandler, parseBody } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { getAuthContext, isUser } from "@/lib/auth";
import {
  getProject,
  updateProject,
  deleteProject,
} from "@/services/project.service";

type RouteContext = { params: Promise<{ uuid: string }> };

// GET /api/projects/[uuid] - Project Detail
export const GET = withErrorHandler(async (request: NextRequest, context: RouteContext) => {
  const auth = await getAuthContext(request);
  if (!auth) {
    return errors.unauthorized();
  }

  const { uuid } = await context.params;
  const project = await getProject(auth.companyUuid, uuid);

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

  if (!isUser(auth)) {
    return errors.forbidden("Only users can update projects");
  }

  const { uuid } = await context.params;

  const body = await parseBody<{
    name?: string;
    description?: string;
  }>(request);

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

  const project = await updateProject(auth.companyUuid, uuid, updateData);
  if (!project) {
    return errors.notFound("Project");
  }

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

  if (!isUser(auth)) {
    return errors.forbidden("Only users can delete projects");
  }

  const { uuid } = await context.params;

  const deleted = await deleteProject(auth.companyUuid, uuid);
  if (!deleted) {
    return errors.notFound("Project");
  }

  return success({ deleted: true });
});
