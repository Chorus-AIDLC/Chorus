import { NextRequest } from "next/server";
import { withErrorHandler } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { getAuthContext, isUser } from "@/lib/auth";
import { listAvailableAgentCwdOptions } from "@/services/project-agent-cwd.service";

export const GET = withErrorHandler(async (request: NextRequest) => {
  const auth = await getAuthContext(request);
  if (!auth) return errors.unauthorized();
  if (!isUser(auth)) return errors.forbidden("User session required");
  return success({
    agents: await listAvailableAgentCwdOptions(auth.companyUuid, auth.actorUuid),
  });
});
