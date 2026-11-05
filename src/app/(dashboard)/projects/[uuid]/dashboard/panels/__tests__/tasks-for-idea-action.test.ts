import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  projectAccess: vi.fn(),
  listTasks: vi.fn(),
}));

vi.mock("@/lib/auth-server", () => ({ getServerAuthContext: mocks.auth }));
vi.mock("@/lib/project-access-action", () => ({
  denyUnlessEntityAccess: vi.fn(async () => null),
  denyUnlessProjectAccess: mocks.projectAccess,
}));
vi.mock("@/services/task.service", () => ({
  getTask: vi.fn(),
  listTasks: mocks.listTasks,
  AssigneeAccessError: class extends Error {},
}));
vi.mock("@/services/idea.service", () => ({}));
vi.mock("@/services/proposal.service", () => ({}));
vi.mock("@/services/document.service", () => ({}));
vi.mock("@/services/project.service", () => ({}));
vi.mock("@/services/project-group.service", () => ({}));
vi.mock("@/services/elaboration.service", () => ({}));

import { getTasksForIdeaAction } from "../actions";

describe("getTasksForIdeaAction", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.auth.mockResolvedValue({ type: "user", companyUuid: "c", actorUuid: "u" });
    mocks.projectAccess.mockResolvedValue(null);
  });

  it("lists the Quick Tasks linked to the idea via listTasks({ ideaUuid })", async () => {
    mocks.listTasks.mockResolvedValue({ tasks: [{ uuid: "q1", status: "open" }], total: 1 });
    expect(await getTasksForIdeaAction("p", "idea-1")).toEqual({
      success: true, data: [{ uuid: "q1", status: "open" }],
    });
    expect(mocks.listTasks).toHaveBeenCalledWith({
      companyUuid: "c", projectUuid: "p", ideaUuid: "idea-1", skip: 0, take: 100,
    });
    expect(mocks.projectAccess).toHaveBeenCalledWith(expect.anything(), "p", "viewer");
  });

  it("rejects unauthenticated callers and project-access denials without listing", async () => {
    mocks.auth.mockResolvedValueOnce(null);
    expect(await getTasksForIdeaAction("p", "idea-1")).toEqual({ success: false, error: "Unauthorized" });
    mocks.projectAccess.mockResolvedValueOnce({ success: false, error: "Project not found" });
    expect(await getTasksForIdeaAction("p", "idea-1")).toEqual({ success: false, error: "Project not found" });
    expect(mocks.listTasks).not.toHaveBeenCalled();
  });
});
