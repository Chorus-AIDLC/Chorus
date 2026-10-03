import { NextRequest } from "next/server";
import { withErrorHandler } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { getAuthContext, checkAgentPermission } from "@/lib/auth";
import { getProjectGroupMovePreview } from "@/services/project-group-preview.service";

export const GET = withErrorHandler(async (request: NextRequest, context: { params: Promise<{ uuid: string }> }) => {
  const auth = await getAuthContext(request);
  if (!auth) return errors.unauthorized();
  const denied = checkAgentPermission(auth, "project:read");
  if (denied) return denied;
  const { uuid } = await context.params;
  const value = request.nextUrl.searchParams.get("groupUuid");
  return success(await getProjectGroupMovePreview(auth, uuid, !value || value === "null" ? null : value));
});
