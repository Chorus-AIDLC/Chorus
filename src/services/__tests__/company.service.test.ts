import { describe, it, expect, vi, beforeEach } from "vitest";

// ===== Prisma mock =====
const mockPrisma = vi.hoisted(() => ({
  company: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    count: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  user: {
    count: vi.fn(),
    deleteMany: vi.fn(),
    findMany: vi.fn(),
  },
  agent: {
    count: vi.fn(),
    deleteMany: vi.fn(),
  },
  apiKey: {
    deleteMany: vi.fn(),
  },
  project: {
    deleteMany: vi.fn(),
  },
  idea: {
    deleteMany: vi.fn(),
  },
  document: {
    deleteMany: vi.fn(),
  },
  task: {
    deleteMany: vi.fn(),
  },
  proposal: {
    deleteMany: vi.fn(),
  },
  comment: {
    deleteMany: vi.fn(),
  },
  activity: {
    deleteMany: vi.fn(),
  },
  $transaction: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));

import {
  listCompanies,
  getCompanyByUuid,
  getCompanyByEmailDomain,
  getCandidateCompaniesForEmail,
  createCompany,
  updateCompany,
  deleteCompany,
  getCompanyStats,
  getCompanyByEmailDomainAny,
} from "@/services/company.service";

// ===== Helpers =====
const now = new Date("2026-03-13T00:00:00Z");
const companyUuid = "company-0000-0000-0000-000000000001";

function makeCompany(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    uuid: companyUuid,
    name: "Test Company",
    emailDomains: ["example.com"],
    oidcIssuer: null,
    oidcClientId: null,
    oidcEnabled: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ===== listCompanies =====
describe("listCompanies", () => {
  it("should return paginated companies with counts", async () => {
    const company = makeCompany({
      _count: { users: 5, agents: 3 },
    });
    mockPrisma.company.findMany.mockResolvedValue([company]);
    mockPrisma.company.count.mockResolvedValue(1);

    const result = await listCompanies({ skip: 0, take: 20 });

    expect(result.companies).toHaveLength(1);
    expect(result.total).toBe(1);
    expect(result.companies[0].uuid).toBe(companyUuid);
    expect(result.companies[0]._count.users).toBe(5);
    expect(result.companies[0]._count.agents).toBe(3);
  });

  it("should pass skip and take to prisma", async () => {
    mockPrisma.company.findMany.mockResolvedValue([]);
    mockPrisma.company.count.mockResolvedValue(0);

    await listCompanies({ skip: 10, take: 5 });

    expect(mockPrisma.company.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 10, take: 5 })
    );
  });

  it("should order by createdAt desc", async () => {
    mockPrisma.company.findMany.mockResolvedValue([]);
    mockPrisma.company.count.mockResolvedValue(0);

    await listCompanies({ skip: 0, take: 20 });

    expect(mockPrisma.company.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { createdAt: "desc" } })
    );
  });
});

// ===== getCompanyByUuid =====
describe("getCompanyByUuid", () => {
  it("should return company with project count", async () => {
    const company = makeCompany({
      _count: { users: 5, agents: 3, projects: 10 },
    });
    mockPrisma.company.findFirst.mockResolvedValue(company);

    const result = await getCompanyByUuid(companyUuid);

    expect(result).not.toBeNull();
    expect(result!.uuid).toBe(companyUuid);
    expect(result!._count.projects).toBe(10);
  });

  it("should return null when company not found", async () => {
    mockPrisma.company.findFirst.mockResolvedValue(null);

    const result = await getCompanyByUuid("nonexistent");
    expect(result).toBeNull();
  });

  it("should include OIDC config fields", async () => {
    const company = makeCompany({
      oidcIssuer: "https://auth.example.com",
      oidcClientId: "client123",
      oidcEnabled: true,
      _count: { users: 0, agents: 0, projects: 0 },
    });
    mockPrisma.company.findFirst.mockResolvedValue(company);

    const result = await getCompanyByUuid(companyUuid);

    expect(result!.oidcIssuer).toBe("https://auth.example.com");
    expect(result!.oidcClientId).toBe("client123");
    expect(result!.oidcEnabled).toBe(true);
  });
});

