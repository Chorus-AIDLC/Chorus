import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { ApiError } from "@/lib/api-handler";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), issue: vi.fn(), access: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getAuthContext: mocks.auth }));
vi.mock("@/services/idea-assignment-authorization.service", () => ({ issueIdeaAssignmentAuthorization: mocks.issue }));
vi.mock("@/services/project-access.service", () => ({ requireEntityAccess: mocks.access }));
import { POST } from "@/app/api/ideas/[uuid]/assignment-authorization/route";

const auth = { type: "user", companyUuid: "company-1", actorUuid: "owner-1" };
const ideaUuid = "31e7bd34-7643-4a65-bbac-b38d452bb78e";
const agentUuid = "3c7ea8ca-5f25-43fb-b34e-5d824e4b0304";
const requestUuid = "53e96f54-f4fc-425d-b30d-02f20482a07d";
const publicProof = { uuid: "534e47f7-fb6d-4911-9bf8-e4e13a482dd8", ideaUuid, agentUuid, expiresAt: new Date("2026-10-25T00:00:00Z") };
function post(body: unknown = { agentUuid, requestUuid }) {
  return POST(new NextRequest(`http://localhost/api/ideas/${ideaUuid}/assignment-authorization`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }), { params: Promise.resolve({ uuid: ideaUuid }) });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue(auth);
  mocks.issue.mockResolvedValue({ ...publicProof, companyUuid: "company-1", humanUuid: "owner-1", sourceUuid: requestUuid,
    sourceDigest: "private-digest", generation: 7, consumedOperationUuid: null, team: { roles: ["private-agent"] },
  });
});

describe("human Idea assignment confirmation API", () => {
  it("binds the real session and path Idea to the confirmation request and returns only allowlisted proof fields", async () => {
    const response = await post();
    expect(response.status).toBe(200);
    expect(mocks.access).toHaveBeenCalledWith(auth, "idea", ideaUuid, "editor");
    expect(mocks.issue).toHaveBeenCalledWith(auth, { ideaUuid, agentUuid, requestUuid });
    expect(mocks.issue.mock.calls[0][0]).toBe(auth);
    expect((await response.json()).data).toEqual({ ...publicProof, expiresAt: publicProof.expiresAt.toISOString() });
  });

  it.each([null, "agent", "super_admin"])("rejects non-human confirmation origin %s even with forged body identity", async (type) => {
    mocks.auth.mockResolvedValue(type ? { ...auth, type, roles: ["admin_agent"], permissions: ["idea:admin"] } : null);
    const response = await post({ agentUuid, requestUuid, auth, humanUuid: auth.actorUuid, assignedByType: "user" });
    expect(response.status).toBe(type ? 403 : 401);
    expect(mocks.issue).not.toHaveBeenCalled();
  });

  it.each([
    {}, { agentUuid }, { requestUuid }, { agentUuid: "invalid", requestUuid }, { agentUuid, requestUuid: "invalid" },
    { agentUuid, requestUuid, humanUuid: "other-human" }, { agentUuid, requestUuid, ideaUuid: "other-idea" },
    { agentUuid, requestUuid, commentUuid: requestUuid }, { agentUuid, requestUuid, auth: { type: "user", actorUuid: "forged" } },
    null, [], "confirmation",
  ].map((body) => ({ body })))("rejects invalid or additional body fields without minting: $body", async ({ body }) => {
    expect((await post(body)).status).toBe(422);
    expect(mocks.issue).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON without minting", async () => {
    const response = await POST(new NextRequest(`http://localhost/api/ideas/${ideaUuid}/assignment-authorization`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{",
    }), { params: Promise.resolve({ uuid: ideaUuid }) });
    expect(response.status).toBe(400);
    expect(mocks.issue).not.toHaveBeenCalled();
  });

  it.each([403, 404])("preserves service owner/project denial status %s without proof disclosure", async (status) => {
    mocks.issue.mockRejectedValue(new ApiError(status === 403 ? "FORBIDDEN" : "NOT_FOUND", "Assignment authorization denied", status));
    const response = await post();
    expect(response.status).toBe(status);
    const body = await response.json();
    expect(body).not.toHaveProperty("data");
    expect(body.error.message).toBe("Assignment authorization denied");
  });

  it("rejects project viewers before minting a proof", async () => {
    mocks.access.mockRejectedValue(new ApiError("FORBIDDEN", "Editor access required", 403));
    expect((await post()).status).toBe(403);
    expect(mocks.issue).not.toHaveBeenCalled();
  });
});
