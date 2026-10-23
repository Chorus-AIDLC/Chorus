import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AgentAuthContext } from "@/types/auth";
import { getIdeaTeamContext, recommendIdeaTeamRole, delegateIdeaTeamProduct } from "@/services/idea-team.service";
import { enforceToolClassification } from "./collection-contract";
import { registerPermissionedTool } from "./register-helpers";

export function registerIdeaTeamTools(server: McpServer, auth: AgentAuthContext) {
  server = enforceToolClassification(server);
  const result = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });

  registerPermissionedTool(server, auth, "idea:read", "chorus_get_idea_team_context", {
    description: "Read an Idea's authoritative Team state and approval/verification gates. Shared viewers receive only safe gate responsibility; private routing context is restricted to the Team owner and their agents. Unmanaged Ideas retain their existing workflow. Never claim an unassigned Idea merely because a Team exists.",
    inputSchema: z.object({ ideaUuid: z.string().uuid().describe("Idea UUID") }),
    annotations: { readOnlyHint: true },
  }, async ({ ideaUuid }) => result(await getIdeaTeamContext(auth, ideaUuid)));

  registerPermissionedTool(server, auth, "idea:read", "chorus_recommend_team_agent", {
    description: "Recommend a product/development agent for an enrolled Idea using live eligibility, online status, load and task affinity. Owner-private; does not assign or wake anyone. Respect manual/paused/lead_decision results. Optional taskUuid must belong to this Idea.",
    inputSchema: z.object({
      ideaUuid: z.string().uuid().describe("Idea UUID"),
      role: z.enum(["product", "development"]),
      taskUuid: z.string().uuid().optional().describe("Related Task UUID for development affinity"),
    }),
    annotations: { readOnlyHint: true },
  }, async ({ ideaUuid, role, taskUuid }) => result(await recommendIdeaTeamRole(auth, ideaUuid, role, taskUuid)));

  registerPermissionedTool(server, auth, "idea:write", "chorus_delegate_team_product", {
    description: "Current active Idea lead delegates elaboration/proposal work to an eligible product agent, preserving the lead as the sole Idea assignee. Records a directed wake instruction. Does not grant permissions, resolve elaboration, approve proposals or verify tasks.",
    inputSchema: z.object({
      ideaUuid: z.string().uuid().describe("Idea UUID"),
      agentUuid: z.string().uuid().describe("Eligible product Agent UUID"),
    }),
  }, async ({ ideaUuid, agentUuid }) => result(await delegateIdeaTeamProduct(auth, ideaUuid, agentUuid)));
}
