import type { NextRequest } from "next/server";
import { listAgentTeamCandidates } from "@/services/agent-team.service";
import { handleAgentTeamRequest } from "../handler";

export async function GET(request: NextRequest) {
  return handleAgentTeamRequest(request, (auth) => listAgentTeamCandidates(auth));
}
