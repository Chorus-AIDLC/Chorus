import { describe, it, expect, vi, beforeEach } from "vitest";

const mockAccess = vi.hoisted(() => ({
  requireEntityAccess: vi.fn(),
  requireProjectAccess: vi.fn(),
  requireProjectOperation: vi.fn(),
}));
vi.mock("@/services/project-access.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/project-access.service")>()),
  ...mockAccess,
}));

import { denyUnlessEntityAccess, denyUnlessProjectAccess, denyUnlessProjectOperation } from "@/lib/project-access-action";
import { ProjectAccessDeniedError, ProjectNotFoundError } from "@/services/project-access.service";
import type { AuthContext } from "@/types/auth";

const auth: AuthContext = { type: "user", companyUuid: "c", actorUuid: "u" };

describe("project-access-action adapters", () => {
  beforeEach(() => vi.clearAllMocks());

  it("return null when allowed", async () => {
    mockAccess.requireEntityAccess.mockResolvedValue({ projectUuid: "p", accessLevel: "editor" });
    mockAccess.requireProjectAccess.mockResolvedValue({});
    mockAccess.requireProjectOperation.mockResolvedValue({});
    expect(await denyUnlessEntityAccess(auth, "task", "t", "editor")).toBeNull();
    expect(await denyUnlessProjectAccess(auth, "p", "viewer")).toBeNull();
    expect(await denyUnlessProjectOperation(auth, "p", "manage_members")).toBeNull();
    expect(mockAccess.requireEntityAccess).toHaveBeenCalledWith(auth, "task", "t", "editor");
  });

  it("translate access errors into action results", async () => {
    mockAccess.requireEntityAccess.mockRejectedValue(new ProjectNotFoundError("task"));
    mockAccess.requireProjectAccess.mockRejectedValue(new ProjectAccessDeniedError());
    expect(await denyUnlessEntityAccess(auth, "task", "t", "editor")).toEqual({ success: false, error: "Task not found" });
    expect(await denyUnlessProjectAccess(auth, "p", "editor")).toEqual({ success: false, error: "Insufficient project access" });
  });

  it("rethrow unrelated errors", async () => {
    mockAccess.requireProjectOperation.mockRejectedValue(new Error("db down"));
    await expect(denyUnlessProjectOperation(auth, "p", "manage_project")).rejects.toThrow("db down");
  });
});
