import { describe, it, expect, vi, beforeEach } from "vitest";
import type { UserAuthContext, AuthContext } from "@/types/auth";

const mockGetServerAuthContext = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth-server", () => ({
  getServerAuthContext: mockGetServerAuthContext,
}));

const mockClaimTask = vi.hoisted(() => vi.fn());
const mockGetTaskByUuid = vi.hoisted(() => vi.fn());
vi.mock("@/services/task.service", () => ({
  // Sibling actions in the same module import these; stub them so the module
  // loads without pulling in prisma transitively.
  claimTask: mockClaimTask,
  getTaskByUuid: mockGetTaskByUuid,
  updateTask: vi.fn(),
  releaseTask: vi.fn(),
  createTask: vi.fn(),
  deleteTask: vi.fn(),
  checkAcceptanceCriteriaGate: vi.fn(),
  replaceAcceptanceCriteria: vi.fn(),
}));

vi.mock("@/services/agent.service", () => ({
  getAssignableAgents: vi.fn(),
  getCompanyUsers: vi.fn(),
}));

vi.mock("@/services/daemon-connection.service", () => ({
  listConnectionsForAgent: vi.fn(),
}));

const mockResolveProjectAgentCwdTarget = vi.hoisted(() => vi.fn());
vi.mock("@/services/project-agent-cwd.service", () => ({
  resolveProjectAgentCwdTarget: mockResolveProjectAgentCwdTarget,
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

import {
  claimTaskToAgentAction,
  reassignTaskInstanceNoWakeAction,
} from "../actions";

const COMPANY_A = "company-a";
const PROJECT_UUID = "project-1";
const TASK_UUID = "task-1";
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

function makeTaskRow(
  overrides: Partial<{ uuid: string; projectUuid: string; status: string }> = {},
) {
  return {
    uuid: TASK_UUID,
    projectUuid: PROJECT_UUID,
    status: "open",
    assigneeType: "agent",
    assigneeUuid: AGENT_UUID,
    ...overrides,
  };
}

describe("reassignTaskInstanceNoWakeAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns Unauthorized when there is no auth context", async () => {
    mockGetServerAuthContext.mockResolvedValue(null);

    const result = await reassignTaskInstanceNoWakeAction(
      TASK_UUID,
      AGENT_UUID,
      INSTANCE_UUID,
    );

    expect(result).toEqual({ success: false, error: "Unauthorized" });
    expect(mockClaimTask).not.toHaveBeenCalled();
    expect(mockCreateActivity).not.toHaveBeenCalled();
  });

  it("rejects an agent-type caller and never touches the assignee", async () => {
    mockGetServerAuthContext.mockResolvedValue(agentAuth());

    const result = await reassignTaskInstanceNoWakeAction(
      TASK_UUID,
      AGENT_UUID,
      INSTANCE_UUID,
    );

    expect(result).toEqual({ success: false, error: "Unauthorized" });
    expect(mockGetTaskByUuid).not.toHaveBeenCalled();
    expect(mockClaimTask).not.toHaveBeenCalled();
    expect(mockCreateActivity).not.toHaveBeenCalled();
  });

  it("persists the agent_instance pin without emitting any wake activity", async () => {
    mockGetServerAuthContext.mockResolvedValue(humanAuth());
    mockGetTaskByUuid.mockResolvedValue(makeTaskRow());
    mockClaimTask.mockResolvedValue(undefined);

    const result = await reassignTaskInstanceNoWakeAction(
      TASK_UUID,
      AGENT_UUID,
      INSTANCE_UUID,
    );

    expect(result).toEqual({ success: true });
    // Threads the durable instance pin into the non-waking service primitive so
    // it promotes the row to assigneeType="agent_instance".
    expect(mockClaimTask).toHaveBeenCalledTimes(1);
    expect(mockClaimTask).toHaveBeenCalledWith({
      taskUuid: TASK_UUID,
      companyUuid: COMPANY_A,
      assigneeType: "agent",
      assigneeUuid: AGENT_UUID,
      assignedByType: "user",
      assignedByUuid: "user-1",
      instanceUuid: INSTANCE_UUID,
    });
    // The crux: NO `assigned` activity — that activity is what wakes today. No
    // activity → no wake notification/turn.
    expect(mockCreateActivity).not.toHaveBeenCalled();
    expect(mockRevalidatePath).toHaveBeenCalledWith(
      `/projects/${PROJECT_UUID}/tasks/${TASK_UUID}`,
    );
  });

  it("rejects a foreign/missing instance and leaves the assignee unchanged", async () => {
    mockGetServerAuthContext.mockResolvedValue(humanAuth());
    mockGetTaskByUuid.mockResolvedValue(makeTaskRow());
    // resolveTaskAssigneeFields inside claimTask validates company ownership and
    // throws BEFORE any assignee write for a foreign/missing instance.
    mockClaimTask.mockRejectedValue(new Error("Agent instance not found"));

    const result = await reassignTaskInstanceNoWakeAction(
      TASK_UUID,
      AGENT_UUID,
      "foreign-instance",
    );

    // Clean error result — the raw service message is not leaked.
    expect(result).toEqual({ success: false, error: "Failed to reassign task" });
    // claimTask threw before writing → no wake activity, no path revalidation.
    expect(mockCreateActivity).not.toHaveBeenCalled();
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("returns not-found for a missing/foreign-company task", async () => {
    mockGetServerAuthContext.mockResolvedValue(humanAuth());
    mockGetTaskByUuid.mockResolvedValue(null);

    const result = await reassignTaskInstanceNoWakeAction(
      TASK_UUID,
      AGENT_UUID,
      INSTANCE_UUID,
    );

    expect(result).toEqual({ success: false, error: "Task not found" });
    expect(mockClaimTask).not.toHaveBeenCalled();
    expect(mockCreateActivity).not.toHaveBeenCalled();
  });

  it("refuses to reassign a task that is not open/assigned", async () => {
    mockGetServerAuthContext.mockResolvedValue(humanAuth());
    mockGetTaskByUuid.mockResolvedValue(makeTaskRow({ status: "in_progress" }));

    const result = await reassignTaskInstanceNoWakeAction(
      TASK_UUID,
      AGENT_UUID,
      INSTANCE_UUID,
    );

    expect(result).toEqual({
      success: false,
      error: "Task is not available for claiming",
    });
    expect(mockClaimTask).not.toHaveBeenCalled();
    expect(mockCreateActivity).not.toHaveBeenCalled();
  });
});

describe("claimTaskToAgentAction fixed cwd", () => {
  it("persists the selected Agent's own fixed instance", async () => {
    mockGetServerAuthContext.mockResolvedValue(humanAuth());
    mockGetTaskByUuid.mockResolvedValue(makeTaskRow());
    mockResolveProjectAgentCwdTarget.mockResolvedValue({
      source: "project_fixed",
      agentInstanceUuid: "agent-b-fixed-instance",
      host: "fixed-host",
      cwd: "/discovered/task",
    });
    mockClaimTask.mockResolvedValue(undefined);
    mockCreateActivity.mockResolvedValue(undefined);

    await claimTaskToAgentAction(TASK_UUID, AGENT_UUID, "agent-a-instance");

    expect(mockClaimTask).toHaveBeenCalledWith(
      expect.objectContaining({
        instanceUuid: "agent-b-fixed-instance",
        cwdSource: "project_fixed",
        cwdHost: "fixed-host",
        runtimeCwd: "/discovered/task",
      }),
    );
    expect(mockCreateActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        value: expect.objectContaining({
          instanceUuid: "agent-b-fixed-instance",
          resolvedCwdSource: "project_fixed",
          resolvedCwdHost: "fixed-host",
          resolvedRuntimeCwd: "/discovered/task",
        }),
      }),
    );
  });

  it("keeps the existing picker selection when no fixed target exists", async () => {
    mockGetServerAuthContext.mockResolvedValue(humanAuth());
    mockGetTaskByUuid.mockResolvedValue(makeTaskRow());
    mockResolveProjectAgentCwdTarget.mockResolvedValue({
      source: "unconfigured",
      agentInstanceUuid: null,
      host: null,
      cwd: null,
    });

    await claimTaskToAgentAction(TASK_UUID, AGENT_UUID, INSTANCE_UUID);

    expect(mockClaimTask).toHaveBeenCalledWith(
      expect.objectContaining({ instanceUuid: INSTANCE_UUID }),
    );
  });
});
