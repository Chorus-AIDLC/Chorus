import { beforeEach, describe, expect, it, vi } from "vitest";

// Project-access gate: allow by default (behavioural coverage lives in
// src/app/(dashboard)/projects/__tests__/action-project-access.test.ts).
vi.mock("@/lib/project-access-action", () => ({
  denyUnlessProjectAccess: vi.fn(async () => null),
  denyUnlessEntityAccess: vi.fn(async () => null),
  denyUnlessProjectOperation: vi.fn(async () => null),
}));

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  update: vi.fn(),
  revalidatePath: vi.fn(),
  CwdServiceError: class CwdServiceError extends Error {
    constructor(
      public readonly code: string,
      message: string,
      public readonly agentUuid?: string,
    ) {
      super(message);
    }
  },
}));

vi.mock("@/lib/auth-server", () => ({ getServerAuthContext: mocks.auth }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/services/project.service", () => ({ deleteProject: vi.fn() }));
vi.mock("@/services/session.service", () => ({ getActiveSessionsForProject: vi.fn() }));
vi.mock("@/services/project-agent-cwd.service", () => ({
  CwdServiceError: mocks.CwdServiceError,
  updateProjectWithAgentCwds: mocks.update,
}));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn() },
}));

import { CwdServiceError } from "@/services/project-agent-cwd.service";
import { denyUnlessProjectOperation } from "@/lib/project-access-action";
import { updateProjectAction } from "../actions";

describe("updateProjectAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({
      companyUuid: "company-1",
      actorUuid: "user-1",
    });
  });

  it("returns the stable Agent-scoped cwd error contract", async () => {
    mocks.update.mockRejectedValue(
      new CwdServiceError("STALE_TARGET", "Fresh validation required", "agent-1"),
    );

    await expect(updateProjectAction("project-1", {
      name: "Updated",
      agentCwds: {
        upserts: [{ agentUuid: "agent-1", validationRequestUuid: "stale" }],
        clears: [],
      },
    })).resolves.toEqual({
      success: false,
      error: {
        code: "STALE_TARGET",
        message: "Fresh validation required",
        agentUuid: "agent-1",
      },
    });
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("maps a manage_project denial onto the {code,message} error contract", async () => {
    vi.mocked(denyUnlessProjectOperation).mockResolvedValueOnce({
      success: false,
      error: "Only project admins can manage this project",
    });
    await expect(
      updateProjectAction("project-1", { name: "x", agentCwds: { upserts: [], clears: [] } }),
    ).resolves.toEqual({
      success: false,
      error: { code: "FORBIDDEN", message: "Only project admins can manage this project" },
    });

    vi.mocked(denyUnlessProjectOperation).mockResolvedValueOnce({
      success: false,
      error: "Project not found",
    });
    await expect(
      updateProjectAction("project-1", { name: "x", agentCwds: { upserts: [], clears: [] } }),
    ).resolves.toEqual({
      success: false,
      error: { code: "NOT_FOUND", message: "Project not found" },
    });
    expect(mocks.update).not.toHaveBeenCalled();
  });
});
