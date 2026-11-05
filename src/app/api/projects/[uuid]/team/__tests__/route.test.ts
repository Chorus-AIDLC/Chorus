import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), get: vi.fn(), save: vi.fn(), remove: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getAuthContext: mocks.auth }));
vi.mock("@/services/project-access.service", () => ({ requireProjectAccess: vi.fn() }));
vi.mock("@/lib/logger", () => ({ createRequestLogger: () => ({ error: vi.fn(), warn: vi.fn() }) }));
vi.mock("@/services/project-agent-team.service", () => ({
  getProjectAgentTeam: mocks.get, saveProjectAgentTeam: mocks.save, deleteProjectAgentTeam: mocks.remove,
  ProjectTeamError: class extends Error {
    constructor(public code: string, message: string, public details?: unknown) { super(message); }
  },
}));
import { GET, PUT, DELETE } from "../route";
import { ProjectTeamError } from "@/services/project-agent-team.service";

const auth = { type: "user", companyUuid: randomUUID(), actorUuid: randomUUID() };
const projectUuid = randomUUID();
const context = () => ({ params: Promise.resolve({ uuid: projectUuid }) });
const request = (method = "GET", body?: string) => new NextRequest("http://localhost/api/projects/test/team", { method, body });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue(auth);
  mocks.get.mockResolvedValue(null);
  mocks.save.mockResolvedValue({ projectUuid });
  mocks.remove.mockResolvedValue({ deleted: true });
});

describe("personal project Team REST", () => {
  it("uses authenticated identity and project route, with stable response envelopes", async () => {
    expect(await (await GET(request(), context())).json()).toMatchObject({ success: true, data: { team: null } });
    expect(mocks.get).toHaveBeenCalledWith(auth, projectUuid);
    const input = { templateUuid: randomUUID(), overrides: { lead: [] } };
    expect(await (await PUT(request("PUT", JSON.stringify(input)), context())).json()).toMatchObject({ data: { team: { projectUuid } } });
    expect(mocks.save).toHaveBeenCalledWith(auth, projectUuid, input);
    expect(await (await DELETE(request("DELETE"), context())).json()).toMatchObject({ data: { deleted: true } });
  });

  it.each([GET, PUT, DELETE])("requires human session before service access", async (handler) => {
    mocks.auth.mockResolvedValue(null);
    expect((await handler(request(), context())).status).toBe(401);
    mocks.auth.mockResolvedValue({ ...auth, type: "agent" });
    expect((await handler(request(), context())).status).toBe(403);
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("maps validation and hidden-project errors without exposing server failures", async () => {
    mocks.save.mockRejectedValue(new ProjectTeamError("VALIDATION_ERROR", "Invalid project team"));
    expect((await PUT(request("PUT", "{"), context())).status).toBe(422);
    expect(mocks.save).toHaveBeenCalledWith(auth, projectUuid, null);
    mocks.get.mockRejectedValue(new ProjectTeamError("NOT_FOUND", "Project not found"));
    expect((await GET(request(), context())).status).toBe(404);
  });
});
