import { NextRequest } from "next/server";
import { withErrorHandler } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { getAuthContext, checkAgentPermission } from "@/lib/auth";
import { requireEntityAccess } from "@/services/project-access.service";
import { getIdeaTeamContext } from "@/services/idea-team.service";

// Safe gate summary for the Idea detail panel. The private routing roster is never
// returned here, even to the Team owner.
export const GET = withErrorHandler<{ uuid: string }>(async (request: NextRequest, context) => {
  const auth = await getAuthContext(request);
  if (!auth) return errors.unauthorized();
  const denied = checkAgentPermission(auth, "idea:read");
  if (denied) return denied;
  const { uuid } = await context.params;
  await requireEntityAccess(auth, "idea", uuid, "viewer");
  const summary = await getIdeaTeamContext(auth, uuid);
  return success({ ...summary, routing: undefined });
});
