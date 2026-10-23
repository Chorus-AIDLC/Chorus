import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  list: vi.fn(),
  candidates: vi.fn(),
  get: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  log: vi.fn(),
  globalLog: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ getAuthContext: mocks.auth }));
vi.mock("@/lib/logger", () => ({
  default: { error: mocks.globalLog },
  createRequestLogger: () => ({ error: mocks.log }),
}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/services/agent-team.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/agent-team.service")>()),
  listAgentTeams: mocks.list,
  listAgentTeamCandidates: mocks.candidates,
  getAgentTeam: mocks.get,
  createAgentTeam: mocks.create,
  updateAgentTeam: mocks.update,
  deleteAgentTeam: mocks.remove,
}));

import { GET, POST } from "../route";
import { GET as CANDIDATES } from "../candidates/route";
import { GET as DETAIL, PATCH, DELETE } from "../[uuid]/route";
import { AgentTeamError } from "@/services/agent-team.service";
import { getRequestLogger, requestContext } from "@/lib/request-context";

const auth = { type: "user", companyUuid: randomUUID(), actorUuid: randomUUID(), workspaceAdmin: true };
const uuid = randomUUID();
const agentUuid = randomUUID();
const member = { role: "development", agentUuid, agentName: "Developer", eligible: true, missingPermissions: [] };
const team = {
  uuid, companyUuid: auth.companyUuid, ownerUuid: auth.actorUuid, name: "Team", description: "",
  createdAt: "2026-10-23T00:00:00.000Z", updatedAt: "2026-10-23T00:00:00.000Z", members: [member],
};
const candidates = [{ uuid: agentUuid, name: "Developer", effectivePermissions: ["task:read", "task:write"] }];
const context = (teamUuid: string = uuid) => ({ params: Promise.resolve({ uuid: teamUuid }) });
const request = (method = "GET", body?: string) => new NextRequest("http://localhost/api/agent-teams", { method, body });
const endpoints = [
  { name: "list", run: () => GET(request()) },
  { name: "candidates", run: () => CANDIDATES(request()) },
  { name: "detail", run: () => DETAIL(request(), context()) },
  { name: "create", run: () => POST(request("POST", "{")) },
  { name: "update", run: () => PATCH(request("PATCH", "{"), context()) },
  { name: "delete", run: () => DELETE(request("DELETE"), context()) },
];

beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue(auth);
  mocks.list.mockResolvedValue([team]);
  mocks.candidates.mockResolvedValue(candidates);
  mocks.get.mockResolvedValue(team);
  mocks.create.mockResolvedValue(team);
  mocks.update.mockResolvedValue(team);
  mocks.remove.mockResolvedValue({ deleted: true });
});

