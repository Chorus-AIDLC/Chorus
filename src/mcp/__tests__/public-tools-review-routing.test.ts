import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import type { AgentAuthContext } from "@/types/auth";
import { registerPublicTools } from "@/mcp/tools/public";

const recommend = vi.hoisted(() => vi.fn());
vi.mock("@/services/idea-team.service", () => ({ recommendIdeaTeamRole: recommend }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));

type ToolHandler = (params: Record<string, unknown>) => Promise<unknown>;
const tools = new Map<string, { config: { description: string; inputSchema: z.ZodType }; handler: ToolHandler }>();
const auth: AgentAuthContext = {
  type: "agent", companyUuid: randomUUID(), actorUuid: randomUUID(), ownerUuid: randomUUID(),
  agentName: "Reviewer", roles: [], permissions: ["idea:read"],
};

beforeEach(() => {
  vi.clearAllMocks();
  tools.clear();
  registerPublicTools({ registerTool: (name: string, config: { description: string; inputSchema: z.ZodType }, handler: ToolHandler) => tools.set(name, { config, handler }) } as never, auth);
});

describe("chorus_recommend_team_agent review schema", () => {
  it.each(["idea", "proposal", "task"])("accepts and forwards the %s review target", async (targetType) => {
    const tool = tools.get("chorus_recommend_team_agent")!;
    const params = { ideaUuid: randomUUID(), role: "review", ...(targetType === "proposal" ? { proposalUuid: randomUUID() } : {}), ...(targetType === "task" ? { taskUuid: randomUUID() } : {}) };
    const parsed = tool.config.inputSchema.parse(params) as Record<string, unknown>;
    recommend.mockResolvedValue({ decision: "recommended", reason: "minimum_load" });
    await tool.handler(parsed);
    expect(recommend).toHaveBeenCalledWith(auth, params.ideaUuid, "review", params.taskUuid, params.proposalUuid);
    expect(tool.config.description).toContain("review");
  });

  it.each(["product", "development"])("retains the %s schema without targets", (role) => {
    expect(tools.get("chorus_recommend_team_agent")!.config.inputSchema.safeParse({ ideaUuid: randomUUID(), role }).success).toBe(true);
  });

  it("rejects invalid review proposal UUIDs", () => {
    expect(tools.get("chorus_recommend_team_agent")!.config.inputSchema.safeParse({ ideaUuid: randomUUID(), role: "review", proposalUuid: "invalid" }).success).toBe(false);
  });
});
