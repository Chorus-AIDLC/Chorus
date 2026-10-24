import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { ApiError } from "@/lib/api-handler";
import { NotClaimedError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), access: vi.fn(), idea: vi.fn(), release: vi.fn(), isAssignee: vi.fn() }));
vi.mock("@/lib/auth", async (original) => ({ ...await original<typeof import("@/lib/auth")>(), getAuthContext: mocks.auth, isAssignee: mocks.isAssignee }));
vi.mock("@/services/project-access.service", () => ({ requireEntityAccess: mocks.access }));
vi.mock("@/services/idea.service", () => ({ getIdeaByUuid: mocks.idea, releaseIdea: mocks.release }));
import { POST } from "../route";

const ideaUuid = "idea-1";
const human = { type: "user", companyUuid: "company-1", actorUuid: "human-1" };
const agent = { type: "agent", companyUuid: "company-1", actorUuid: "agent-1", permissions: ["idea:write"] };
function request(operationUuid?: string) {
  return new NextRequest(`http://localhost/api/ideas/${ideaUuid}/release`, {
    method: "POST", headers: { "content-type": "application/json", ...(operationUuid ? { "Idempotency-Key": operationUuid } : {}) },
    body: JSON.stringify({ auth: human, assignedByUuid: human.actorUuid, operationUuid: "forged-body-operation" }),
  });
}
const context = () => ({ params: Promise.resolve({ uuid: ideaUuid }) });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue(human);
  mocks.idea.mockResolvedValue({ uuid: ideaUuid, assigneeType: "agent_instance", assigneeUuid: "instance-1" });
  mocks.release.mockResolvedValue({ uuid: ideaUuid, status: "open" });
  mocks.isAssignee.mockResolvedValue(true);
});

describe("POST Idea release authenticated origin", () => {
  it.each(["user", "agent"])("passes authenticated %s identity and header operation key, not body authority", async (type) => {
    const auth = type === "user" ? human : agent;
    mocks.auth.mockResolvedValue(auth);
    expect((await POST(request("header-operation"), context())).status).toBe(200);
    expect(mocks.access).toHaveBeenCalledWith(auth, "idea", ideaUuid, "editor");
    expect(mocks.idea).toHaveBeenCalledWith(auth.companyUuid, ideaUuid);
    expect(mocks.release).toHaveBeenCalledWith(ideaUuid, auth, "header-operation");
    expect(mocks.release.mock.calls[0][1]).toBe(auth);
    if (type === "agent") expect(mocks.isAssignee).toHaveBeenCalledWith(auth, "agent_instance", "instance-1");
    else expect(mocks.isAssignee).not.toHaveBeenCalled();
  });

  it("leaves missing operation-key generation to the shared service", async () => {
    expect((await POST(request(), context())).status).toBe(200);
    expect(mocks.release).toHaveBeenCalledWith(ideaUuid, human, undefined);
  });

  it("rejects an agent releasing another agent's assignment", async () => {
    mocks.auth.mockResolvedValue(agent);
    mocks.isAssignee.mockResolvedValue(false);
    expect((await POST(request(), context())).status).toBe(403);
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it("requires authentication and agent idea:write", async () => {
    mocks.auth.mockResolvedValue(null);
    expect((await POST(request(), context())).status).toBe(401);
    mocks.auth.mockResolvedValue({ ...agent, permissions: [] });
    expect((await POST(request(), context())).status).toBe(403);
    expect(mocks.release).not.toHaveBeenCalled();
    expect(mocks.idea).not.toHaveBeenCalled();
  });

  it("preserves the project access boundary before mutation", async () => {
    mocks.access.mockRejectedValue(new ApiError("NOT_FOUND", "Idea not found", 404));
    expect((await POST(request(), context())).status).toBe(404);
    expect(mocks.idea).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it("returns not-found without releasing a missing Idea", async () => {
    mocks.idea.mockResolvedValue(null);
    expect((await POST(request(), context())).status).toBe(404);
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it("preserves workflow and current-authorization errors from the shared service", async () => {
    mocks.release.mockRejectedValueOnce(new NotClaimedError("Idea"));
    expect((await POST(request(), context())).status).toBe(400);
    mocks.release.mockRejectedValueOnce(new ApiError("FORBIDDEN", "Access revoked", 403));
    expect((await POST(request(), context())).status).toBe(403);
  });
});
