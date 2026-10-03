import { NextRequest } from "next/server";
import { withErrorHandler } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { getAuthContext, checkAgentPermission } from "@/lib/auth";
import { isProjectVisibility, requireProjectOperation } from "@/services/project-access.service";
import { getProjectVisibilityPreview } from "@/services/project-access-preview.service";

export const GET = withErrorHandler(async (
  request: NextRequest, context: { params: Promise<{ uuid: string }> },
) => {
  const auth = await getAuthContext(request);
  if (!auth) return errors.unauthorized();
  const denied = checkAgentPermission(auth, "project:read");
  if (denied) return denied;
  const { uuid } = await context.params;
  const visibility = request.nextUrl.searchParams.get("visibility");
  if (!isProjectVisibility(visibility)) return errors.validationError({ visibility: "Visibility must be public or private" });
  await requireProjectOperation(auth, uuid, "change_visibility");
  return success(await getProjectVisibilityPreview(auth, uuid, visibility));
});
