import { describe, it, expect, vi, beforeEach } from "vitest";

// ===== Prisma mock =====
const mockPrisma = vi.hoisted(() => ({
  user: {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    upsert: vi.fn(),
  },
  company: {
    findFirst: vi.fn(),
    create: vi.fn(),
  },
}));
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));

import {
  findOrCreateUserByOidc,
  findOrCreateDefaultUser,
  getUserByUuid,
  getCompanyByUuid,
} from "@/services/user.service";

// ===== Helpers =====
const now = new Date("2026-03-13T00:00:00Z");
const companyUuid = "company-0000-0000-0000-000000000001";
const userUuid = "user-0000-0000-0000-000000000001";

function makeCompany(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    uuid: companyUuid,
    name: "Test Company",
    emailDomains: ["test.com"],
    oidcEnabled: true,
    oidcIssuer: "https://auth.test.com",
    oidcClientId: "client123",
    oidcClientSecret: "secret",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeUser(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    uuid: userUuid,
    email: "user@test.com",
    name: "Test User",
    oidcSub: "oidc-sub-123",
    companyUuid,
    createdAt: now,
    updatedAt: now,
    company: {
      uuid: companyUuid,
      name: "Test Company",
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ===== findOrCreateUserByOidc =====
describe("findOrCreateUserByOidc", () => {
  it("should return existing user by oidcSub", async () => {
    const user = makeUser();
    mockPrisma.user.findFirst.mockResolvedValue(user);

    const result = await findOrCreateUserByOidc({
      oidcSub: "oidc-sub-123",
      email: "user@test.com",
      name: "Test User",
      companyUuid,
    });

    expect(result).not.toBeNull();
    expect(result.uuid).toBe(userUuid);
    expect(result.email).toBe("user@test.com");
    expect(mockPrisma.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { oidcSub: "oidc-sub-123", companyUuid },
      })
    );
  });

  it("should update user info when email or name changes", async () => {
    const existingUser = makeUser({ email: "old@test.com", name: "Old Name" });
    const updatedUser = makeUser({ email: "new@test.com", name: "New Name" });
    mockPrisma.user.findFirst.mockResolvedValue(existingUser);
    mockPrisma.user.update.mockResolvedValue(updatedUser);

    const result = await findOrCreateUserByOidc({
      oidcSub: "oidc-sub-123",
      email: "new@test.com",
      name: "New Name",
      companyUuid,
    });

    expect(result.email).toBe("new@test.com");
    expect(result.name).toBe("New Name");
    expect(mockPrisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 1 },
        data: { email: "new@test.com", name: "New Name" },
      })
    );
  });

  it("should not update when email and name are unchanged", async () => {
    const user = makeUser();
    mockPrisma.user.findFirst.mockResolvedValue(user);

    await findOrCreateUserByOidc({
      oidcSub: "oidc-sub-123",
      email: "user@test.com",
      name: "Test User",
      companyUuid,
    });

    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  it("should link oidcSub to existing user by email", async () => {
    const existingUser = makeUser({ oidcSub: null });
    mockPrisma.user.findFirst
      .mockResolvedValueOnce(null) // First call: no user by oidcSub
      .mockResolvedValueOnce(existingUser); // Second call: found by email
    mockPrisma.user.update.mockResolvedValue(makeUser());

    const result = await findOrCreateUserByOidc({
      oidcSub: "new-oidc-sub",
      email: "user@test.com",
      name: "Test User",
      companyUuid,
    });

    expect(mockPrisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 1 },
        data: { oidcSub: "new-oidc-sub", name: "Test User" },
      })
    );
  });

  it("should create new user when not found by oidcSub or email", async () => {
    mockPrisma.user.findFirst
      .mockResolvedValueOnce(null) // No user by oidcSub
      .mockResolvedValueOnce(null); // No user by email
    mockPrisma.user.create.mockResolvedValue(makeUser());

    const result = await findOrCreateUserByOidc({
      oidcSub: "new-oidc-sub",
      email: "newuser@test.com",
      name: "New User",
      companyUuid,
    });

    expect(mockPrisma.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          email: "newuser@test.com",
          name: "New User",
          oidcSub: "new-oidc-sub",
          companyUuid,
        },
      })
    );
  });

  it("should handle missing name parameter", async () => {
    mockPrisma.user.findFirst.mockResolvedValue(null).mockResolvedValue(null);
    mockPrisma.user.create.mockResolvedValue(makeUser({ name: null }));

    await findOrCreateUserByOidc({
      oidcSub: "oidc-sub-123",
      email: "user@test.com",
      companyUuid,
    });

    expect(mockPrisma.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ name: undefined }),
      })
    );
  });
});