// ===== getCompanyByEmailDomain =====
describe("getCompanyByEmailDomain", () => {
  it("should return company when domain matches and OIDC enabled", async () => {
    const company = makeCompany({
      emailDomains: ["example.com"],
      oidcEnabled: true,
      oidcIssuer: "https://auth.example.com",
      oidcClientId: "client123",
    });
    mockPrisma.company.findFirst.mockResolvedValue(company);

    const result = await getCompanyByEmailDomain("user@example.com");

    expect(result).not.toBeNull();
    expect(result!.uuid).toBe(companyUuid);
    expect(mockPrisma.company.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          emailDomains: { has: "example.com" },
          oidcEnabled: true,
        }),
      })
    );
  });

  it("should convert domain to lowercase", async () => {
    mockPrisma.company.findFirst.mockResolvedValue(null);

    await getCompanyByEmailDomain("user@EXAMPLE.COM");

    expect(mockPrisma.company.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          emailDomains: { has: "example.com" },
        }),
      })
    );
  });

  it("should return null for invalid email", async () => {
    const result = await getCompanyByEmailDomain("notanemail");
    expect(result).toBeNull();
  });

  it("should return null for email without domain", async () => {
    const result = await getCompanyByEmailDomain("user@");
    expect(result).toBeNull();
  });
});

// ===== getCandidateCompaniesForEmail =====
describe("getCandidateCompaniesForEmail", () => {
  const companyA = "company-aaaa-0000-0000-000000000001";
  const companyB = "company-bbbb-0000-0000-000000000002";

  function candidate(overrides: Record<string, unknown> = {}) {
    return {
      uuid: companyA,
      name: "Acme",
      oidcIssuer: "https://auth.acme.com",
      oidcClientId: "client-a",
      ...overrides,
    };
  }

  it("returns [] when email has no domain", async () => {
    const result = await getCandidateCompaniesForEmail("notanemail");
    expect(result).toEqual([]);
    expect(mockPrisma.company.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.user.findMany).not.toHaveBeenCalled();
  });

  it("returns [] when nothing matches (0 hits)", async () => {
    mockPrisma.company.findMany.mockResolvedValue([]);
    mockPrisma.user.findMany.mockResolvedValue([]);

    const result = await getCandidateCompaniesForEmail("nobody@nowhere.com");

    expect(result).toEqual([]);
    expect(mockPrisma.company.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          emailDomains: { has: "nowhere.com" },
          oidcEnabled: true,
          oidcIssuer: { not: null },
          oidcClientId: { not: null },
        }),
      })
    );
    expect(mockPrisma.user.findMany).toHaveBeenCalledWith({
      where: { email: "nobody@nowhere.com" },
      select: { companyUuid: true },
    });
  });

  it("returns domain-only matches", async () => {
    mockPrisma.company.findMany.mockResolvedValueOnce([candidate()]);
    mockPrisma.user.findMany.mockResolvedValue([]);

    const result = await getCandidateCompaniesForEmail("alice@acme.com");

    expect(result).toEqual([
      {
        uuid: companyA,
        name: "Acme",
        oidcIssuer: "https://auth.acme.com",
        oidcClientId: "client-a",
      },
    ]);
  });

  it("returns User.email-only matches", async () => {
    mockPrisma.company.findMany.mockResolvedValueOnce([]);
    mockPrisma.user.findMany.mockResolvedValue([{ companyUuid: companyB }]);
    mockPrisma.company.findMany.mockResolvedValueOnce([
      candidate({ uuid: companyB, name: "Bravo", oidcClientId: "client-b" }),
    ]);

    const result = await getCandidateCompaniesForEmail("alice@other.com");

    expect(result).toHaveLength(1);
    expect(result[0].uuid).toBe(companyB);
    expect(result[0].name).toBe("Bravo");
  });

  it("deduplicates when both paths hit the same Company", async () => {
    const both = candidate();
    mockPrisma.company.findMany.mockResolvedValueOnce([both]);
    mockPrisma.user.findMany.mockResolvedValue([{ companyUuid: companyA }]);
    mockPrisma.company.findMany.mockResolvedValueOnce([both]);

    const result = await getCandidateCompaniesForEmail("alice@acme.com");

    expect(result).toHaveLength(1);
    expect(result[0].uuid).toBe(companyA);
  });

  it("merges two different Companies across both paths, sorted by name asc", async () => {
    mockPrisma.company.findMany.mockResolvedValueOnce([
      candidate({ uuid: companyB, name: "Zephyr", oidcClientId: "client-b" }),
    ]);
    mockPrisma.user.findMany.mockResolvedValue([{ companyUuid: companyA }]);
    mockPrisma.company.findMany.mockResolvedValueOnce([
      candidate({ uuid: companyA, name: "Acme", oidcClientId: "client-a" }),
    ]);

    const result = await getCandidateCompaniesForEmail("alice@zephyr.com");

    expect(result.map((c) => c.name)).toEqual(["Acme", "Zephyr"]);
    expect(result.map((c) => c.uuid)).toEqual([companyA, companyB]);
  });

  it("filters out Companies missing oidcIssuer or oidcClientId", async () => {
    // The queries themselves filter via { not: null }, but also guard defensively
    mockPrisma.company.findMany.mockResolvedValueOnce([
      candidate({ oidcIssuer: null }),
      candidate({ uuid: companyB, oidcClientId: null }),
    ]);
    mockPrisma.user.findMany.mockResolvedValue([]);

    const result = await getCandidateCompaniesForEmail("alice@acme.com");

    expect(result).toEqual([]);
  });

  it("excludes Company with matching emailDomain but oidcEnabled=false", async () => {
    // Prisma query filters oidcEnabled=true, so such Companies never appear in the result set.
    // Simulate that by returning [] from company.findMany.
    mockPrisma.company.findMany.mockResolvedValueOnce([]);
    mockPrisma.user.findMany.mockResolvedValue([]);

    const result = await getCandidateCompaniesForEmail("alice@acme.com");

    expect(result).toEqual([]);
    expect(mockPrisma.company.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ oidcEnabled: true }),
      })
    );
  });

  it("excludes Company reached via User.email when that Company has oidcEnabled=false", async () => {
    mockPrisma.company.findMany.mockResolvedValueOnce([]);
    mockPrisma.user.findMany.mockResolvedValue([{ companyUuid: companyA }]);
    // Second findMany (for user companies) filters oidcEnabled=true, so returns []
    mockPrisma.company.findMany.mockResolvedValueOnce([]);

    const result = await getCandidateCompaniesForEmail("alice@nowhere.com");

    expect(result).toEqual([]);
    // Second call must include oidcEnabled=true constraint
    expect(mockPrisma.company.findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({
          uuid: { in: [companyA] },
          oidcEnabled: true,
          oidcIssuer: { not: null },
          oidcClientId: { not: null },
        }),
      })
    );
  });

  it("normalizes email (trim + lowercase) before querying", async () => {
    mockPrisma.company.findMany.mockResolvedValue([]);
    mockPrisma.user.findMany.mockResolvedValue([]);

    await getCandidateCompaniesForEmail("  Alice@ACME.com  ");

    expect(mockPrisma.company.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          emailDomains: { has: "acme.com" },
        }),
      })
    );
    expect(mockPrisma.user.findMany).toHaveBeenCalledWith({
      where: { email: "alice@acme.com" },
      select: { companyUuid: true },
    });
  });
});

