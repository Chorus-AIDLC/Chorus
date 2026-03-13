import { describe, it, expect, vi, beforeEach } from "vitest";

// ===== Prisma mock =====
const mockPrisma = vi.hoisted(() => ({
  agent: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    count: vi.fn(),
  },
  apiKey: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    count: vi.fn(),
  },
  user: {
    findMany: vi.fn(),
  },
}));
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));

// ===== API Key mock =====
const mockGenerateApiKey = vi.fn();
vi.mock("@/lib/api-key", () => ({
  generateApiKey: () => mockGenerateApiKey(),
}));

import {
  listAgents,
  getAgent,
  getAgentByUuid,
  createAgent,
  updateAgent,
  deleteAgent,
  syncApiKeyNames,
  listApiKeys,
  createApiKey,
  getApiKey,
  revokeApiKey,
  getAgentsByOwner,
  getAgentsByRole,
  getCompanyUsers,
} from "@/services/agent.service";

// ===== Helpers =====
const now = new Date("2026-03-13T00:00:00Z");
const companyUuid = "company-0000-0000-0000-000000000001";
const agentUuid = "agent-0000-0000-0000-000000000001";
const ownerUuid = "user-0000-0000-0000-000000000001";
const apiKeyUuid = "apikey-0000-0000-0000-000000000001";

function makeAgent(overrides: Record<string, unknown> = {}) {
  return {
    uuid: agentUuid,
    name: "Test Agent",
    roles: ["developer_agent"],
    persona: null,
    systemPrompt: null,
    companyUuid,
    ownerUuid,
    lastActiveAt: null,
    createdAt: now,
    ...overrides,
  };
}

function makeApiKey(overrides: Record<string, unknown> = {}) {
  return {
    uuid: apiKeyUuid,
    agentUuid,
    companyUuid,
    keyHash: "hash123",
    keyPrefix: "cho_abc",
    name: "Test Key",
    lastUsed: null,
    expiresAt: null,
    revokedAt: null,
    createdAt: now,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGenerateApiKey.mockReturnValue({
    key: "cho_test_key_12345",
    hash: "hashed_value",
    prefix: "cho_test",
  });
});

// ===== listAgents =====
describe("listAgents", () => {
  it("should return paginated agents with counts", async () => {
    const agent = makeAgent({ _count: { apiKeys: 2 } });
    mockPrisma.agent.findMany.mockResolvedValue([agent]);
    mockPrisma.agent.count.mockResolvedValue(1);

    const result = await listAgents({ companyUuid, skip: 0, take: 20 });

    expect(result.agents).toHaveLength(1);
    expect(result.total).toBe(1);
    expect(result.agents[0].uuid).toBe(agentUuid);
    expect(result.agents[0]._count.apiKeys).toBe(2);
  });

  it("should order by createdAt desc", async () => {
    mockPrisma.agent.findMany.mockResolvedValue([]);
    mockPrisma.agent.count.mockResolvedValue(0);

    await listAgents({ companyUuid, skip: 0, take: 20 });

    expect(mockPrisma.agent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: { createdAt: "desc" },
      })
    );
  });

  it("should pass skip and take to prisma", async () => {
    mockPrisma.agent.findMany.mockResolvedValue([]);
    mockPrisma.agent.count.mockResolvedValue(0);

    await listAgents({ companyUuid, skip: 10, take: 5 });

    expect(mockPrisma.agent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 10, take: 5 })
    );
  });
});

