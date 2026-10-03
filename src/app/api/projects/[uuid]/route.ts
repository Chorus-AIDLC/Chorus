// src/app/api/projects/[uuid]/route.ts
// Projects API - Detail, Update, Delete (ARCHITECTURE.md §5.1)
// UUID-Based Architecture: All operations use UUIDs
// Access: GET viewer; PATCH settings / DELETE → manage_project; visibility → setVisibility (admin)

import { NextRequest } from "next/server";
import { withErrorHandler, parseBody } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { getAuthContext, isUser, isAgent, hasPermission, checkAgentPermission } from "@/lib/auth";
import {
  getProject,
  updateProject,
  deleteProject,
} from "@/services/project.service";
import {
  isProjectVisibility,
  requireProjectAccess,
  requireProjectOperation,
} from "@/services/project-access.service";
import { setVisibility } from "@/services/project-member.service";

type RouteContext = { params: Promise<{ uuid: string }> };

// GET /api/projects/[uuid] - Project Detail
export const GET = withErrorHandler(async (request: NextRequest, context: RouteContext) => {
  const auth = await getAuthContext(request);
  if (!auth) {
    return errors.unauthorized();
  }
  const denied = checkAgentPermission(auth, "project:read");
  if (denied) return denied;

  const { uuid } = await context.params;
  const access = await requireProjectAccess(auth, uuid, "viewer");
  const project = await getProject(auth.companyUuid, uuid);

  if (!project) {
    return errors.notFound("Project");
  }

  return success({
    uuid: project.uuid,
    name: project.name,
    description: project.description,
    groupUuid: project.groupUuid,
    visibility: access.visibility,
    accessLevel: access.accessLevel,
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

// PATCH /api/projects/[uuid] - Update Project (settings and/or visibility)
export const PATCH = withErrorHandler(async (request: NextRequest, context: RouteContext) => {
  const auth = await getAuthContext(request);
  if (!auth) {
    return errors.unauthorized();
  }

  // Updating requires project:write for agents, or a human user
  if (isAgent(auth)) {
    if (!hasPermission(auth, "project:write")) {
      return errors.forbidden("Missing permission: project:write");
    }
  } else if (!isUser(auth)) {
    return errors.forbidden("Only users or permitted agents can update projects");
  }

  const { uuid } = await context.params;

  const body = await parseBody<{
    name?: string;
    description?: string;
    visibility?: unknown;
    confirmationToken?: string;
  }>(request);

  const updateData: { name?: string; description?: string | null } = {};

  if (body.name !== undefined) {
    if (typeof body.name !== "string" || body.name.trim() === "") {
      return errors.validationError({ name: "Name cannot be empty" });
    }
    updateData.name = body.name.trim();
  }

  if (body.description !== undefined) {
    updateData.description = body.description?.trim() || null;
  }

  if (body.visibility !== undefined && !isProjectVisibility(body.visibility)) {
    return errors.validationError({ visibility: "Visibility must be public or private" });
  }

  // 404 for actors who cannot see the project, before any other decision.
  const current = await requireProjectAccess(auth, uuid, "viewer");
  const visibilityChange =
    body.visibility !== undefined &&
      (body.visibility !== current.visibility || body.confirmationToken !== undefined)
      ? body.visibility
      : undefined;

  // Authorize every requested change up front so a partial update never lands.
  if (visibilityChange === undefined) {
    await requireProjectOperation(auth, uuid, "manage_project");
  }
  if (visibilityChange !== undefined) {
    await requireProjectOperation(auth, uuid, "change_visibility");
  }

  let project: Awaited<ReturnType<typeof updateProject>> = null;
  if (visibilityChange === undefined) {
    project = await updateProject(auth.companyUuid, uuid, updateData, auth);
    if (!project) {
      return errors.notFound("Project");
    }
  }

  let visibility = current.visibility;
  if (visibilityChange !== undefined) {
    const result = await setVisibility(auth, uuid, visibilityChange, body.confirmationToken, updateData);
    visibility = result.visibility;
    project = await getProject(auth.companyUuid, uuid);
  }

  const source = project ?? current;
  return success({
    uuid: source.uuid,
    name: source.name,
    description: source.description,
    visibility,
    createdAt: source.createdAt.toISOString(),
    updatedAt: source.updatedAt.toISOString(),
  });
});

// DELETE /api/projects/[uuid] - Delete Project
export const DELETE = withErrorHandler(async (request: NextRequest, context: RouteContext) => {
  const auth = await getAuthContext(request);
  if (!auth) {
    return errors.unauthorized();
  }

  // Deleting requires project:write for agents, or a human user
  if (isAgent(auth)) {
    if (!hasPermission(auth, "project:write")) {
      return errors.forbidden("Missing permission: project:write");
    }
  } else if (!isUser(auth)) {
    return errors.forbidden("Only users or permitted agents can delete projects");
  }

  const { uuid } = await context.params;
  await requireProjectOperation(auth, uuid, "manage_project");

  const deleted = await deleteProject(auth.companyUuid, uuid, auth);
  if (!deleted) {
    return errors.notFound("Project");
  }

  return success({ deleted: true });
});
