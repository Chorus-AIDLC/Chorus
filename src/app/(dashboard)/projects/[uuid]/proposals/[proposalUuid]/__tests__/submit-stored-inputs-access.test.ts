import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSubmit = vi.hoisted(() => vi.fn());
const mockInputs = vi.hoisted(() => vi.fn());

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth-server", () => ({
  getServerAuthContext: vi.fn(async () => ({ type: "user", companyUuid: "c", actorUuid: "u" })),
}));
vi.mock("@/lib/project-access-action", () => ({
  denyUnlessEntityAccess: vi.fn(async () => null),
  denyUnlessProposalInputsAccess: mockInputs,
}));
vi.mock("@/services/proposal.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/proposal.service")>()),
  getProposalByUuid: vi.fn(async () => ({ uuid: "pr", projectUuid: "p", status: "draft" })),
  submitProposal: mockSubmit,
}));

import { submitProposalAction } from "../actions";

describe("submitProposalAction — stored inputs that became hidden", () => {
  beforeEach(() => vi.clearAllMocks());

  it("refuses to submit (and never validates) when a stored input is now hidden", async () => {
    mockInputs.mockResolvedValue({ success: false, error: "Idea not found" });
    expect(await submitProposalAction("pr")).toEqual({ success: false, error: "Idea not found" });
    expect(mockInputs).toHaveBeenCalledWith(expect.anything(), "pr");
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  it("submits when every stored input is visible", async () => {
    mockInputs.mockResolvedValue(null);
    expect(await submitProposalAction("pr")).toEqual({ success: true });
    expect(mockSubmit).toHaveBeenCalledWith("pr", "c");
  });
});
