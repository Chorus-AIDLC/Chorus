import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthContext } from "@/types/auth";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  access: vi.fn(),
  getTask: vi.fn(),
  updateTask: vi.fn(),
  acceptanceGate: vi.fn(),
  replaceCriteria: vi.fn(),
}));

vi.mock("@/lib/auth-server", () => ({ getServerAuthContext: mocks.auth }));
vi.mock("@/lib/project-access-action", () => ({ denyUnlessEntityAccess: mocks.access }));
vi.mock("@/services/task.service", () => ({
  getTaskByUuid: mocks.getTask,
  updateTask: mocks.updateTask,
  checkAcceptanceCriteriaGate: mocks.acceptanceGate,
  replaceAcceptanceCriteria: mocks.replaceCriteria,
}));
vi.mock("@/services/agent.service", () => ({}));
vi.mock("@/services/daemon-connection.service", () => ({}));
vi.mock("@/services/project-agent-cwd.service", () => ({}));
vi.mock("@/services/activity.service", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { updateTaskFieldsAction, verifyTaskAction } from "../[uuid]/tasks/[taskUuid]/actions";

const auth: AuthContext = { type: "user", companyUuid: "company", actorUuid: "editor" };
const fields = { taskUuid: "task", projectUuid: "project", title: "Title", description: "Updated description" };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue(auth);
  mocks.access.mockResolvedValue(null);
  mocks.getTask.mockResolvedValue({ uuid: "task", projectUuid: "project", status: "to_verify" });
  mocks.acceptanceGate.mockResolvedValue({ allowed: true });
});

describe("task detail actor propagation", () => {
  it("attributes verification to the authenticated human", async () => {
    expect(await verifyTaskAction("task")).toEqual({ success: true });
    expect(mocks.updateTask).toHaveBeenCalledWith("task", { status: "done" }, {
      actorType: "user", actorUuid: "editor",
    });
  });

  it.each(["user", "agent", "super_admin"] as const)("attributes field edits to %s", async (type) => {
    mocks.auth.mockResolvedValue({ ...auth, type });
    expect(await updateTaskFieldsAction(fields)).toEqual({ success: true });
    expect(mocks.updateTask).toHaveBeenCalledWith("task", expect.objectContaining({
      title: fields.title, description: fields.description,
    }), { actorType: type, actorUuid: "editor" });
    expect(mocks.replaceCriteria).not.toHaveBeenCalled();
  });

  it.each([null, "agent", "super_admin"])("rejects verification by %s", async (type) => {
    mocks.auth.mockResolvedValue(type ? { ...auth, type } : null);
    expect((await verifyTaskAction("task")).success).toBe(false);
    expect(mocks.updateTask).not.toHaveBeenCalled();
  });

  it("preserves status and acceptance gates", async () => {
    mocks.getTask.mockResolvedValue({ status: "in_progress" });
    expect((await verifyTaskAction("task")).success).toBe(false);
    mocks.getTask.mockResolvedValue({ status: "to_verify" });
    mocks.acceptanceGate.mockResolvedValue({ allowed: false, reason: "Unverified criteria" });
    expect(await verifyTaskAction("task")).toEqual({ success: false, error: "Unverified criteria" });
    expect(mocks.updateTask).not.toHaveBeenCalled();
  });

  it("preserves project access denial for both actions", async () => {
    const denied = { success: false, error: "Insufficient project access" };
    mocks.access.mockResolvedValue(denied);
    expect(await verifyTaskAction("task")).toEqual(denied);
    expect(await updateTaskFieldsAction(fields)).toEqual(denied);
    expect(mocks.updateTask).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated field edits and missing tasks", async () => {
    mocks.auth.mockResolvedValue(null);
    expect((await updateTaskFieldsAction(fields)).success).toBe(false);
    mocks.auth.mockResolvedValue(auth);
    mocks.getTask.mockResolvedValue(null);
    expect((await updateTaskFieldsAction(fields)).success).toBe(false);
    expect((await verifyTaskAction("task")).success).toBe(false);
    expect(mocks.updateTask).not.toHaveBeenCalled();
  });
});