// ===== getCompanyByEmailDomainAny =====
describe("getCompanyByEmailDomainAny", () => {
  it("should return company when domain matches regardless of OIDC", async () => {
    const company = makeCompany({
      emailDomains: ["example.com"],
      oidcEnabled: false,
    });
    mockPrisma.company.findFirst.mockResolvedValue(company);

    const result = await getCompanyByEmailDomainAny("user@example.com");

    expect(result).not.toBeNull();
    expect(result!.uuid).toBe(companyUuid);
    expect(mockPrisma.company.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          emailDomains: { has: "example.com" },
        }),
      })
    );
  });

  it("should return null for invalid email", async () => {
    const result = await getCompanyByEmailDomainAny("notanemail");
    expect(result).toBeNull();
  });
});

// ===== createCompany =====
describe("createCompany", () => {
  it("should create company with lowercase email domains", async () => {
    const company = makeCompany({
      emailDomains: ["example.com", "test.com"],
    });
    mockPrisma.company.create.mockResolvedValue(company);

    const result = await createCompany({
      name: "Test Company",
      emailDomains: ["EXAMPLE.COM", "test.com"],
    });

    expect(result.uuid).toBe(companyUuid);
    expect(mockPrisma.company.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          name: "Test Company",
          emailDomains: ["example.com", "test.com"],
        }),
      })
    );
  });

  it("should set oidcEnabled to true when issuer and clientId provided", async () => {
    const company = makeCompany({
      oidcIssuer: "https://auth.example.com",
      oidcClientId: "client123",
      oidcEnabled: true,
    });
    mockPrisma.company.create.mockResolvedValue(company);

    await createCompany({
      name: "Test Company",
      oidcIssuer: "https://auth.example.com",
      oidcClientId: "client123",
    });

    expect(mockPrisma.company.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          oidcEnabled: true,
        }),
      })
    );
  });

  it("should set oidcEnabled to false when issuer or clientId missing", async () => {
    const company = makeCompany({ oidcEnabled: false });
    mockPrisma.company.create.mockResolvedValue(company);

    await createCompany({
      name: "Test Company",
      oidcIssuer: "https://auth.example.com",
    });

    expect(mockPrisma.company.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          oidcEnabled: false,
        }),
      })
    );
  });

  it("should handle empty email domains", async () => {
    const company = makeCompany({ emailDomains: [] });
    mockPrisma.company.create.mockResolvedValue(company);

    await createCompany({
      name: "Test Company",
    });

    expect(mockPrisma.company.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          emailDomains: [],
        }),
      })
    );
  });
});

