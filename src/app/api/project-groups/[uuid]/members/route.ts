import { NextRequest } from "next/server";
import { withErrorHandler, parseBody } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { getAuthContext, checkAgentPermission } from "@/lib/auth";
import { isProjectMemberRole } from "@/services/project-access.service";
import { listGroupMembers, addGroupMember } from "@/services/project-group-member.service";

export const GET = withErrorHandler(async (request: NextRequest, context: { params: Promise<{ uuid: string }> }) => {
  const auth = await getAuthContext(request);
  if (!auth) return errors.unauthorized();
  const denied = checkAgentPermission(auth, "project:read");
  if (denied) return denied;
  const { uuid } = await context.params;
  return success({ members: await listGroupMembers(auth, uuid) });
});

export const POST = withErrorHandler(async (request: NextRequest, context: { params: Promise<{ uuid: string }> }) => {
  const auth = await getAuthContext(request);
  if (!auth) return errors.unauthorized();
  const denied = checkAgentPermission(auth, "project:write");
  if (denied) return denied;
  const body = await parseBody<{ userUuid: string; role: string }>(request);
  if (typeof body.userUuid !== "string" || !body.userUuid || !isProjectMemberRole(body.role)) return errors.validationError({ member: "User UUID and valid role required" });
  const { uuid } = await context.params;
  return success(await addGroupMember(auth, uuid, body.userUuid, body.role));
});
