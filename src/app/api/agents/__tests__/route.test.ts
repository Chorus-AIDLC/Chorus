import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockGetAuthContext = vi.fn();
const mockPrisma = vi.hoisted(() => ({
  agent: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    count: vi.fn(),
  },
}));
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/auth", () => ({
  getAuthContext: (...args: unknown[]) => mockGetAuthContext(...args),
  isUser: (auth: { type: string }) => auth?.type === "user",
  isAgent: (auth: { type: string }) => auth?.type === "agent",
}));

import { GET, POST } from "@/app/api/agents/route";
import {
  GET as GET_DETAIL,
  PATCH,
} from "@/app/api/agents/[uuid]/route";

const companyUuid = "company-0000-0000-0000-000000000001";
const userUuid = "user-0000-0000-0000-000000000001";
const agentUuid = "agent-0000-0000-0000-000000000001";

const userAuth = {
  type: "user",
  companyUuid,
  actorUuid: userUuid,
};

function jsonRequest(
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) {
  return new NextRequest(new URL(url, "http://localhost:3000"), init);
}

function ctx(uuid: string) {
  return { params: Promise.resolve({ uuid }) };
}

// Empty context for handlers that don't have route params
const emptyCtx = { params: Promise.resolve({}) } as { params: Promise<Record<string, string>> };

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAuthContext.mockResolvedValue(userAuth);
});

describe("POST /api/agents", () => {
  it("creates an agent with empty permissions by default and returns roles/permissions/effectivePermissions", async () => {
    mockPrisma.agent.create.mockResolvedValue({
      uuid: agentUuid,
      name: "Test",
      roles: ["developer_agent"],
      permissions: [],
      persona: null,
      systemPrompt: null,
      ownerUuid: userUuid,
      createdAt: new Date("2026-04-01T00:00:00Z"),
    });

    const req = jsonRequest("/api/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Test", roles: ["developer_agent"] }),
    });
    const res = await POST(req, emptyCtx);
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(body.data.roles).toEqual(["developer_agent"]);
    expect(body.data.permissions).toEqual([]);
    // developer_agent preset has 6 permissions
    expect(body.data.effectivePermissions).toHaveLength(6);
    expect(new Set(body.data.effectivePermissions)).toEqual(
      new Set([
        "idea:read",
        "proposal:read",
        "document:read",
        "project:read",
        "task:read",
        "task:write",
      ]),
    );
  });

  it("creates an agent with custom permissions merged over role preset in effectivePermissions", async () => {
    mockPrisma.agent.create.mockResolvedValue({
      uuid: agentUuid,
      name: "Test",
      roles: ["developer_agent"],
      permissions: ["proposal:write"],
      persona: null,
      systemPrompt: null,
      ownerUuid: userUuid,
      createdAt: new Date("2026-04-01T00:00:00Z"),
    });

    const req = jsonRequest("/api/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Test",
        roles: ["developer_agent"],
        permissions: ["proposal:write"],
      }),
    });
    const res = await POST(req, emptyCtx);
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(body.data.permissions).toEqual(["proposal:write"]);
    expect(new Set(body.data.effectivePermissions)).toContain("proposal:write");
    // Still includes developer_agent preset
    expect(new Set(body.data.effectivePermissions)).toContain("task:write");
  });

  it("returns 400 with 'Invalid permission: X' when permissions contains an unknown entry", async () => {
    const req = jsonRequest("/api/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Test",
        roles: ["developer_agent"],
        permissions: ["foo:bar"],
      }),
    });
    const res = await POST(req, emptyCtx);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error.message).toBe("Invalid permission: foo:bar");
    expect(mockPrisma.agent.create).not.toHaveBeenCalled();
  });

  it("rejects legacy role aliases (pm/developer/admin) with 400", async () => {
    const req = jsonRequest("/api/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Test", roles: ["pm"] }),
    });
    const res = await POST(req, emptyCtx);
    const body = await res.json();

    expect(res.status).toBe(422);
    expect(body.success).toBe(false);
    expect(body.error.details?.roles).toMatch(/pm_agent, developer_agent, or admin_agent/);
    expect(mockPrisma.agent.create).not.toHaveBeenCalled();
  });

  it("returns 401 when unauthenticated", async () => {
    mockGetAuthContext.mockResolvedValue(null);

    const req = jsonRequest("/api/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Test" }),
    });
    const res = await POST(req, emptyCtx);
    expect(res.status).toBe(401);
  });

  it("returns 403 when caller is an agent (only users can create)", async () => {
    mockGetAuthContext.mockResolvedValue({
      type: "agent",
      companyUuid,
      actorUuid: "agent-x",
      roles: [],
      permissions: [],
    });

    const req = jsonRequest("/api/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Test" }),
    });
    const res = await POST(req, emptyCtx);
    expect(res.status).toBe(403);
  });
});

