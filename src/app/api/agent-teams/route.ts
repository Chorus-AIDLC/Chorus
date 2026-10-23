import type { NextRequest } from "next/server";
import { createAgentTeam, listAgentTeams } from "@/services/agent-team.service";
import { handleAgentTeamRequest, readAgentTeamBody } from "./handler";

export async function GET(request: NextRequest) {
  return handleAgentTeamRequest(request, (auth) => listAgentTeams(auth));
}

export async function POST(request: NextRequest) {
  return handleAgentTeamRequest(request, async (auth) => createAgentTeam(auth, await readAgentTeamBody(request)));
}
