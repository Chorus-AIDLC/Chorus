import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), access: vi.fn(), getIdea: vi.fn() }));

vi.mock("@/lib/auth-server", () => ({ getServerAuthContext: mocks.auth }));
vi.mock("@/lib/project-access-action", () => ({ denyUnlessEntityAccess: mocks.access }));
vi.mock("@/services/proposal.service", () => ({ getProposalByUuid: vi.fn() }));
vi.mock("@/services/idea.service", () => ({ getIdeaByUuid: mocks.getIdea }));

import { getTaskIdeaSourceAction } from "../[taskUuid]/source-actions";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue({ type: "user", companyUuid: "c", actorUuid: "u" });
  mocks.access.mockResolvedValue(null);
});

describe("getTaskIdeaSourceAction", () => {
  it("returns the linked idea's uuid and title, company-scoped", async () => {
    mocks.getIdea.mockResolvedValue({ uuid: "idea-1", title: "Login idea", content: "secret" });
    expect(await getTaskIdeaSourceAction("idea-1")).toEqual({ uuid: "idea-1", title: "Login idea" });
    expect(mocks.getIdea).toHaveBeenCalledWith("c", "idea-1");
    expect(mocks.access).toHaveBeenCalledWith(expect.anything(), "idea", "idea-1", "viewer");
  });

  it("resolves to null when unauthenticated, denied, missing, or on error", async () => {
    mocks.auth.mockResolvedValueOnce(null);
    expect(await getTaskIdeaSourceAction("idea-1")).toBeNull();
    mocks.access.mockResolvedValueOnce({ success: false, error: "Idea not found" });
    expect(await getTaskIdeaSourceAction("idea-1")).toBeNull();
    mocks.getIdea.mockResolvedValueOnce(null);
    expect(await getTaskIdeaSourceAction("idea-1")).toBeNull();
    mocks.getIdea.mockRejectedValueOnce(new Error("db"));
    expect(await getTaskIdeaSourceAction("idea-1")).toBeNull();
  });
});
