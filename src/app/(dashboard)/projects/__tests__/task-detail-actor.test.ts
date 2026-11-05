import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthContext } from "@/types/auth";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  access: vi.fn(),
  getTask: vi.fn(),
  updateTask: vi.fn(),
  acceptanceGate: vi.fn(),
  replaceCriteria: vi.fn(),
  createTask: vi.fn(),
  projectAccess: vi.fn(),
  createActivity: vi.fn(),
  listIdeas: vi.fn(),
}));

vi.mock("@/lib/auth-server", () => ({ getServerAuthContext: mocks.auth }));
vi.mock("@/lib/project-access-action", () => ({
  denyUnlessEntityAccess: mocks.access,
  denyUnlessProjectAccess: mocks.projectAccess,
}));
vi.mock("@/services/task.service", () => ({
  getTaskByUuid: mocks.getTask,
  updateTask: mocks.updateTask,
  checkAcceptanceCriteriaGate: mocks.acceptanceGate,
  replaceAcceptanceCriteria: mocks.replaceCriteria,
  createTask: mocks.createTask,
}));
vi.mock("@/services/idea.service", () => ({ listIdeas: mocks.listIdeas }));
vi.mock("@/services/agent.service", () => ({}));
vi.mock("@/services/daemon-connection.service", () => ({}));
vi.mock("@/services/project-agent-cwd.service", () => ({}));
vi.mock("@/services/activity.service", () => ({ createActivity: mocks.createActivity }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { ApiError } from "@/lib/api-handler";
import { createTaskAction, updateTaskFieldsAction, verifyTaskAction, getTaskIdeaOptionsAction } from "../[uuid]/tasks/[taskUuid]/actions";

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

describe("task actions — direct Idea link (ideaUuid)", () => {
  beforeEach(() => {
    mocks.projectAccess.mockResolvedValue(null);
    mocks.createTask.mockResolvedValue({ uuid: "new-task" });
  });

  it("createTaskAction passes ideaUuid through and records it in activity", async () => {
    expect(await createTaskAction({ projectUuid: "project", title: "Fix", ideaUuid: "idea-1" }))
      .toEqual({ success: true, taskUuid: "new-task" });
    expect(mocks.createTask).toHaveBeenCalledWith(expect.objectContaining({ projectUuid: "project", ideaUuid: "idea-1" }));
    expect(mocks.createActivity).toHaveBeenCalledWith(expect.objectContaining({
      action: "task_created", value: { ideaUuid: "idea-1" },
    }));
  });

  it("createTaskAction defaults ideaUuid to null and omits activity value", async () => {
    await createTaskAction({ projectUuid: "project", title: "Fix" });
    expect(mocks.createTask).toHaveBeenCalledWith(expect.objectContaining({ ideaUuid: null }));
    expect(mocks.createActivity.mock.calls[0][0]).not.toHaveProperty("value");
  });

  it("createTaskAction surfaces link-validation errors", async () => {
    mocks.createTask.mockRejectedValue(new ApiError("BAD_REQUEST", "Theme ideas cannot have tasks; link a child idea", 400));
    expect(await createTaskAction({ projectUuid: "project", title: "Fix", ideaUuid: "theme" }))
      .toEqual({ success: false, error: "Theme ideas cannot have tasks; link a child idea" });
  });

  it("createTaskAction keeps a generic message for unexpected errors", async () => {
    mocks.createTask.mockRejectedValue(new Error("db down"));
    expect(await createTaskAction({ projectUuid: "project", title: "Fix" }))
      .toEqual({ success: false, error: "Failed to create task" });
  });

  it.each([["idea-1"], [null]])("updateTaskFieldsAction passes ideaUuid=%s through", async (ideaUuid) => {
    expect(await updateTaskFieldsAction({ ...fields, ideaUuid })).toEqual({ success: true });
    expect(mocks.updateTask).toHaveBeenCalledWith("task", expect.objectContaining({ ideaUuid }), expect.anything());
  });

  it("updateTaskFieldsAction leaves the link untouched when ideaUuid is omitted", async () => {
    await updateTaskFieldsAction(fields);
    expect(mocks.updateTask.mock.calls[0][1]).not.toHaveProperty("ideaUuid");
  });

  it("updateTaskFieldsAction surfaces link-validation errors", async () => {
    mocks.updateTask.mockRejectedValue(new ApiError("BAD_REQUEST", "Idea must be in the same project as the task", 400));
    expect(await updateTaskFieldsAction({ ...fields, ideaUuid: "x" }))
      .toEqual({ success: false, error: "Idea must be in the same project as the task" });
  });

  it.each(["", "   "])("updateTaskFieldsAction normalizes ideaUuid=%j to null (clears the link)", async (ideaUuid) => {
    expect(await updateTaskFieldsAction({ ...fields, ideaUuid })).toEqual({ success: true });
    expect(mocks.updateTask).toHaveBeenCalledWith("task", expect.objectContaining({ ideaUuid: null }), expect.anything());
  });

  it("createTaskAction normalizes an empty ideaUuid to no link", async () => {
    await createTaskAction({ projectUuid: "project", title: "Fix", ideaUuid: "" });
    expect(mocks.createTask).toHaveBeenCalledWith(expect.objectContaining({ ideaUuid: null }));
    expect(mocks.createActivity.mock.calls[0][0]).not.toHaveProperty("value");
  });
});

describe("getTaskIdeaOptionsAction", () => {
  beforeEach(() => {
    mocks.projectAccess.mockResolvedValue(null);
  });

  it("lists the project's non-theme ideas as {uuid,title}", async () => {
    mocks.listIdeas.mockResolvedValue({
      ideas: [
        { uuid: "i1", title: "Idea one", isContainer: false },
        { uuid: "theme", title: "Theme", isContainer: true },
        { uuid: "i2", title: "Idea two", isContainer: false },
      ],
      total: 3,
    });
    expect(await getTaskIdeaOptionsAction("project")).toEqual({
      success: true,
      data: [{ uuid: "i1", title: "Idea one" }, { uuid: "i2", title: "Idea two" }],
      hasMore: false,
    });
    expect(mocks.listIdeas).toHaveBeenCalledWith(expect.objectContaining({
      companyUuid: "company", projectUuid: "project", skip: 0,
    }));
    expect(mocks.projectAccess).toHaveBeenCalledWith(auth, "project", "viewer");
  });

  it("reports truncation via hasMore", async () => {
    mocks.listIdeas.mockResolvedValue({ ideas: [{ uuid: "i1", title: "A", isContainer: false }], total: 500 });
    expect((await getTaskIdeaOptionsAction("project")).hasMore).toBe(true);
  });

  it("returns no options when unauthenticated, denied, or on error", async () => {
    mocks.auth.mockResolvedValueOnce(null);
    expect((await getTaskIdeaOptionsAction("project")).data).toEqual([]);
    mocks.projectAccess.mockResolvedValueOnce({ success: false, error: "Project not found" });
    expect((await getTaskIdeaOptionsAction("project")).data).toEqual([]);
    mocks.listIdeas.mockRejectedValueOnce(new Error("db down"));
    expect(await getTaskIdeaOptionsAction("project")).toEqual({
      success: false, data: [], hasMore: false, error: "Failed to load ideas",
    });
  });
});
