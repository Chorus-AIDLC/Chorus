// src/app/api/projects/[uuid]/members/[userUuid]/route.ts
// Project Member API - Change role / Remove (Tech Design D3). Explicit project admin only.

import { NextRequest } from "next/server";
import { withErrorHandler, parseBody } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { getAuthContext, isUser, isAgent, hasPermission } from "@/lib/auth";
import type { AuthContext } from "@/types/auth";
import { isProjectMemberRole } from "@/services/project-access.service";
import { updateMemberRole, removeMember } from "@/services/project-member.service";

type Params = { uuid: string; userUuid: string };
type RouteContext = { params: Promise<Params> };

function checkManageActor(auth: AuthContext) {
  if (isAgent(auth)) {
    if (!hasPermission(auth, "project:write")) {
      return errors.forbidden("Missing permission: project:write");
    }
  } else if (!isUser(auth)) {
    return errors.forbidden("Only users or permitted agents can manage project members");
  }
  return null;
}

// PATCH /api/projects/[uuid]/members/[userUuid] - Change role { role }
export const PATCH = withErrorHandler<Params>(
  async (request: NextRequest, context: RouteContext) => {
    const auth = await getAuthContext(request);
    if (!auth) {
      return errors.unauthorized();
    }
    const denied = checkManageActor(auth);
    if (denied) return denied;

    const { uuid: projectUuid, userUuid } = await context.params;
    const body = await parseBody<{ role?: unknown }>(request);
    if (!isProjectMemberRole(body?.role)) {
      return errors.validationError({ role: "Role must be viewer, editor, or admin" });
    }

    const member = await updateMemberRole(auth, projectUuid, userUuid, body.role);
    return success({ uuid: member.uuid, userUuid: member.userUuid, role: member.role });
  }
);

// DELETE /api/projects/[uuid]/members/[userUuid] - Remove member
export const DELETE = withErrorHandler<Params>(
  async (request: NextRequest, context: RouteContext) => {
    const auth = await getAuthContext(request);
    if (!auth) {
      return errors.unauthorized();
    }
    const denied = checkManageActor(auth);
    if (denied) return denied;

    const { uuid: projectUuid, userUuid } = await context.params;
    const removed = await removeMember(auth, projectUuid, userUuid);
    return success({ uuid: removed.uuid, userUuid: removed.userUuid, removed: true });
  }
);
