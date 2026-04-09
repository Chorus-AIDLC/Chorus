// src/app/api/project-groups/[uuid]/route.ts
// Project Group API - Get, Update, Delete

import { NextRequest } from "next/server";
import { withErrorHandler, parseBody } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { getAuthContext, isUser } from "@/lib/auth";
import {
  getProjectGroup,
  updateProjectGroup,
  deleteProjectGroup,
} from "@/services/project-group.service";

// GET /api/project-groups/[uuid]
export const GET = withErrorHandler(
  async (request: NextRequest, context: { params: Promise<{ uuid: string }> }) => {
    const auth = await getAuthContext(request);
    if (!auth) return errors.unauthorized();

    const { uuid } = await context.params;
    const group = await getProjectGroup(auth.companyUuid, uuid);
    if (!group) return errors.notFound("Project group");

    return success(group);
  }
);

// PATCH /api/project-groups/[uuid]
export const PATCH = withErrorHandler(
  async (request: NextRequest, context: { params: Promise<{ uuid: string }> }) => {
    const auth = await getAuthContext(request);
    if (!auth) return errors.unauthorized();
    if (!isUser(auth)) return errors.forbidden("Only users can update project groups");

    const { uuid } = await context.params;
    const body = await parseBody<{ name?: string; description?: string }>(request);

    const group = await updateProjectGroup({
      companyUuid: auth.companyUuid,
      groupUuid: uuid,
      name: body.name?.trim(),
      description: body.description?.trim(),
    });

    if (!group) return errors.notFound("Project group");
    return success(group);
  }
);

// DELETE /api/project-groups/[uuid]?deleteProjects=true
export const DELETE = withErrorHandler(
  async (request: NextRequest, context: { params: Promise<{ uuid: string }> }) => {
    const auth = await getAuthContext(request);
    if (!auth) return errors.unauthorized();
    if (!isUser(auth)) return errors.forbidden("Only users can delete project groups");

    const { uuid } = await context.params;
    const shouldDeleteProjects = request.nextUrl.searchParams.get("deleteProjects") === "true";
    const deleted = await deleteProjectGroup(auth.companyUuid, uuid, shouldDeleteProjects);

    if (!deleted) return errors.notFound("Project group");
    return success({ deleted: true });
  }
);
