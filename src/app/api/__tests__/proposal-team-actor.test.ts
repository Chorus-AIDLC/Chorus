import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { ApiError } from "@/lib/api-handler";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), access: vi.fn(), get: vi.fn(), approve: vi.fn(), activity: vi.fn() }));
vi.mock("@/lib/auth", async (original) => ({ ...await original<typeof import("@/lib/auth")>(), getAuthContext: mocks.auth }));
vi.mock("@/services/project-access.service", () => ({ requireEntityAccess: mocks.access }));
vi.mock("@/services/proposal.service", () => ({ getProposalByUuid: mocks.get, approveProposal: mocks.approve }));
vi.mock("@/services/activity.service", () => ({ createActivity: mocks.activity }));
import { POST } from "@/app/api/proposals/[uuid]/approve/route";
const approve = () => POST(new NextRequest("http://localhost/api/proposals/proposal/approve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reviewNote: "Checked" }) }), { params: Promise.resolve({ uuid: "proposal" }) });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue({ type: "agent", companyUuid: "company", actorUuid: "agent", permissions: ["proposal:admin"] });
  mocks.get.mockResolvedValue({ uuid: "proposal", projectUuid: "project", status: "pending" });
  mocks.approve.mockResolvedValue({ uuid: "proposal", status: "approved" });
});
describe("REST Team approval actor", () => {
  it.each(["user", "agent"])("passes the authenticated %s identity", async (type) => {
    mocks.auth.mockResolvedValue({ type, companyUuid: "company", actorUuid: "actor", permissions: ["proposal:admin"] });
    expect((await approve()).status).toBe(200);
    expect(mocks.approve).toHaveBeenCalledWith("proposal", "company", "actor", "Checked", { actorType: type, actorUuid: "actor" });
  });
  it("forwards the agent's admitted Idea Team turn proof to the gate", async () => {
    const ideaTeamTurn = { turnUuid: "turn", admissionUuid: "admission", supplementaryTurns: [{ turnUuid: "turn-2", admissionUuid: "admission" }] };
    mocks.auth.mockResolvedValue({ type: "agent", companyUuid: "company", actorUuid: "actor", permissions: ["proposal:admin"], ideaTeamTurn });
    expect((await approve()).status).toBe(200);
    expect(mocks.approve).toHaveBeenCalledWith("proposal", "company", "actor", "Checked", { actorType: "agent", actorUuid: "actor", ...ideaTeamTurn });
  });
  it("surfaces shared Team gate denial without approval activity", async () => {
    mocks.approve.mockRejectedValue(new ApiError("FORBIDDEN", "Human approval required", 403));
    expect((await approve()).status).toBe(403);
    expect(mocks.activity).not.toHaveBeenCalled();
  });
});
