import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), handoff: vi.fn(), log: vi.fn(), access: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getAuthContext: mocks.auth }));
vi.mock("@/lib/logger", () => ({ default: { error: mocks.log }, createRequestLogger: () => ({ error: mocks.log }) }));
vi.mock("@/services/project-team-handoff.service", () => ({ handoffProjectTeam: mocks.handoff }));
vi.mock("@/services/project-access.service", () => ({ requireProjectAccess: mocks.access }));
vi.mock("@/services/project-agent-team.service", () => ({
  ProjectTeamError: class extends Error {
    constructor(public code: string, message: string, public details?: unknown) { super(message); }
  },
}));

import { POST } from "../route";
import { ProjectTeamError } from "@/services/project-agent-team.service";
import { requestContext } from "@/lib/request-context";
import { ApiError } from "@/lib/api-handler";

const auth = { type: "user", companyUuid: randomUUID(), actorUuid: randomUUID() };
const projectUuid = randomUUID();
const leadAgentUuid = randomUUID();
const run = (body: unknown = { leadAgentUuid, preview: true }, raw = false) => POST(
  new NextRequest(`http://localhost/api/projects/${projectUuid}/team/handoff`, { method: "POST", body: raw ? String(body) : JSON.stringify(body) }),
  { params: Promise.resolve({ uuid: projectUuid }) },
);

beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue(auth);
  mocks.access.mockResolvedValue(undefined);
  mocks.handoff.mockResolvedValue({ candidates: [], count: 0, confirmationToken: "signed", expiresAt: "2026-10-23T00:05:00.000Z" });
});

describe("POST project team handoff", () => {
  it("returns preview using authenticated identity and the standard response envelope", async () => {
    mocks.handoff.mockImplementation(async () => {
      expect(requestContext.getStore()?.requestId).toBeTruthy();
      return { candidates: [], count: 0, confirmationToken: "signed", expiresAt: "expires" };
    });
    const response = await run();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data: { candidates: [], count: 0, confirmationToken: "signed", expiresAt: "expires" } });
    expect(mocks.handoff).toHaveBeenCalledWith(auth, projectUuid, { leadAgentUuid, preview: true });
    expect(mocks.access).toHaveBeenCalledWith(auth, projectUuid, "editor");
  });

  it("passes confirmation through without an assignment loop", async () => {
    mocks.handoff.mockResolvedValue({ candidates: [{ uuid: randomUUID(), title: "Idea" }], count: 1, changedCount: 1 });
    const response = await run({ leadAgentUuid, confirmationToken: "signed" });
    expect(response.status).toBe(200);
    expect((await response.json()).data).toMatchObject({ count: 1, changedCount: 1 });
    expect(mocks.handoff).toHaveBeenCalledTimes(1);
    expect(mocks.handoff).toHaveBeenCalledWith(auth, projectUuid, { leadAgentUuid, confirmationToken: "signed" });
  });

  it.each([null, { ...auth, type: "agent", ownerUuid: auth.actorUuid }, { ...auth, type: "super_admin" }])("rejects non-user auth before parsing input: %j", async (actor) => {
    mocks.auth.mockResolvedValue(actor);
    expect((await run("{", true)).status).toBe(actor ? 403 : 401);
    expect(mocks.handoff).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON", async () => {
    const response = await run("{", true);
    expect(response.status).toBe(422);
    expect((await response.json()).error.code).toBe("VALIDATION_ERROR");
    expect(mocks.handoff).not.toHaveBeenCalled();
  });

  it.each([403, 404])("enforces the route access precheck before service work (%i)", async (status) => {
    mocks.access.mockRejectedValue(new ApiError(status === 403 ? "FORBIDDEN" : "NOT_FOUND", "Access denied", status));
    expect((await run()).status).toBe(status);
    expect(mocks.handoff).not.toHaveBeenCalled();
  });

  it.each([
    ["NOT_FOUND", 404], ["FORBIDDEN", 403], ["CONFLICT", 409], ["VALIDATION_ERROR", 422],
  ] as const)("maps %s from the service to HTTP %i", async (code, status) => {
    mocks.handoff.mockRejectedValue(new ProjectTeamError(code, "Safe error", { reason: "detail" }));
    const response = await run();
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ success: false, error: { code, message: "Safe error", details: { reason: "detail" } } });
  });

  it("uses shared logging and a generic response for unexpected failures", async () => {
    mocks.handoff.mockRejectedValue(new Error("internal storage detail"));
    const response = await run();
    expect(response.status).toBe(500);
    expect((await response.json()).error.message).toBe("Internal server error");
    expect(mocks.log).toHaveBeenCalled();
  });
});
