import { NextRequest } from "next/server";
import { withErrorHandler, parseBody } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { getAuthContext, checkAgentPermission } from "@/lib/auth";
import { isProjectMemberRole } from "@/services/project-access.service";
import { updateGroupMember, removeGroupMember } from "@/services/project-group-member.service";

type Context = { params: Promise<{ uuid: string; userUuid: string }> };
export const PATCH = withErrorHandler(async (request: NextRequest, context: Context) => {
  const auth = await getAuthContext(request);
  if (!auth) return errors.unauthorized();
  const denied = checkAgentPermission(auth, "project:write");
  if (denied) return denied;
  const body = await parseBody<{ role: string }>(request);
  if (!isProjectMemberRole(body.role)) return errors.validationError({ role: "Invalid role" });
  const { uuid, userUuid } = await context.params;
  return success(await updateGroupMember(auth, uuid, userUuid, body.role));
});

export const DELETE = withErrorHandler(async (request: NextRequest, context: Context) => {
  const auth = await getAuthContext(request);
  if (!auth) return errors.unauthorized();
  const denied = checkAgentPermission(auth, "project:write");
  if (denied) return denied;
  const { uuid, userUuid } = await context.params;
  return success(await removeGroupMember(auth, uuid, userUuid));
});
