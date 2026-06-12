// src/app/api/projects/[uuid]/route.ts
// Projects API - Detail, Update, Delete (ARCHITECTURE.md §5.1)
// UUID-Based Architecture: All operations use UUIDs

import { NextRequest } from "next/server";
import { withErrorHandler, parseBody } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { getAuthContext, isUser, isAgent, hasPermission, checkAgentPermission } from "@/lib/auth";
import {
  getProject,
  updateProject,
  deleteProject,
  setProjectVisibility,
} from "@/services/project.service";
import { claimOrCanManageProject } from "@/lib/authz/project-access";

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
  const project = await getProject(auth.companyUuid, uuid, auth);

  if (!project) {
    return errors.notFound("Project");
  }

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

  // Updating requires project:write for agents, or a human user
  if (isAgent(auth)) {
    if (!hasPermission(auth, "project:write")) {
      return errors.forbidden("Missing permission: project:write");
    }
  } else if (!isUser(auth)) {
    return errors.forbidden("Only users or permitted agents can update projects");
  }

  const { uuid } = await context.params;

  // Leak rule: an inaccessible project must look like it does not exist (404),
  // whereas an accessible project the actor cannot manage yields 403. We probe
  // accessibility via the gated getProject first, then require management rights.
  const existing = await getProject(auth.companyUuid, uuid, auth);
  if (!existing) {
    return errors.notFound("Project");
  }
  if (!(await claimOrCanManageProject(auth, uuid))) {
    return errors.forbidden("Only the project owner can manage this project");
  }

  const body = await parseBody<{
    name?: string;
    description?: string;
    visibility?: "shared" | "private";
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

  // Apply visibility change via the dedicated service (owner-only, already gated above).
  if (body.visibility !== undefined) {
    if (!["shared", "private"].includes(body.visibility)) {
      return errors.validationError({ visibility: "Visibility must be 'shared' or 'private'" });
    }
    const updated = await setProjectVisibility(auth.companyUuid, uuid, body.visibility);
    if (!updated) {
      return errors.notFound("Project");
    }
  }

  // Apply name/description updates if any were provided.
  let project = existing;
  if (Object.keys(updateData).length > 0) {
    const result = await updateProject(auth.companyUuid, uuid, updateData);
    if (!result) {
      return errors.notFound("Project");
    }
    project = { ...existing, ...result };
  }

  return success({
    uuid: project.uuid,
    name: project.name,
    description: project.description,
    visibility: body.visibility ?? existing.visibility,
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

  // Deleting requires project:write for agents, or a human user
  if (isAgent(auth)) {
    if (!hasPermission(auth, "project:write")) {
      return errors.forbidden("Missing permission: project:write");
    }
  } else if (!isUser(auth)) {
    return errors.forbidden("Only users or permitted agents can delete projects");
  }

  const { uuid } = await context.params;

  // Leak rule: inaccessible project -> 404; accessible but not the owner -> 403.
  const existing = await getProject(auth.companyUuid, uuid, auth);
  if (!existing) {
    return errors.notFound("Project");
  }
  if (!(await claimOrCanManageProject(auth, uuid))) {
    return errors.forbidden("Only the project owner can delete this project");
  }

  const deleted = await deleteProject(auth.companyUuid, uuid);
  if (!deleted) {
    return errors.notFound("Project");
  }

  return success({ deleted: true });
});