// ===== findOrCreateDefaultUser =====
describe("findOrCreateDefaultUser", () => {
  it("should throw error when email has no domain", async () => {
    await expect(findOrCreateDefaultUser("invalid-email")).rejects.toThrow(
      "Invalid email: no domain"
    );
  });

  it("should find existing company by email domain", async () => {
    const company = makeCompany();
    const user = makeUser();
    mockPrisma.company.findFirst.mockResolvedValue(company);
    mockPrisma.user.upsert.mockResolvedValue(user);

    const result = await findOrCreateDefaultUser("user@test.com");

    expect(result.uuid).toBe(userUuid);
    expect(mockPrisma.company.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { emailDomains: { has: "test.com" } },
      })
    );
  });

  it("should create company when not found by domain", async () => {
    const company = makeCompany();
    mockPrisma.company.findFirst.mockResolvedValue(null);
    mockPrisma.company.create.mockResolvedValue(company);
    mockPrisma.user.upsert.mockResolvedValue(makeUser());

    await findOrCreateDefaultUser("user@newdomain.com");

    expect(mockPrisma.company.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          name: "newdomain.com",
          emailDomains: ["newdomain.com"],
          oidcEnabled: false,
        },
      })
    );
  });

  it("should return existing user via upsert", async () => {
    const company = makeCompany();
    const user = makeUser();
    mockPrisma.company.findFirst.mockResolvedValue(company);
    mockPrisma.user.upsert.mockResolvedValue(user);

    const result = await findOrCreateDefaultUser("user@test.com");

    expect(result.uuid).toBe(userUuid);
    expect(mockPrisma.user.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          companyUuid_oidcSub: {
            companyUuid,
            oidcSub: "default_user@test.com",
          },
        },
      })
    );
  });

  it("should upsert user with per-email oidcSub", async () => {
    const company = makeCompany();
    mockPrisma.company.findFirst.mockResolvedValue(company);
    mockPrisma.user.upsert.mockResolvedValue(makeUser());

    await findOrCreateDefaultUser("newuser@test.com");

    expect(mockPrisma.user.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          companyUuid_oidcSub: {
            companyUuid,
            oidcSub: "default_newuser@test.com",
          },
        },
        create: {
          email: "newuser@test.com",
          name: "newuser",
          oidcSub: "default_newuser@test.com",
          companyUuid,
        },
        update: {
          email: "newuser@test.com",
        },
      })
    );
  });

  it("should extract name from email in create", async () => {
    const company = makeCompany();
    mockPrisma.company.findFirst.mockResolvedValue(company);
    mockPrisma.user.upsert.mockResolvedValue(makeUser({ name: "john.doe" }));

    await findOrCreateDefaultUser("john.doe@test.com");

    expect(mockPrisma.user.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ name: "john.doe" }),
      })
    );
  });

  it("should handle lowercase domain conversion", async () => {
    const company = makeCompany();
    mockPrisma.company.findFirst.mockResolvedValue(company);
    mockPrisma.user.upsert.mockResolvedValue(makeUser());

    await findOrCreateDefaultUser("User@TEST.COM");

    expect(mockPrisma.company.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { emailDomains: { has: "test.com" } },
      })
    );
  });

  it("should be idempotent for repeated calls with same email", async () => {
    const company = makeCompany();
    const user = makeUser();
    mockPrisma.company.findFirst.mockResolvedValue(company);
    mockPrisma.user.upsert.mockResolvedValue(user);

    const [result1, result2] = await Promise.all([
      findOrCreateDefaultUser("user@test.com"),
      findOrCreateDefaultUser("user@test.com"),
    ]);

    expect(result1.uuid).toBe(result2.uuid);
    // Both calls use upsert with the same compound key — no constraint violation
    expect(mockPrisma.user.upsert).toHaveBeenCalledTimes(2);
    for (const call of mockPrisma.user.upsert.mock.calls) {
      expect(call[0].where).toEqual({
        companyUuid_oidcSub: {
          companyUuid,
          oidcSub: "default_user@test.com",
        },
      });
    }
  });

  it("should generate different oidcSub for different emails in same company", async () => {
    const company = makeCompany();
    mockPrisma.company.findFirst.mockResolvedValue(company);
    mockPrisma.user.upsert.mockResolvedValue(makeUser());

    await findOrCreateDefaultUser("alice@test.com");
    await findOrCreateDefaultUser("bob@test.com");

    const calls = mockPrisma.user.upsert.mock.calls;
    expect(calls[0][0].where.companyUuid_oidcSub.oidcSub).toBe("default_alice@test.com");
    expect(calls[1][0].where.companyUuid_oidcSub.oidcSub).toBe("default_bob@test.com");
  });
});