// ===== getAgent =====
describe("getAgent", () => {
  it("should return agent with active API keys", async () => {
    const agent = makeAgent({
      apiKeys: [
        makeApiKey({ uuid: "key-1", revokedAt: null }),
        makeApiKey({ uuid: "key-2", revokedAt: null }),
      ],
    });
    mockPrisma.agent.findFirst.mockResolvedValue(agent);

    const result = await getAgent(companyUuid, agentUuid);

    expect(result).not.toBeNull();
    expect(result!.uuid).toBe(agentUuid);
    expect(result!.apiKeys).toHaveLength(2);
  });

  it("should return null when agent not found", async () => {
    mockPrisma.agent.findFirst.mockResolvedValue(null);

    const result = await getAgent(companyUuid, "nonexistent");
    expect(result).toBeNull();
  });

  it("should filter out revoked API keys", async () => {
    mockPrisma.agent.findFirst.mockResolvedValue(makeAgent());

    await getAgent(companyUuid, agentUuid);

    expect(mockPrisma.agent.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          apiKeys: expect.objectContaining({
            where: { revokedAt: null },
          }),
        }),
      })
    );
  });
});

// ===== getAgentByUuid =====
describe("getAgentByUuid", () => {
  it("should return agent with limited fields", async () => {
    const agent = makeAgent();
    mockPrisma.agent.findFirst.mockResolvedValue(agent);

    const result = await getAgentByUuid(companyUuid, agentUuid);

    expect(result).not.toBeNull();
    expect(result!.uuid).toBe(agentUuid);
    expect(result!.name).toBe("Test Agent");
    expect(result!.roles).toEqual(["developer_agent"]);
  });

  it("should return null when agent not found", async () => {
    mockPrisma.agent.findFirst.mockResolvedValue(null);

    const result = await getAgentByUuid(companyUuid, "nonexistent");
    expect(result).toBeNull();
  });
});

// ===== createAgent =====
describe("createAgent", () => {
  it("should create agent and return it", async () => {
    const agent = makeAgent();
    mockPrisma.agent.create.mockResolvedValue(agent);

    const result = await createAgent({
      companyUuid,
      name: "Test Agent",
      roles: ["developer_agent"],
      ownerUuid,
    });

    expect(result.uuid).toBe(agentUuid);
    expect(result.name).toBe("Test Agent");
    expect(mockPrisma.agent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          companyUuid,
          name: "Test Agent",
          roles: ["developer_agent"],
          ownerUuid,
          persona: undefined,
          systemPrompt: undefined,
        },
      })
    );
  });

  it("should pass persona and systemPrompt when provided", async () => {
    const agent = makeAgent({ persona: "Helpful", systemPrompt: "Be nice" });
    mockPrisma.agent.create.mockResolvedValue(agent);

    await createAgent({
      companyUuid,
      name: "Test Agent",
      roles: ["pm_agent"],
      ownerUuid,
      persona: "Helpful",
      systemPrompt: "Be nice",
    });

    expect(mockPrisma.agent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          persona: "Helpful",
          systemPrompt: "Be nice",
        }),
      })
    );
  });
});

// ===== updateAgent =====
describe("updateAgent", () => {
  it("should update agent fields", async () => {
    const updated = makeAgent({ name: "Updated Agent" });
    mockPrisma.agent.update.mockResolvedValue(updated);

    const result = await updateAgent(agentUuid, { name: "Updated Agent" });

    expect(result.name).toBe("Updated Agent");
    expect(mockPrisma.agent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { uuid: agentUuid },
        data: { name: "Updated Agent" },
      })
    );
  });

  it("should verify agent belongs to company when companyUuid provided", async () => {
    mockPrisma.agent.findFirst.mockResolvedValue(makeAgent());
    mockPrisma.agent.update.mockResolvedValue(makeAgent());

    await updateAgent(agentUuid, { name: "New Name" }, companyUuid);

    expect(mockPrisma.agent.findFirst).toHaveBeenCalledWith({
      where: { uuid: agentUuid, companyUuid },
      select: { uuid: true },
    });
  });

  it("should throw when agent not found in company", async () => {
    mockPrisma.agent.findFirst.mockResolvedValue(null);

    await expect(
      updateAgent(agentUuid, { name: "New Name" }, companyUuid)
    ).rejects.toThrow("Agent not found");
  });

  it("should update roles", async () => {
    const updated = makeAgent({ roles: ["pm_agent", "developer_agent"] });
    mockPrisma.agent.update.mockResolvedValue(updated);

    const result = await updateAgent(agentUuid, { roles: ["pm_agent", "developer_agent"] });

    expect(result.roles).toEqual(["pm_agent", "developer_agent"]);
  });
});