// ===== updateCompany =====
describe("updateCompany", () => {
  it("should update company fields", async () => {
    const updated = makeCompany({ name: "Updated Name" });
    mockPrisma.company.update.mockResolvedValue(updated);

    const result = await updateCompany(1, { name: "Updated Name" });

    expect(result.name).toBe("Updated Name");
    expect(mockPrisma.company.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 1 },
        data: { name: "Updated Name" },
      })
    );
  });

  it("should lowercase email domains on update", async () => {
    const updated = makeCompany({ emailDomains: ["example.com"] });
    mockPrisma.company.update.mockResolvedValue(updated);

    await updateCompany(1, {
      emailDomains: ["EXAMPLE.COM"],
    });

    expect(mockPrisma.company.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          emailDomains: ["example.com"],
        }),
      })
    );
  });

  it("should not modify email domains when not provided", async () => {
    const updated = makeCompany();
    mockPrisma.company.update.mockResolvedValue(updated);

    await updateCompany(1, { name: "Updated Name" });

    expect(mockPrisma.company.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { name: "Updated Name" },
      })
    );
  });
});

// ===== deleteCompany =====
describe("deleteCompany", () => {
  it("should delete company and all related data in transaction", async () => {
    const company = makeCompany();
    const txMock = {
      company: {
        findUnique: vi.fn().mockResolvedValue(company),
        delete: vi.fn().mockResolvedValue(company),
      },
      activity: { deleteMany: vi.fn() },
      comment: { deleteMany: vi.fn() },
      proposal: { deleteMany: vi.fn() },
      task: { deleteMany: vi.fn() },
      document: { deleteMany: vi.fn() },
      idea: { deleteMany: vi.fn() },
      project: { deleteMany: vi.fn() },
      apiKey: { deleteMany: vi.fn() },
      agent: { deleteMany: vi.fn() },
      user: { deleteMany: vi.fn() },
    };

    mockPrisma.$transaction.mockImplementation(async (callback) => {
      return callback(txMock);
    });

    const result = await deleteCompany(1);

    expect(result.uuid).toBe(companyUuid);
    expect(txMock.company.findUnique).toHaveBeenCalledWith({
      where: { id: 1 },
      select: { uuid: true },
    });
    expect(txMock.activity.deleteMany).toHaveBeenCalledWith({
      where: { companyUuid },
    });
    expect(txMock.user.deleteMany).toHaveBeenCalledWith({
      where: { companyUuid },
    });
    expect(txMock.company.delete).toHaveBeenCalledWith({ where: { id: 1 } });
  });

  it("should throw error when company not found", async () => {
    const txMock = {
      company: {
        findUnique: vi.fn().mockResolvedValue(null),
      },
    };

    mockPrisma.$transaction.mockImplementation(async (callback) => {
      return callback(txMock);
    });

    await expect(deleteCompany(999)).rejects.toThrow("Company not found");
  });
});

// ===== getCompanyStats =====
describe("getCompanyStats", () => {
  it("should return aggregated stats across all companies", async () => {
    mockPrisma.company.count.mockResolvedValue(5);
    mockPrisma.user.count.mockResolvedValue(50);
    mockPrisma.agent.count.mockResolvedValue(10);

    const result = await getCompanyStats();

    expect(result).toEqual({
      totalCompanies: 5,
      totalUsers: 50,
      totalAgents: 10,
    });
  });

  it("should handle zero counts", async () => {
    mockPrisma.company.count.mockResolvedValue(0);
    mockPrisma.user.count.mockResolvedValue(0);
    mockPrisma.agent.count.mockResolvedValue(0);

    const result = await getCompanyStats();

    expect(result).toEqual({
      totalCompanies: 0,
      totalUsers: 0,
      totalAgents: 0,
    });
  });
});
