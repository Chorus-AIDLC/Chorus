import type { NextRequest } from "next/server";
import { getAuthContext } from "@/lib/auth";
import { error, errors, success } from "@/lib/api-response";
import { withErrorHandler } from "@/lib/api-handler";
import { getRequestLogger } from "@/lib/request-context";
import { AgentTeamError } from "@/services/agent-team.service";
import type { AuthContext } from "@/types/auth";

export async function handleAgentTeamRequest(request: NextRequest, work: (auth: AuthContext) => Promise<unknown>) {
  return withErrorHandler(async () => {
    try {
      const auth = await getAuthContext(request);
      if (!auth) return errors.unauthorized();
      if (auth.type !== "user") return errors.forbidden("Only users can manage agent teams");
      return success(await work(auth));
    } catch (caught) {
      if (caught instanceof AgentTeamError) return error(caught.code, caught.message, caught.details);
      getRequestLogger().error({ err: caught }, "Agent team request failed");
      return errors.internal();
    }
  })(request, { params: Promise.resolve({}) });
}

export async function readAgentTeamBody(request: NextRequest): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new AgentTeamError("VALIDATION_ERROR", "Invalid JSON body");
  }
}
