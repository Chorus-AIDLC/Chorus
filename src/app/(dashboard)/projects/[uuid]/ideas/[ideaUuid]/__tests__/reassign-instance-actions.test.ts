import { describe, it, expect, vi, beforeEach } from "vitest";
import type { UserAuthContext, AuthContext } from "@/types/auth";

const mockGetServerAuthContext = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth-server", () => ({
  getServerAuthContext: mockGetServerAuthContext,
}));

const mockAssignIdea = vi.hoisted(() => vi.fn());
const mockGetIdeaByUuid = vi.hoisted(() => vi.fn());
vi.mock("@/services/idea.service", () => ({
  // Sibling actions in the same module import these; stub them so the module
  // loads without pulling in prisma transitively.
  assignIdea: mockAssignIdea,
  releaseIdea: vi.fn(),
  getIdeaByUuid: mockGetIdeaByUuid,
}));

vi.mock("@/services/agent.service", () => ({
  getAssignableAgents: vi.fn(),
  getCompanyUsers: vi.fn(),
}));

vi.mock("@/services/daemon-connection.service", () => ({
  listConnectionsForAgent: vi.fn(),
}));

// createActivity is the wake trigger; the non-waking action must NEVER call it.
const mockCreateActivity = vi.hoisted(() => vi.fn());
vi.mock("@/services/activity.service", () => ({
  createActivity: mockCreateActivity,
}));

const mockRevalidatePath = vi.hoisted(() => vi.fn());
vi.mock("next/cache", () => ({
  revalidatePath: mockRevalidatePath,
}));

vi.mock("@/lib/logger", () => {
  const noopLogger = {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => noopLogger),
  };
  return { default: noopLogger };
});

import { reassignIdeaInstanceNoWakeAction } from "../actions";

const COMPANY_A = "company-a";
const PROJECT_UUID = "project-1";
const IDEA_UUID = "idea-1";
const AGENT_UUID = "agent-1";
const INSTANCE_UUID = "instance-1";

function humanAuth(companyUuid = COMPANY_A): UserAuthContext {
  return {
    type: "user",
    companyUuid,
    actorUuid: "user-1",
    email: "u@test.com",
  };
}

// getServerAuthContext only ever returns a user context in production, but we
// force an agent-type context to prove the action's user/super_admin gate.
function agentAuth(companyUuid = COMPANY_A): AuthContext {
  return {
    type: "agent",
    companyUuid,
    actorUuid: AGENT_UUID,
  };
}

function makeIdeaRow(
  overrides: Partial<{ uuid: string; projectUuid: string; status: string }> = {},
) {
  return {
    uuid: IDEA_UUID,
    projectUuid: PROJECT_UUID,
    status: "open",
    assigneeType: "agent",
    assigneeUuid: AGENT_UUID,
    ...overrides,
  };
}

describe("reassignIdeaInstanceNoWakeAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns Unauthorized when there is no auth context", async () => {
    mockGetServerAuthContext.mockResolvedValue(null);

    const result = await reassignIdeaInstanceNoWakeAction(
      IDEA_UUID,
      AGENT_UUID,
      INSTANCE_UUID,
    );

    expect(result).toEqual({ success: false, error: "Unauthorized" });
    expect(mockAssignIdea).not.toHaveBeenCalled();
    expect(mockCreateActivity).not.toHaveBeenCalled();
  });

  it("rejects an agent-type caller and never touches the assignee", async () => {
    mockGetServerAuthContext.mockResolvedValue(agentAuth());

    const result = await reassignIdeaInstanceNoWakeAction(
      IDEA_UUID,
      AGENT_UUID,
      INSTANCE_UUID,
    );

    expect(result).toEqual({ success: false, error: "Unauthorized" });
    expect(mockGetIdeaByUuid).not.toHaveBeenCalled();
    expect(mockAssignIdea).not.toHaveBeenCalled();
    expect(mockCreateActivity).not.toHaveBeenCalled();
  });

  it("persists the agent_instance pin without emitting any wake activity", async () => {
    mockGetServerAuthContext.mockResolvedValue(humanAuth());
    mockGetIdeaByUuid.mockResolvedValue(makeIdeaRow());
    mockAssignIdea.mockResolvedValue(undefined);

    const result = await reassignIdeaInstanceNoWakeAction(
      IDEA_UUID,
      AGENT_UUID,
      INSTANCE_UUID,
    );

    expect(result).toEqual({ success: true });
    // Threads the durable instance pin into the non-waking service primitive so
    // it promotes the row to assigneeType="agent_instance".
    expect(mockAssignIdea).toHaveBeenCalledTimes(1);
    expect(mockAssignIdea).toHaveBeenCalledWith({
      ideaUuid: IDEA_UUID,
      companyUuid: COMPANY_A,
      assigneeType: "agent",
      assigneeUuid: AGENT_UUID,
      assignedByUuid: "user-1",
      instanceUuid: INSTANCE_UUID,
    });
    // The crux: NO `assigned` activity — that activity is what wakes today. No
    // activity → no wake notification/turn.
    expect(mockCreateActivity).not.toHaveBeenCalled();
    expect(mockRevalidatePath).toHaveBeenCalledWith(
      `/projects/${PROJECT_UUID}/ideas/${IDEA_UUID}`,
    );
  });

  it("rejects a foreign/missing instance and leaves the assignee unchanged", async () => {
    mockGetServerAuthContext.mockResolvedValue(humanAuth());
    mockGetIdeaByUuid.mockResolvedValue(makeIdeaRow());
    // resolveAssigneeFields inside assignIdea validates company ownership and
    // throws BEFORE any assignee write for a foreign/missing instance.
    mockAssignIdea.mockRejectedValue(new Error("Agent instance not found"));

    const result = await reassignIdeaInstanceNoWakeAction(
      IDEA_UUID,
      AGENT_UUID,
      "foreign-instance",
    );

    // Clean error result — the raw service message is not leaked.
    expect(result).toEqual({ success: false, error: "Failed to reassign idea" });
    // assignIdea threw before writing → no wake activity, no path revalidation.
    expect(mockCreateActivity).not.toHaveBeenCalled();
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("returns not-found for a missing/foreign-company idea", async () => {
    mockGetServerAuthContext.mockResolvedValue(humanAuth());
    mockGetIdeaByUuid.mockResolvedValue(null);

    const result = await reassignIdeaInstanceNoWakeAction(
      IDEA_UUID,
      AGENT_UUID,
      INSTANCE_UUID,
    );

    expect(result).toEqual({ success: false, error: "Idea not found" });
    expect(mockAssignIdea).not.toHaveBeenCalled();
    expect(mockCreateActivity).not.toHaveBeenCalled();
  });

  it("refuses to reassign an elaborated idea", async () => {
    mockGetServerAuthContext.mockResolvedValue(humanAuth());
    mockGetIdeaByUuid.mockResolvedValue(makeIdeaRow({ status: "elaborated" }));

    const result = await reassignIdeaInstanceNoWakeAction(
      IDEA_UUID,
      AGENT_UUID,
      INSTANCE_UUID,
    );

    expect(result).toEqual({
      success: false,
      error: "Idea is not available for assignment",
    });
    expect(mockAssignIdea).not.toHaveBeenCalled();
    expect(mockCreateActivity).not.toHaveBeenCalled();
  });
});
