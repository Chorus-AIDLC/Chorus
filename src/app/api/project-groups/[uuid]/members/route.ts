// src/app/api/project-groups/[uuid]/members/route.ts
// Project Group Members API - List, Add, Remove (Project Visibility — Tech Design §5)
// UUID-Based Architecture: All operations use UUIDs
//
// Leak rule: an inaccessible group must look like it does not exist (404).
// An accessible group the actor cannot MANAGE (i.e. is not the owner) yields
// 403 on mutations. Listing members only requires access (read).

import { NextRequest } from "next/server";
import { withErrorHandler, parseBody } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { getAuthContext, isUser, isAgent, hasPermission, checkAgentPermission } from "@/lib/auth";
import {
  listGroupMembers,
  addGroupMember,
  removeGroupMember,
} from "@/services/project-group.service";
import { canAccessGroup, canManageGroup } from "@/lib/authz/project-access";

type RouteContext = { params: Promise<{ uuid: string }> };

type MemberType = "user" | "agent";

function isMemberType(value: unknown): value is MemberType {
  return value === "user" || value === "agent";
}

// GET /api/project-groups/[uuid]/members - List group members
export const GET = withErrorHandler<{ uuid: string }>(
  async (request: NextRequest, context: RouteContext) => {
    const auth = await getAuthContext(request);
    if (!auth) {
      return errors.unauthorized();
    }
    const denied = checkAgentPermission(auth, "project:read");
    if (denied) return denied;

    const { uuid: groupUuid } = await context.params;

    // Must be able to access the group; otherwise hide its existence.
    if (!(await canAccessGroup(auth, groupUuid))) {
      return errors.notFound("Project group");
    }

    const members = await listGroupMembers(auth.companyUuid, groupUuid);
    return success({ members });
  }
);

// POST /api/project-groups/[uuid]/members - Add a member (owner-only)
export const POST = withErrorHandler<{ uuid: string }>(
  async (request: NextRequest, context: RouteContext) => {
    const auth = await getAuthContext(request);
    if (!auth) {
      return errors.unauthorized();
    }

    // Managing members requires project:write for agents, or a human user.
    if (isAgent(auth)) {
      if (!hasPermission(auth, "project:write")) {
        return errors.forbidden("Missing permission: project:write");
      }
    } else if (!isUser(auth)) {
      return errors.forbidden("Only users or permitted agents can manage project group members");
    }

    const { uuid: groupUuid } = await context.params;

    // Leak rule: inaccessible -> 404; accessible but not owner -> 403.
    if (!(await canAccessGroup(auth, groupUuid))) {
      return errors.notFound("Project group");
    }
    if (!(await canManageGroup(auth, groupUuid))) {
      return errors.forbidden("Only the project group owner can manage members");
    }

    const body = await parseBody<{
      memberType?: string;
      memberUuid?: string;
    }>(request);

    if (!isMemberType(body.memberType)) {
      return errors.validationError({ memberType: "memberType must be 'user' or 'agent'" });
    }
    if (!body.memberUuid || body.memberUuid.trim() === "") {
      return errors.validationError({ memberUuid: "memberUuid is required" });
    }

    const member = await addGroupMember(
      auth.companyUuid,
      groupUuid,
      body.memberType,
      body.memberUuid.trim()
    );
    if (!member) {
      return errors.notFound("Project group");
    }

    return success(member);
  }
);

// DELETE /api/project-groups/[uuid]/members?memberType=...&memberUuid=... - Remove a member (owner-only)
export const DELETE = withErrorHandler<{ uuid: string }>(
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
      return errors.forbidden("Only users or permitted agents can manage project group members");
    }

    const { uuid: groupUuid } = await context.params;

    // Leak rule: inaccessible -> 404; accessible but not owner -> 403.
    if (!(await canAccessGroup(auth, groupUuid))) {
      return errors.notFound("Project group");
    }
    if (!(await canManageGroup(auth, groupUuid))) {
      return errors.forbidden("Only the project group owner can manage members");
    }

    // Accept memberType + memberUuid from query params, falling back to the body.
    const url = new URL(request.url);
    let memberType: string | null = url.searchParams.get("memberType");
    let memberUuid: string | null = url.searchParams.get("memberUuid");

    if (!memberType || !memberUuid) {
      const body = await parseBody<{ memberType?: string; memberUuid?: string }>(request).catch(
        () => ({} as { memberType?: string; memberUuid?: string })
      );
      memberType = memberType ?? body.memberType ?? null;
      memberUuid = memberUuid ?? body.memberUuid ?? null;
    }

    if (!isMemberType(memberType)) {
      return errors.validationError({ memberType: "memberType must be 'user' or 'agent'" });
    }
    if (!memberUuid || memberUuid.trim() === "") {
      return errors.validationError({ memberUuid: "memberUuid is required" });
    }

    const removed = await removeGroupMember(
      auth.companyUuid,
      groupUuid,
      memberType,
      memberUuid.trim()
    );
    if (!removed) {
      return errors.notFound("Member");
    }

    return success({ removed: true });
  }
);