describe("GET /api/agents (list)", () => {
  it("includes roles, permissions, and effectivePermissions in each agent", async () => {
    mockPrisma.agent.findMany.mockResolvedValue([
      {
        uuid: agentUuid,
        name: "Dev",
        roles: ["developer_agent"],
        permissions: ["proposal:write"],
        persona: null,
        ownerUuid: userUuid,
        lastActiveAt: null,
        createdAt: new Date("2026-04-01T00:00:00Z"),
        _count: { apiKeys: 1 },
      },
    ]);
    mockPrisma.agent.count.mockResolvedValue(1);

    const req = jsonRequest("/api/agents");
    const res = await GET(req, emptyCtx);
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].roles).toEqual(["developer_agent"]);
    expect(body.data[0].permissions).toEqual(["proposal:write"]);
    expect(new Set(body.data[0].effectivePermissions)).toContain("proposal:write");
    expect(new Set(body.data[0].effectivePermissions)).toContain("task:write");
  });
});

describe("GET /api/agents/[uuid] (detail)", () => {
  it("includes roles, permissions, and effectivePermissions", async () => {
    mockPrisma.agent.findFirst.mockResolvedValue({
      uuid: agentUuid,
      name: "Dev",
      roles: ["developer_agent"],
      permissions: ["proposal:write"],
      persona: null,
      systemPrompt: null,
      ownerUuid: userUuid,
      lastActiveAt: null,
      createdAt: new Date("2026-04-01T00:00:00Z"),
      apiKeys: [],
    });

    const req = jsonRequest(`/api/agents/${agentUuid}`);
    const res = await GET_DETAIL(req, ctx(agentUuid));
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(body.data.roles).toEqual(["developer_agent"]);
    expect(body.data.permissions).toEqual(["proposal:write"]);
    expect(new Set(body.data.effectivePermissions)).toContain("proposal:write");
  });

  it("returns 404 when agent not found", async () => {
    mockPrisma.agent.findFirst.mockResolvedValue(null);

    const req = jsonRequest(`/api/agents/${agentUuid}`);
    const res = await GET_DETAIL(req, ctx(agentUuid));
    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/agents/[uuid]", () => {
  beforeEach(() => {
    mockPrisma.agent.findFirst.mockResolvedValue({
      uuid: agentUuid,
      name: "Old",
      roles: ["developer_agent"],
      permissions: [],
      persona: null,
      systemPrompt: null,
      ownerUuid: userUuid,
      companyUuid,
      createdAt: new Date("2026-04-01T00:00:00Z"),
    });
  });

  it("updates permissions independently without touching roles", async () => {
    mockPrisma.agent.update.mockResolvedValue({
      uuid: agentUuid,
      name: "Old",
      roles: ["developer_agent"],
      permissions: ["proposal:write", "document:write"],
      persona: null,
      systemPrompt: null,
      ownerUuid: userUuid,
      lastActiveAt: null,
      createdAt: new Date("2026-04-01T00:00:00Z"),
    });

    const req = jsonRequest(`/api/agents/${agentUuid}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        permissions: ["proposal:write", "document:write"],
      }),
    });
    const res = await PATCH(req, ctx(agentUuid));
    const body = await res.json();

    expect(body.success).toBe(true);
    // Prisma update data must contain permissions but NOT roles
    const updateCall = mockPrisma.agent.update.mock.calls[0][0];
    expect(updateCall.data.permissions).toEqual([
      "proposal:write",
      "document:write",
    ]);
    expect(updateCall.data.roles).toBeUndefined();
    // Response still reports the agent's existing roles
    expect(body.data.roles).toEqual(["developer_agent"]);
    expect(body.data.permissions).toEqual(["proposal:write", "document:write"]);
    expect(new Set(body.data.effectivePermissions)).toContain("document:write");
  });

  it("updates roles independently without touching permissions", async () => {
    mockPrisma.agent.update.mockResolvedValue({
      uuid: agentUuid,
      name: "Old",
      roles: ["pm_agent"],
      permissions: [],
      persona: null,
      systemPrompt: null,
      ownerUuid: userUuid,
      lastActiveAt: null,
      createdAt: new Date("2026-04-01T00:00:00Z"),
    });

    const req = jsonRequest(`/api/agents/${agentUuid}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roles: ["pm_agent"] }),
    });
    const res = await PATCH(req, ctx(agentUuid));
    const body = await res.json();

    expect(body.success).toBe(true);
    const updateCall = mockPrisma.agent.update.mock.calls[0][0];
    expect(updateCall.data.roles).toEqual(["pm_agent"]);
    expect(updateCall.data.permissions).toBeUndefined();
    expect(body.data.roles).toEqual(["pm_agent"]);
  });

  it("returns 400 'Invalid permission: X' for unknown permission", async () => {
    const req = jsonRequest(`/api/agents/${agentUuid}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ permissions: ["not:valid"] }),
    });
    const res = await PATCH(req, ctx(agentUuid));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error.message).toBe("Invalid permission: not:valid");
    expect(mockPrisma.agent.update).not.toHaveBeenCalled();
  });

  it("accepts empty permissions array (clearing custom permissions)", async () => {
    mockPrisma.agent.update.mockResolvedValue({
      uuid: agentUuid,
      name: "Old",
      roles: ["developer_agent"],
      permissions: [],
      persona: null,
      systemPrompt: null,
      ownerUuid: userUuid,
      lastActiveAt: null,
      createdAt: new Date("2026-04-01T00:00:00Z"),
    });

    const req = jsonRequest(`/api/agents/${agentUuid}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ permissions: [] }),
    });
    const res = await PATCH(req, ctx(agentUuid));
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(mockPrisma.agent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ permissions: [] }),
      }),
    );
  });
});
