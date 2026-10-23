import type { NextRequest } from "next/server";
import { deleteAgentTeam, getAgentTeam, updateAgentTeam } from "@/services/agent-team.service";
import { handleAgentTeamRequest, readAgentTeamBody } from "../handler";

type Context = { params: Promise<{ uuid: string }> };

export async function GET(request: NextRequest, context: Context) {
  return handleAgentTeamRequest(request, async (auth) => getAgentTeam(auth, (await context.params).uuid));
}

export async function PATCH(request: NextRequest, context: Context) {
  return handleAgentTeamRequest(request, async (auth) => {
    const { uuid } = await context.params;
    await getAgentTeam(auth, uuid);
    return updateAgentTeam(auth, uuid, await readAgentTeamBody(request));
  });
}

export async function DELETE(request: NextRequest, context: Context) {
  return handleAgentTeamRequest(request, async (auth) => deleteAgentTeam(auth, (await context.params).uuid));
}
