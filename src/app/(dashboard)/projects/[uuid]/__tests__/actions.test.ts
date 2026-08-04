import { beforeEach, describe, expect, it, vi } from "vitest";

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
});