// ===== deleteAgent =====
describe("deleteAgent", () => {
  it("should delete agent by uuid", async () => {
    mockPrisma.agent.delete.mockResolvedValue(makeAgent());

    await deleteAgent(agentUuid);

    expect(mockPrisma.agent.delete).toHaveBeenCalledWith({
      where: { uuid: agentUuid },
    });
  });
});

// ===== syncApiKeyNames =====
describe("syncApiKeyNames", () => {
  it("should update all non-revoked API keys for agent", async () => {
    mockPrisma.apiKey.updateMany.mockResolvedValue({ count: 3 });

    const result = await syncApiKeyNames(agentUuid, "New Agent Name");

    expect(result.count).toBe(3);
    expect(mockPrisma.apiKey.updateMany).toHaveBeenCalledWith({
      where: { agentUuid, revokedAt: null },
      data: { name: "New Agent Name" },
    });
  });
});

// ===== listApiKeys =====
describe("listApiKeys", () => {
  it("should return paginated API keys with agent info", async () => {
    const apiKey = makeApiKey({
      agent: makeAgent(),
    });
    mockPrisma.apiKey.findMany.mockResolvedValue([apiKey]);
    mockPrisma.apiKey.count.mockResolvedValue(1);

    const result = await listApiKeys(companyUuid, 0, 20);

    expect(result.apiKeys).toHaveLength(1);
    expect(result.total).toBe(1);
    expect(result.apiKeys[0].agent.name).toBe("Test Agent");
  });

  it("should filter by ownerUuid when provided", async () => {
    mockPrisma.apiKey.findMany.mockResolvedValue([]);
    mockPrisma.apiKey.count.mockResolvedValue(0);

    await listApiKeys(companyUuid, 0, 20, ownerUuid);

    expect(mockPrisma.apiKey.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          agent: { ownerUuid },
        }),
      })
    );
  });

  it("should only return non-revoked keys", async () => {
    mockPrisma.apiKey.findMany.mockResolvedValue([]);
    mockPrisma.apiKey.count.mockResolvedValue(0);

    await listApiKeys(companyUuid, 0, 20);

    expect(mockPrisma.apiKey.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ revokedAt: null }),
      })
    );
  });
});

// ===== createApiKey =====
describe("createApiKey", () => {
  it("should create API key and return plaintext key", async () => {
    const apiKey = makeApiKey();
    mockPrisma.apiKey.create.mockResolvedValue(apiKey);

    const result = await createApiKey({
      companyUuid,
      agentUuid,
      name: "Test Key",
    });

    expect(result.uuid).toBe(apiKeyUuid);
    expect(result.key).toBe("cho_test_key_12345");
    expect(mockPrisma.apiKey.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          companyUuid,
          agentUuid,
          keyHash: "hashed_value",
          keyPrefix: "cho_test",
          name: "Test Key",
          expiresAt: undefined,
        },
      })
    );
  });

  it("should handle expiresAt parameter", async () => {
    const expiresAt = new Date("2027-01-01");
    const apiKey = makeApiKey({ expiresAt });
    mockPrisma.apiKey.create.mockResolvedValue(apiKey);

    await createApiKey({
      companyUuid,
      agentUuid,
      expiresAt,
    });

    expect(mockPrisma.apiKey.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ expiresAt }),
      })
    );
  });
});

