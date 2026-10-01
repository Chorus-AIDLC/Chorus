// src/app/api/project-groups/[uuid]/route.ts
// Project Group API - Get, Update, Delete

import { NextRequest } from "next/server";
import { withErrorHandler, parseBody } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { getAuthContext, isUser, isAgent, hasPermission, checkAgentPermission } from "@/lib/auth";
import {
  getProjectGroup,
  updateProjectGroup,
  deleteProjectGroup,
} from "@/services/project-group.service";
import { isProjectVisibility, type ProjectVisibility } from "@/services/project-access.service";

// GET /api/project-groups/[uuid]
export const GET = withErrorHandler(
  async (request: NextRequest, context: { params: Promise<{ uuid: string }> }) => {
    const auth = await getAuthContext(request);
    if (!auth) return errors.unauthorized();
    const denied = checkAgentPermission(auth, "project:read");
    if (denied) return denied;

    const { uuid } = await context.params;
    const group = await getProjectGroup(auth.companyUuid, uuid, auth);
    if (!group) return errors.notFound("Project group");

    return success(group);
  }
);

// PATCH /api/project-groups/[uuid]
export const PATCH = withErrorHandler(
  async (request: NextRequest, context: { params: Promise<{ uuid: string }> }) => {
    const auth = await getAuthContext(request);
    if (!auth) return errors.unauthorized();
    if (isAgent(auth)) {
      if (!hasPermission(auth, "project:write")) {
        return errors.forbidden("Missing permission: project:write");
      }
    } else if (!isUser(auth)) {
      return errors.forbidden("Only users or permitted agents can update project groups");
    }

    const { uuid } = await context.params;
    const body = await parseBody<{ name?: string; description?: string; visibility?: ProjectVisibility; initializeAccess?: boolean; confirmationToken?: string }>(request);
    if (body.visibility !== undefined && !isProjectVisibility(body.visibility)) return errors.validationError({ visibility: "Invalid visibility" });
    if (body.initializeAccess !== undefined && typeof body.initializeAccess !== "boolean") return errors.validationError({ initializeAccess: "Must be a boolean" });
    if (body.name !== undefined && (typeof body.name !== "string" || !body.name.trim())) return errors.validationError({ name: "Name is required" });

    const group = await updateProjectGroup({
      companyUuid: auth.companyUuid,
      groupUuid: uuid,
      name: body.name?.trim(),
      description: body.description?.trim(),
      visibility: body.visibility,
      initializeAccess: body.initializeAccess,
      confirmationToken: body.confirmationToken,
    }, auth);

    if (!group) return errors.notFound("Project group");
    return success(group);
  }
);

// DELETE /api/project-groups/[uuid]?deleteProjects=true
export const DELETE = withErrorHandler(
  async (request: NextRequest, context: { params: Promise<{ uuid: string }> }) => {
    const auth = await getAuthContext(request);
    if (!auth) return errors.unauthorized();
    if (isAgent(auth)) {
      if (!hasPermission(auth, "project:write")) {
        return errors.forbidden("Missing permission: project:write");
      }
    } else if (!isUser(auth)) {
      return errors.forbidden("Only users or permitted agents can delete project groups");
    }

    const { uuid } = await context.params;
    const shouldDeleteProjects = request.nextUrl.searchParams.get("deleteProjects") === "true";

    const deleted = await deleteProjectGroup(auth.companyUuid, uuid, shouldDeleteProjects, auth);

    if (!deleted) return errors.notFound("Project group");
    return success({ deleted: true });
  }
);