// ===== getUserByUuid =====
describe("getUserByUuid", () => {
  it("should return user with company info", async () => {
    const user = makeUser({
      company: {
        uuid: companyUuid,
        name: "Test Company",
        oidcIssuer: "https://auth.test.com",
        oidcClientId: "client123",
      },
    });
    mockPrisma.user.findUnique.mockResolvedValue(user);

    const result = await getUserByUuid(userUuid);

    expect(result).not.toBeNull();
    expect(result!.uuid).toBe(userUuid);
    expect(result!.company.name).toBe("Test Company");
    expect(result!.company.oidcIssuer).toBe("https://auth.test.com");
  });

  it("should return null when user not found", async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);

    const result = await getUserByUuid("nonexistent");
    expect(result).toBeNull();
  });

  it("should include oidc configuration", async () => {
    const user = makeUser();
    mockPrisma.user.findUnique.mockResolvedValue(user);

    await getUserByUuid(userUuid);

    expect(mockPrisma.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { uuid: userUuid },
        select: expect.objectContaining({
          company: expect.objectContaining({
            select: expect.objectContaining({
              oidcIssuer: true,
              oidcClientId: true,
            }),
          }),
        }),
      })
    );
  });
});

// ===== getCompanyByUuid =====
describe("getCompanyByUuid", () => {
  it("should return company with oidc config", async () => {
    const company = makeCompany();
    mockPrisma.company.findFirst.mockResolvedValue(company);

    const result = await getCompanyByUuid(companyUuid);

    expect(result).not.toBeNull();
    expect(result!.uuid).toBe(companyUuid);
    expect(result!.oidcEnabled).toBe(true);
    expect(result!.oidcIssuer).toBe("https://auth.test.com");
    expect(result!.oidcClientId).toBe("client123");
  });

  it("should return null when company not found", async () => {
    mockPrisma.company.findFirst.mockResolvedValue(null);

    const result = await getCompanyByUuid("nonexistent");
    expect(result).toBeNull();
  });

  it("should select required oidc fields", async () => {
    mockPrisma.company.findFirst.mockResolvedValue(makeCompany());

    await getCompanyByUuid(companyUuid);

    expect(mockPrisma.company.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { uuid: companyUuid },
        select: expect.objectContaining({
          oidcIssuer: true,
          oidcClientId: true,
          oidcEnabled: true,
        }),
      })
    );
  });
});
