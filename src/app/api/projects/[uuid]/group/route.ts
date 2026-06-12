// src/app/api/projects/[uuid]/group/route.ts
// Move project to a different group

import { NextRequest } from "next/server";
import { withErrorHandler, parseBody } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { getAuthContext, isUser, isAgent, hasPermission } from "@/lib/auth";
import { moveProjectToGroup } from "@/services/project-group.service";
import { canAccessProject } from "@/lib/authz/project-access";

// PATCH /api/projects/[uuid]/group
export const PATCH = withErrorHandler(
  async (request: NextRequest, context: { params: Promise<{ uuid: string }> }) => {
    const auth = await getAuthContext(request);
    if (!auth) return errors.unauthorized();
    if (isAgent(auth)) {
      if (!hasPermission(auth, "project:write")) {
        return errors.forbidden("Missing permission: project:write");
      }
    } else if (!isUser(auth)) {
      return errors.forbidden("Only users or permitted agents can move projects between groups");
    }

    const { uuid } = await context.params;

    // Must be able to access the project; otherwise hide its existence (404).
    if (!(await canAccessProject(auth, uuid))) {
      return errors.notFound("Project");
    }

    const body = await parseBody<{ groupUuid: string | null }>(request);

    const result = await moveProjectToGroup(
      auth.companyUuid,
      uuid,
      body.groupUuid
    );

    if (!result) return errors.notFound("Project or group");
    return success(result);
  }
);
