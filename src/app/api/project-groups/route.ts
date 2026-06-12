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

  const result = await listProjectGroups(auth.companyUuid, auth);
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

  const body = await parseBody<{
    name: string;
    description?: string;
    visibility?: string;
    memberUuids?: { memberType?: string; memberUuid?: string }[];
  }>(request);
  if (!body.name || body.name.trim() === "") {
    return errors.validationError({ name: "Name is required" });
  }
  if (body.visibility !== undefined && body.visibility !== "shared" && body.visibility !== "private") {
    return errors.validationError({ visibility: "visibility must be 'shared' or 'private'" });
  }

  // Owner = the acting human or agent. Super admin creates an owner-less group.
  const ownerType: "user" | "agent" | null =
    isUser(auth) || isAgent(auth) ? auth.type : null;
  const ownerUuid: string | null =
    isUser(auth) || isAgent(auth) ? auth.actorUuid : null;

  const memberUuids = (body.memberUuids ?? [])
    .filter(
      (m): m is { memberType: "user" | "agent"; memberUuid: string } =>
        (m.memberType === "user" || m.memberType === "agent") &&
        typeof m.memberUuid === "string" &&
        m.memberUuid.trim() !== ""
    )
    .map((m) => ({ memberType: m.memberType, memberUuid: m.memberUuid.trim() }));

  const group = await createProjectGroup({
    companyUuid: auth.companyUuid,
    name: body.name.trim(),
    description: body.description?.trim() || null,
    visibility: body.visibility as "shared" | "private" | undefined,
    ownerType,
    ownerUuid,
    memberUuids,
  });

  return success(group);
});
