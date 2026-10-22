import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { ApiError } from "@/lib/api-handler";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(), access: vi.fn(), getTask: vi.fn(), updateTask: vi.fn(), dependencies: vi.fn(),
  activity: vi.fn(),
}));
vi.mock("@/lib/auth", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/auth")>(),
  getAuthContext: mocks.auth,
}));
vi.mock("@/services/task.service", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/services/task.service")>(),
  getTaskByUuid: mocks.getTask,
  updateTask: mocks.updateTask,
  checkDependenciesResolved: mocks.dependencies,
}));
vi.mock("@/services/project-access.service", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/services/project-access.service")>(),
  requireEntityAccess: mocks.access,
}));
vi.mock("@/services/activity.service", () => ({ createActivity: mocks.activity }));

import { PATCH } from "@/app/api/tasks/[uuid]/route";

const auth = { type: "user", companyUuid: "company", actorUuid: "actor", permissions: ["task:write"], roles: [] };
function patch(body: Record<string, unknown>) {
  return PATCH(new NextRequest("http://localhost/api/tasks/task", {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }), { params: Promise.resolve({ uuid: "task" }) });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue(auth);
  mocks.getTask.mockResolvedValue({
    uuid: "task", projectUuid: "project", status: "assigned", assigneeType: "agent", assigneeUuid: "actor",
  });
  mocks.dependencies.mockResolvedValue({ resolved: true });
  mocks.updateTask.mockResolvedValue({ uuid: "task" });
});

describe("REST task actor propagation", () => {
  it.each(["user", "agent"])("attributes an allowed %s transition", async (type) => {
    mocks.auth.mockResolvedValue({ ...auth, type });
    expect((await patch({ status: "in_progress" })).status).toBe(200);
    expect(mocks.updateTask).toHaveBeenCalledWith("task", { status: "in_progress" }, {
      actorType: type, actorUuid: "actor",
    });
  });

  it.each(["user", "agent", "super_admin"])("attributes field-only edits by %s", async (type) => {
    mocks.auth.mockResolvedValue({ ...auth, type });
    expect((await patch({ description: "  New description  " })).status).toBe(200);
    expect(mocks.updateTask).toHaveBeenCalledWith("task", { description: "New description" }, {
      actorType: type, actorUuid: "actor",
    });
  });

  it("preserves authentication and agent permission checks", async () => {
    mocks.auth.mockResolvedValue(null);
    expect((await patch({ description: "new" })).status).toBe(401);
    mocks.auth.mockResolvedValue({ ...auth, type: "agent", permissions: [] });
    expect((await patch({ description: "new" })).status).toBe(403);
    expect(mocks.updateTask).not.toHaveBeenCalled();
  });

  it("preserves project access denial", async () => {
    mocks.access.mockRejectedValue(new ApiError("FORBIDDEN", "Insufficient project access", 403));
    expect((await patch({ status: "in_progress" })).status).toBe(403);
    expect(mocks.updateTask).not.toHaveBeenCalled();
  });

  it.each(["agent", "super_admin"])("does not bypass existing %s assignee checks", async (type) => {
    mocks.auth.mockResolvedValue({ ...auth, type, actorUuid: "not-assigned" });
    expect((await patch({ status: "in_progress" })).status).toBe(403);
    expect(mocks.updateTask).not.toHaveBeenCalled();
  });

  it("preserves validation and unresolved dependency checks", async () => {
    expect((await patch({ status: "done" })).status).toBe(400);
    expect((await patch({ title: " " })).status).toBe(422);
    mocks.dependencies.mockResolvedValue({ resolved: false, blockers: ["upstream"] });
    expect((await patch({ status: "in_progress" })).status).toBe(409);
    expect(mocks.updateTask).not.toHaveBeenCalled();
  });

  it("retains actor attribution on an allowed forced transition", async () => {
    mocks.dependencies.mockResolvedValue({ resolved: false, blockers: ["upstream"] });
    expect((await patch({ status: "in_progress", force: true })).status).toBe(200);
    expect(mocks.updateTask).toHaveBeenCalledWith("task", { status: "in_progress" }, {
      actorType: "user", actorUuid: "actor",
    });
    expect(mocks.activity).toHaveBeenCalledWith(expect.objectContaining({
      action: "force_status_change", actorType: "user", actorUuid: "actor",
    }));
  });
});
