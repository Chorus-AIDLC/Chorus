import type { NextRequest } from "next/server";
import { withErrorHandler } from "@/lib/api-handler";
import { getAuthContext } from "@/lib/auth";
import { error, errors, success } from "@/lib/api-response";
import type { AuthContext } from "@/types/auth";
import { deleteProjectAgentTeam, getProjectAgentTeam, ProjectTeamError, saveProjectAgentTeam } from "@/services/project-agent-team.service";
import { requireProjectAccess } from "@/services/project-access.service";

type Context = { params: Promise<{ uuid: string }> };

function handler(work: (auth: AuthContext, projectUuid: string, request: NextRequest) => Promise<unknown>) {
  return withErrorHandler(async (request: NextRequest, context: Context) => {
    const auth = await getAuthContext(request);
    if (!auth) return errors.unauthorized();
    if (auth.type !== "user") return errors.forbidden("User session required");
    await requireProjectAccess(auth, (await context.params).uuid, "viewer");
    try {
      return success(await work(auth, (await context.params).uuid, request));
    } catch (caught) {
      if (caught instanceof ProjectTeamError) return error(caught.code, caught.message, caught.details);
      throw caught;
    }
  });
}

export const GET = handler(async (auth, projectUuid) => ({ team: await getProjectAgentTeam(auth, projectUuid) }));
export const PUT = handler(async (auth, projectUuid, request) => ({
  team: await saveProjectAgentTeam(auth, projectUuid, await request.json().catch(() => null)),
}));
export const DELETE = handler(async (auth, projectUuid) => deleteProjectAgentTeam(auth, projectUuid));
