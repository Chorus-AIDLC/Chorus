// src/app/api/project-groups/route.ts
// Project Groups API - List and Create

import { NextRequest } from "next/server";
import { withErrorHandler, parseBody } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { getAuthContext, isUser, isAgent, hasPermission, checkAgentPermission } from "@/lib/auth";
import {
  listProjectGroups,
  createProjectGroup,
} from "@/services/project-group.service";

// GET /api/project-groups - List all groups
export const GET = withErrorHandler(async (request: NextRequest) => {
  const auth = await getAuthContext(request);
  if (!auth) return errors.unauthorized();
  const denied = checkAgentPermission(auth, "project:read");
  if (denied) return denied;

  const result = await listProjectGroups(auth.companyUuid);
  return success(result);
});

// POST /api/project-groups - Create a group
export const POST = withErrorHandler(async (request: NextRequest) => {
  const auth = await getAuthContext(request);
  if (!auth) return errors.unauthorized();
  if (isAgent(auth)) {
    if (!hasPermission(auth, "project:write")) {
      return errors.forbidden("Missing permission: project:write");
    }
  } else if (!isUser(auth)) {
    return errors.forbidden("Only users or permitted agents can create project groups");
  }

  const body = await parseBody<{ name: string; description?: string }>(request);
  if (!body.name || body.name.trim() === "") {
    return errors.validationError({ name: "Name is required" });
  }

  const group = await createProjectGroup({
    companyUuid: auth.companyUuid,
    name: body.name.trim(),
    description: body.description?.trim() || null,
  });

  return success(group);
});
