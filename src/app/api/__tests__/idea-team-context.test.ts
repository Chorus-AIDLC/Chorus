import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { ApiError } from "@/lib/api-handler";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), access: vi.fn(), team: vi.fn() }));
vi.mock("@/lib/auth", async (original) => ({ ...await original<typeof import("@/lib/auth")>(), getAuthContext: mocks.auth }));
vi.mock("@/services/project-access.service", () => ({ requireEntityAccess: mocks.access }));
vi.mock("@/services/idea-team.service", () => ({ getIdeaTeamContext: mocks.team }));
import { GET } from "@/app/api/ideas/[uuid]/team-context/route";

const auth = { type: "user", companyUuid: "company", actorUuid: "viewer" };
const summary = { managed: true, state: "active", lead: { agentUuid: "lead", agentName: "Lead" }, yolo: false, proposalGate: "human", taskGate: "lead", reason: null };
const get = () => GET(new NextRequest("http://localhost/api/ideas/idea/team-context"), { params: Promise.resolve({ uuid: "idea" }) });
beforeEach(() => { vi.resetAllMocks(); mocks.auth.mockResolvedValue(auth); mocks.team.mockResolvedValue(summary); });

describe("safe Idea Team context API", () => {
  it("requires authentication and agent read permission", async () => {
    mocks.auth.mockResolvedValue(null);
    expect((await get()).status).toBe(401);
    mocks.auth.mockResolvedValue({ ...auth, type: "agent", permissions: [] });
    expect((await get()).status).toBe(403);
    expect(mocks.team).not.toHaveBeenCalled();
  });
  it("checks entity project access before reading context", async () => {
    mocks.access.mockRejectedValue(new ApiError("NOT_FOUND", "Idea not found", 404));
    expect((await get()).status).toBe(404);
    expect(mocks.team).not.toHaveBeenCalled();
  });
  it("only returns the allowlisted summary even to the owner", async () => {
    mocks.team.mockResolvedValue({ ...summary, teamOwnerUuid: "secret-owner", private: { roles: ["private-member"] }, candidates: ["private-member"] });
    const response = await get();
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual(summary);
    expect(mocks.access).toHaveBeenCalledWith(auth, "idea", "idea", "viewer");
    expect(mocks.team).toHaveBeenCalledWith(auth, "idea");
  });
  it("preserves paused and unmanaged states without inventing an owner", async () => {
    mocks.team.mockResolvedValue({ ...summary, managed: false, state: "unmanaged", lead: null });
    expect((await (await get()).json()).data).toMatchObject({ managed: false, state: "unmanaged", lead: null });
    mocks.team.mockResolvedValue({ ...summary, state: "paused", reason: "team_unbound" });
    expect((await (await get()).json()).data).toMatchObject({ state: "paused", reason: "team_unbound" });
  });
  it("surfaces structured service denials", async () => {
    mocks.team.mockRejectedValue(new ApiError("FORBIDDEN", "Access revoked", 403));
    expect((await get()).status).toBe(403);
  });
});
