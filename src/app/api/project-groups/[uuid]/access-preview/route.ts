import { NextRequest } from "next/server";
import { withErrorHandler } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { getAuthContext, checkAgentPermission } from "@/lib/auth";
import { isProjectVisibility } from "@/services/project-access.service";
import { getGroupVisibilityPreview } from "@/services/project-group-preview.service";

export const GET = withErrorHandler(async (request: NextRequest, context: { params: Promise<{ uuid: string }> }) => {
  const auth = await getAuthContext(request);
  if (!auth) return errors.unauthorized();
  const denied = checkAgentPermission(auth, "project:read");
  if (denied) return denied;
  const visibility = request.nextUrl.searchParams.get("visibility");
  if (!isProjectVisibility(visibility)) return errors.validationError({ visibility: "Invalid visibility" });
  const { uuid } = await context.params;
  return success(await getGroupVisibilityPreview(auth, uuid, visibility));
});