describe("agent team REST contract", () => {
  it("establishes isolated shared request context during every endpoint's service work", async () => {
    const requestIds = new Set<string>();
    const checkContext = async () => {
      const store = requestContext.getStore();
      expect(store).toBeDefined();
      expect(store?.requestId).toMatch(/^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i);
      expect(getRequestLogger()).toBe(store?.logger);
      requestIds.add(store!.requestId);
      await Promise.resolve();
      expect(requestContext.getStore()).toBe(store);
    };
    for (const service of [mocks.list, mocks.candidates, mocks.get, mocks.create, mocks.update, mocks.remove]) {
      service.mockImplementation(async () => {
        await checkContext();
        return team;
      });
    }
    const responses = await Promise.all([
      GET(request()), CANDIDATES(request()), DETAIL(request(), context()),
      POST(request("POST", "{}")), PATCH(request("PATCH", "{}"), context()), DELETE(request("DELETE"), context()),
    ]);
    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(requestIds.size).toBe(6);
    expect(requestContext.getStore()).toBeUndefined();
  });

  it.each(endpoints)("rejects unauthenticated $name before body parsing or service work", async ({ run }) => {
    mocks.auth.mockResolvedValue(null);
    const response = await run();
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ success: false, error: { code: "UNAUTHORIZED" } });
    for (const service of [mocks.list, mocks.candidates, mocks.get, mocks.create, mocks.update, mocks.remove]) {
      expect(service).not.toHaveBeenCalled();
    }
  });

  it.each(endpoints)("forbids agent-key and super-admin $name callers", async ({ run }) => {
    for (const type of ["agent", "super_admin"]) {
      mocks.auth.mockResolvedValue({ ...auth, type, ownerUuid: auth.actorUuid });
      const response = await run();
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ success: false, error: { code: "FORBIDDEN" } });
    }
    for (const service of [mocks.list, mocks.candidates, mocks.get, mocks.create, mocks.update, mocks.remove]) {
      expect(service).not.toHaveBeenCalled();
    }
  });

  it("returns success.data arrays for list/candidates and exact member/candidate DTO fields", async () => {
    expect(await (await GET(request())).json()).toEqual({ success: true, data: [team] });
    expect(await (await CANDIDATES(request())).json()).toEqual({ success: true, data: candidates });
    expect(await (await DETAIL(request(), context())).json()).toEqual({ success: true, data: team });
    expect(mocks.list).toHaveBeenCalledWith(auth);
    expect(mocks.candidates).toHaveBeenCalledWith(auth);
    expect(mocks.get).toHaveBeenCalledWith(auth, uuid);
  });

  it("passes writes and authenticated scope unchanged and returns team/delete envelopes", async () => {
    const input = { name: "Template", description: "Details", members: [{ role: "review", agentUuid }] };
    expect(await (await POST(request("POST", JSON.stringify(input)))).json()).toEqual({ success: true, data: team });
    expect(mocks.create).toHaveBeenCalledWith(auth, input);
    expect(await (await PATCH(request("PATCH", JSON.stringify(input)), context())).json()).toEqual({ success: true, data: team });
    expect(mocks.update).toHaveBeenCalledWith(auth, uuid, input);
    expect(await (await DELETE(request("DELETE"), context())).json()).toEqual({ success: true, data: { deleted: true } });
    expect(mocks.remove).toHaveBeenCalledWith(auth, uuid);
  });

  it("returns 422 for malformed JSON without attempting a write", async () => {
    for (const response of [await POST(request("POST", "{")), await PATCH(request("PATCH", "{"), context())]) {
      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({ success: false, error: { code: "VALIDATION_ERROR", message: "Invalid JSON body" } });
    }
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("checks foreign/malformed team scope before parsing or validating PATCH metadata", async () => {
    mocks.get.mockRejectedValue(new AgentTeamError("NOT_FOUND", "Agent team not found"));
    for (const target of [randomUUID(), "bad-id"]) {
      for (const body of ["{", JSON.stringify({ name: "", ownerUuid: randomUUID() })]) {
        const response = await PATCH(request("PATCH", body), context(target));
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ success: false, error: { code: "NOT_FOUND", message: "Agent team not found" } });
      }
    }
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("preserves actionable own-agent missing-bit details on POST and PATCH", async () => {
    const details = { members: [{ role: "development", agentUuid, missingPermissions: ["task:write"] }] };
    const failure = new AgentTeamError("VALIDATION_ERROR", "Members lack required permissions", details);
    mocks.create.mockRejectedValue(failure);
    mocks.update.mockRejectedValue(failure);
    for (const response of [await POST(request("POST", "{}")), await PATCH(request("PATCH", "{}"), context())]) {
      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({ success: false, error: { code: "VALIDATION_ERROR", message: failure.message, details } });
    }
  });

  it("returns generic invalid-member errors without foreign metadata", async () => {
    mocks.create.mockRejectedValue(new AgentTeamError("VALIDATION_ERROR", "Invalid team members"));
    const response = await POST(request("POST", JSON.stringify({ name: "X", members: [{ role: "lead", agentUuid: randomUUID() }] })));
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ success: false, error: { code: "VALIDATION_ERROR", message: "Invalid team members" } });
  });

  it("keeps unexpected server failures generic even in development", async () => {
    vi.stubEnv("NODE_ENV", "development");
    try {
      const failure = new Error("secret database metadata");
      mocks.list.mockImplementation(async () => {
        expect(requestContext.getStore()).toBeDefined();
        throw failure;
      });
      const response = await GET(request());
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ success: false, error: { code: "INTERNAL_ERROR", message: "Internal server error" } });
      expect(mocks.log).toHaveBeenCalledWith({ err: failure }, "Agent team request failed");
      expect(mocks.globalLog).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
