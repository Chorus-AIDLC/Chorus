import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), entity: vi.fn(), inputs: vi.fn(), proposal: vi.fn(), submit: vi.fn(), approve: vi.fn() }));
vi.mock("@/lib/auth-server", () => ({ getServerAuthContext: mocks.auth }));
vi.mock("@/lib/project-access-action", () => ({ denyUnlessEntityAccess: mocks.entity, denyUnlessProposalInputsAccess: mocks.inputs }));
vi.mock("@/services/proposal.service", () => ({ getProposalByUuid: mocks.proposal, submitProposal: mocks.submit, approveProposal: mocks.approve }));
vi.mock("@/services/activity.service", () => ({ createActivity: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
import { submitProposalAction, approveProposalAction } from "../[uuid]/proposals/[proposalUuid]/actions";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue({ type: "user", companyUuid: "company", actorUuid: "human" });
  mocks.proposal.mockResolvedValue({ uuid: "proposal", projectUuid: "project", status: "draft" });
});

describe("dashboard proposal Team actor", () => {
  it("passes human identity at submission without skipping stored-input access", async () => {
    expect(await submitProposalAction("proposal")).toEqual({ success: true });
    expect(mocks.inputs).toHaveBeenCalledWith(expect.objectContaining({ actorUuid: "human" }), "proposal");
    expect(mocks.submit).toHaveBeenCalledWith("proposal", "company", { actorType: "user", actorUuid: "human" });
  });
  it("passes human identity at approval", async () => {
    mocks.proposal.mockResolvedValue({ uuid: "proposal", projectUuid: "project", status: "pending" });
    expect(await approveProposalAction("proposal")).toEqual({ success: true });
    expect(mocks.approve).toHaveBeenCalledWith("proposal", "company", "human", null, { actorType: "user", actorUuid: "human" });
  });
  it("keeps hidden-input refusal before submission", async () => {
    mocks.inputs.mockResolvedValue({ success: false, error: "Idea not found" });
    expect(await submitProposalAction("proposal")).toEqual({ success: false, error: "Idea not found" });
    expect(mocks.submit).not.toHaveBeenCalled();
  });
});
