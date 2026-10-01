// src/app/api/projects/[uuid]/members/route.ts
// Project Members API - List and Add (Tech Design D3)
// GET: any actor who can see the project (viewer+). POST: explicit project admin.

import { NextRequest } from "next/server";
import { withErrorHandler, parseBody } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { getAuthContext, isUser, isAgent, hasPermission, checkAgentPermission } from "@/lib/auth";
import { isProjectMemberRole } from "@/services/project-access.service";
import { listMembers, addMember } from "@/services/project-member.service";

type RouteContext = { params: Promise<{ uuid: string }> };

// GET /api/projects/[uuid]/members - List members
export const GET = withErrorHandler<{ uuid: string }>(
  async (request: NextRequest, context: RouteContext) => {
    const auth = await getAuthContext(request);
    if (!auth) {
      return errors.unauthorized();
    }
    const denied = checkAgentPermission(auth, "project:read");
    if (denied) return denied;

    const { uuid: projectUuid } = await context.params;
    const members = await listMembers(auth, projectUuid);
    return success({ members });
  }
);

// POST /api/projects/[uuid]/members - Add a member { userUuid, role }
export const POST = withErrorHandler<{ uuid: string }>(
  async (request: NextRequest, context: RouteContext) => {
    const auth = await getAuthContext(request);
    if (!auth) {
      return errors.unauthorized();
    }
    if (isAgent(auth)) {
      if (!hasPermission(auth, "project:write")) {
        return errors.forbidden("Missing permission: project:write");
      }
    } else if (!isUser(auth)) {
      return errors.forbidden("Only users or permitted agents can manage project members");
    }

    const { uuid: projectUuid } = await context.params;
    const body = await parseBody<{ userUuid?: unknown; role?: unknown }>(request);

    const fieldErrors: Record<string, string> = {};
    if (typeof body?.userUuid !== "string" || body.userUuid.trim() === "") {
      fieldErrors.userUuid = "userUuid is required";
    }
    if (!isProjectMemberRole(body?.role)) {
      fieldErrors.role = "Role must be viewer, editor, or admin";
    }
    if (Object.keys(fieldErrors).length > 0) {
      return errors.validationError(fieldErrors);
    }

    const member = await addMember(
      auth,
      projectUuid,
      (body.userUuid as string).trim(),
      body.role as "viewer" | "editor" | "admin",
    );
    return success({ uuid: member.uuid, userUuid: member.userUuid, role: member.role });
  }
);
