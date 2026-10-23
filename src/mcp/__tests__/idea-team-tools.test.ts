import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AgentAuthContext } from "@/types/auth";
import type { Permission } from "@/lib/authz/types";
import { getToolProjectAccessPolicy, TOOL_PERMISSIONS, TOOL_READ_PERMISSIONS } from "../tools/permission-map";
import { TOOL_COLLECTION_CLASSIFICATION } from "../tools/collection-contract";

const mocks = vi.hoisted(() => ({ context: vi.fn(), recommend: vi.fn(), delegate: vi.fn() }));
vi.mock("@/services/idea-team.service", () => ({ getIdeaTeamContext: mocks.context, recommendIdeaTeamRole: mocks.recommend, delegateIdeaTeamProduct: mocks.delegate }));
import { registerIdeaTeamTools } from "../tools/idea-team";

type Handler = (input: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
function register(permissions: Permission[] = ["idea:read", "idea:write"]) {
  const handlers: Record<string, Handler> = {};
  const schemas: Record<string, { parse: (input: unknown) => unknown }> = {};
  const server = { registerTool: (name: string, config: { inputSchema: { parse: (input: unknown) => unknown } }, handler: Handler) => { handlers[name] = handler; schemas[name] = config.inputSchema; } };
  const auth: AgentAuthContext = { type: "agent", companyUuid: "company", actorUuid: "agent", ownerUuid: "owner", agentName: "Agent", roles: [], permissions };
  registerIdeaTeamTools(server as unknown as McpServer, auth);
  return { handlers, schemas, auth };
}
beforeEach(() => { vi.resetAllMocks(); });

describe("Idea Team MCP contracts", () => {
  it("gates registration and reviews project/collection policies", () => {
    expect(Object.keys(register([]).handlers)).toEqual([]);
    expect(Object.keys(register(["idea:read"]).handlers)).toEqual(["chorus_get_idea_team_context", "chorus_recommend_team_agent"]);
    for (const name of ["chorus_get_idea_team_context", "chorus_recommend_team_agent"] as const) {
      expect(TOOL_READ_PERMISSIONS[name]).toBe("idea:read");
      expect(TOOL_COLLECTION_CLASSIFICATION[name]).toBe("non-collection");
      expect(getToolProjectAccessPolicy(name)).toEqual({ scope: "resource", required: "viewer" });
    }
    expect(TOOL_PERMISSIONS.chorus_delegate_team_product).toBe("idea:write");
    expect(getToolProjectAccessPolicy("chorus_delegate_team_product")).toEqual({ scope: "resource", required: "editor" });
  });
  it("forwards authenticated identity and exact entity scope", async () => {
    const { handlers, auth } = register();
    mocks.context.mockResolvedValue({ managed: false });
    const output = await handlers.chorus_get_idea_team_context({ ideaUuid: "idea" });
    expect(JSON.parse(output.content[0].text)).toEqual({ managed: false });
    expect(mocks.context).toHaveBeenCalledWith(auth, "idea");
    mocks.recommend.mockResolvedValue({ decision: "lead_decision" });
    await handlers.chorus_recommend_team_agent({ ideaUuid: "idea", role: "development", taskUuid: "task" });
    expect(mocks.recommend).toHaveBeenCalledWith(auth, "idea", "development", "task");
  });
  it("delegates without calling Idea claim or reassignment", async () => {
    const { handlers, auth } = register();
    mocks.delegate.mockResolvedValue({ delegated: true });
    await handlers.chorus_delegate_team_product({ ideaUuid: "idea", agentUuid: "product" });
    expect(mocks.delegate).toHaveBeenCalledWith(auth, "idea", "product");
  });
  it("does not swallow owner privacy or current-lead denials", async () => {
    const { handlers } = register();
    mocks.recommend.mockRejectedValue(new Error("Owner-private"));
    mocks.delegate.mockRejectedValue(new Error("Current lead required"));
    await expect(handlers.chorus_recommend_team_agent({ ideaUuid: "idea", role: "product" })).rejects.toThrow("Owner-private");
    await expect(handlers.chorus_delegate_team_product({ ideaUuid: "idea", agentUuid: "product" })).rejects.toThrow("Current lead required");
  });
  it("rejects malformed UUIDs and unsupported review routing", () => {
    const { schemas } = register();
    expect(() => schemas.chorus_get_idea_team_context.parse({ ideaUuid: "bad" })).toThrow();
    expect(() => schemas.chorus_recommend_team_agent.parse({ ideaUuid: "11111111-1111-4111-8111-111111111111", role: "review" })).toThrow();
  });
});