// ===== getApiKey =====
describe("getApiKey", () => {
  it("should return API key details", async () => {
    const apiKey = makeApiKey();
    mockPrisma.apiKey.findFirst.mockResolvedValue(apiKey);

    const result = await getApiKey(companyUuid, apiKeyUuid);

    expect(result).not.toBeNull();
    expect(result!.uuid).toBe(apiKeyUuid);
    expect(result!.agentUuid).toBe(agentUuid);
  });

  it("should filter by ownerUuid when provided", async () => {
    mockPrisma.apiKey.findFirst.mockResolvedValue(makeApiKey());

    await getApiKey(companyUuid, apiKeyUuid, ownerUuid);

    expect(mockPrisma.apiKey.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          agent: { ownerUuid },
        }),
      })
    );
  });

  it("should return null when API key not found", async () => {
    mockPrisma.apiKey.findFirst.mockResolvedValue(null);

    const result = await getApiKey(companyUuid, "nonexistent");
    expect(result).toBeNull();
  });
});

// ===== revokeApiKey =====
describe("revokeApiKey", () => {
  it("should set revokedAt timestamp", async () => {
    const revoked = makeApiKey({ revokedAt: now });
    mockPrisma.apiKey.update.mockResolvedValue(revoked);

    const result = await revokeApiKey(apiKeyUuid);

    expect(result.revokedAt).toBe(now);
    expect(mockPrisma.apiKey.update).toHaveBeenCalledWith({
      where: { uuid: apiKeyUuid },
      data: { revokedAt: expect.any(Date) },
    });
  });
});

// ===== getAgentsByOwner =====
describe("getAgentsByOwner", () => {
  it("should return agents owned by user", async () => {
    const agents = [
      makeAgent({ uuid: "agent-1", name: "Agent 1" }),
      makeAgent({ uuid: "agent-2", name: "Agent 2" }),
    ];
    mockPrisma.agent.findMany.mockResolvedValue(agents);

    const result = await getAgentsByOwner(companyUuid, ownerUuid);

    expect(result).toHaveLength(2);
    expect(mockPrisma.agent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { companyUuid, ownerUuid },
        orderBy: { name: "asc" },
      })
    );
  });
});

// ===== getAgentsByRole =====
describe("getAgentsByRole", () => {
  it("should find agents with exact role match", async () => {
    const agents = [makeAgent({ roles: ["developer_agent"] })];
    mockPrisma.agent.findMany.mockResolvedValue(agents);

    await getAgentsByRole(companyUuid, "developer_agent");

    expect(mockPrisma.agent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            { roles: { has: "developer_agent" } },
            { roles: { has: "developer_agent_agent" } },
          ],
        }),
      })
    );
  });

  it("should support both role formats (with and without _agent suffix)", async () => {
    mockPrisma.agent.findMany.mockResolvedValue([]);

    await getAgentsByRole(companyUuid, "developer");

    expect(mockPrisma.agent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            { roles: { has: "developer" } },
            { roles: { has: "developer_agent" } },
          ],
        }),
      })
    );
  });

  it("should filter by ownerUuid when provided", async () => {
    mockPrisma.agent.findMany.mockResolvedValue([]);

    await getAgentsByRole(companyUuid, "pm_agent", ownerUuid);

    expect(mockPrisma.agent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ ownerUuid }),
      })
    );
  });

  it("should order by name asc", async () => {
    mockPrisma.agent.findMany.mockResolvedValue([]);

    await getAgentsByRole(companyUuid, "developer_agent");

    expect(mockPrisma.agent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: { name: "asc" },
      })
    );
  });
});

// ===== getCompanyUsers =====
describe("getCompanyUsers", () => {
  it("should return all users in company", async () => {
    const users = [
      { uuid: "user-1", name: "User 1", email: "user1@test.com" },
      { uuid: "user-2", name: "User 2", email: "user2@test.com" },
    ];
    mockPrisma.user.findMany.mockResolvedValue(users);

    const result = await getCompanyUsers(companyUuid);

    expect(result).toHaveLength(2);
    expect(mockPrisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { companyUuid },
        orderBy: { name: "asc" },
      })
    );
  });
});
