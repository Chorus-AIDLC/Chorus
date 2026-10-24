import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ZodType } from "zod";
import type { AgentAuthContext } from "@/types/auth";
import type { Permission } from "@/lib/authz/types";
import { ApiError } from "@/lib/api-handler";

const mocks = vi.hoisted(() => ({ issue: vi.fn(), assign: vi.fn(), activity: vi.fn() }));
vi.mock("@/services/idea-assignment-authorization.service", () => ({ issueIdeaAssignmentAuthorization: mocks.issue }));
vi.mock("@/services/idea.service", () => ({ assignIdea: mocks.assign }));
vi.mock("@/services/activity.service", () => ({ createActivity: mocks.activity }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/services/project.service", () => ({ projectExists: vi.fn() }));
vi.mock("@/services/task.service", () => ({}));
vi.mock("@/services/proposal.service", () => ({}));
vi.mock("@/services/document.service", () => ({}));
vi.mock("@/services/elaboration.service", () => ({}));
import { registerPmTools } from "@/mcp/tools/pm";
import { TOOL_PERMISSIONS } from "@/mcp/tools/permission-map";

type Handler = (input: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
const tools: Record<string, { inputSchema: ZodType; handler: Handler }> = {};
const name = "chorus_prepare_idea_assignment";
const ideaUuid = "4da07961-bd7a-4cff-a17a-25e30437ae5b";
const agentUuid = "160c2bd7-7eb9-4f49-a3e7-c868022c6aca";
const commentUuid = "673ab818-768e-47c3-9302-3f3955770b68";
const auth: AgentAuthContext = {
  type: "agent", companyUuid: "company-1", actorUuid: "executor-1", ownerUuid: "owner-1",
  roles: ["admin_agent"], permissions: ["idea:admin"], agentName: "Executor",
};
const proof = { uuid: "d08c45fd-cfd6-4b3f-8693-04bcf4c8dc0b", ideaUuid, agentUuid, expiresAt: new Date("2026-10-25T00:00:00Z") };

function register(permissions: Permission[] = ["idea:admin"]) {
  for (const key of Object.keys(tools)) delete tools[key];
  const server = { registerTool(toolName: string, metadata: { inputSchema: ZodType }, handler: Handler) {
    tools[toolName] = { inputSchema: metadata.inputSchema, handler };
  } };
  registerPmTools(server as unknown as Parameters<typeof registerPmTools>[0], { ...auth, permissions });
}

async function invoke(input: unknown) {
  return tools[name].handler(tools[name].inputSchema.parse(input) as Record<string, unknown>);
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.issue.mockResolvedValue({ ...proof, humanUuid: "owner-1", sourceUuid: commentUuid, sourceDigest: "private-digest", generation: 5, consumedOperationUuid: null });
  register();
});

describe("chorus_prepare_idea_assignment", () => {
  it("requires idea:admin in registration and the permission inventory", () => {
    expect((TOOL_PERMISSIONS as Record<string, string>)[name]).toBe("idea:admin");
    expect(tools[name]).toBeDefined();
    register(["idea:write"]);
    expect(tools[name]).toBeUndefined();
  });

  it("delegates source validation using authenticated agent identity and returns only public proof fields", async () => {
    const response = await invoke({ ideaUuid, agentUuid, commentUuid });
    expect(mocks.issue).toHaveBeenCalledWith(auth, { ideaUuid, agentUuid, commentUuid });
    expect(JSON.parse(response.content[0].text)).toEqual({ ...proof, expiresAt: proof.expiresAt.toISOString() });
    expect(mocks.assign).not.toHaveBeenCalled();
    expect(mocks.activity).not.toHaveBeenCalled();
  });

  it("never forwards forged human identity, textual consent or confirmation authority from extra input fields", async () => {
    await invoke({ ideaUuid, agentUuid, commentUuid,
      auth: { type: "user", actorUuid: "forged-human" }, humanUuid: "forged-human", authorType: "user",
      content: `chorus:assign ${agentUuid}`, requestUuid: commentUuid, sourceDigest: "forged-digest",
    });
    expect(mocks.issue).toHaveBeenCalledWith(auth, { ideaUuid, agentUuid, commentUuid });
  });

  it.each([
    { ideaUuid, agentUuid }, { ideaUuid, agentUuid, requestUuid: commentUuid },
    { ideaUuid: "bad", agentUuid, commentUuid }, { ideaUuid, agentUuid: "bad", commentUuid },
    { ideaUuid, agentUuid, commentUuid: "bad" }, { ideaUuid, agentUuid, commentUuid: null },
  ])("rejects missing or invalid source binding through the registered schema: %j", async (input) => {
    await expect(invoke(input)).rejects.toThrow();
    expect(mocks.issue).not.toHaveBeenCalled();
  });

  it("propagates rejection of unverified human consent without assignment or publication", async () => {
    const error = new ApiError("FORBIDDEN", "A standalone human chorus:assign command on this Idea is required", 403);
    mocks.issue.mockRejectedValue(error);
    await expect(invoke({ ideaUuid, agentUuid, commentUuid })).rejects.toBe(error);
    expect(mocks.assign).not.toHaveBeenCalled();
    expect(mocks.activity).not.toHaveBeenCalled();
  });
});
