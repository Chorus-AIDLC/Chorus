import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockPrisma = vi.hoisted(() => ({
  user: { findFirst: vi.fn() },
}));
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));

import { GET } from "@/app/api/auth/me/route";

const companyUuid = "company-0000-0000-0000-000000000001";
const userUuid = "user-0000-0000-0000-000000000001";

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString(
    "base64url"
  );
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.fakesig`;
}

function makeRequest(token: string): NextRequest {
  return new NextRequest(new URL("http://localhost:3000/api/auth/me"), {
    headers: { authorization: `Bearer ${token}` },
  });
}

const mockUser = {
  uuid: userUuid,
  email: "user@test.com",
  name: "Test User",
  companyUuid,
  company: { uuid: companyUuid, name: "Test Company" },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/auth/me", () => {
  it("should find user by userUuid when present in token", async () => {
    mockPrisma.user.findFirst.mockResolvedValue(mockUser);

    const res = await GET(makeRequest(makeJwt({ userUuid, companyUuid })));
    const json = await res.json();

    expect(json.success).toBe(true);
    expect(json.data.user.uuid).toBe(userUuid);
    expect(mockPrisma.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { uuid: userUuid },
      })
    );
  });

  it("should fallback to oidcSub+companyUuid when no userUuid", async () => {
    mockPrisma.user.findFirst.mockResolvedValue(mockUser);

    const res = await GET(
      makeRequest(
        makeJwt({ oidcSub: "oidc-sub-123", companyUuid })
      )
    );
    const json = await res.json();

    expect(json.success).toBe(true);
    expect(mockPrisma.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { oidcSub: "oidc-sub-123", companyUuid },
      })
    );
  });

  it("should use sub field as oidcSub fallback (raw OIDC token)", async () => {
    mockPrisma.user.findFirst.mockResolvedValue(mockUser);

    const res = await GET(
      makeRequest(makeJwt({ sub: "raw-oidc-sub", companyUuid }))
    );
    const json = await res.json();

    expect(json.success).toBe(true);
    expect(mockPrisma.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { oidcSub: "raw-oidc-sub", companyUuid },
      })
    );
  });

  it("should query without companyUuid when not in token", async () => {
    mockPrisma.user.findFirst.mockResolvedValue(mockUser);

    const res = await GET(
      makeRequest(makeJwt({ oidcSub: "oidc-sub-123" }))
    );
    const json = await res.json();

    expect(json.success).toBe(true);
    expect(mockPrisma.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { oidcSub: "oidc-sub-123" },
      })
    );
  });

  it("should return 401 when no authorization header", async () => {
    const req = new NextRequest(
      new URL("http://localhost:3000/api/auth/me")
    );
    const res = await GET(req);
    const json = await res.json();

    expect(json.success).toBe(false);
    expect(res.status).toBe(401);
  });

  it("should return 401 when token has no user identifier", async () => {
    const res = await GET(makeRequest(makeJwt({ companyUuid })));
    const json = await res.json();

    expect(json.success).toBe(false);
    expect(res.status).toBe(401);
  });

  it("should return 401 when user not found in DB", async () => {
    mockPrisma.user.findFirst.mockResolvedValue(null);

    const res = await GET(makeRequest(makeJwt({ userUuid })));
    const json = await res.json();

    expect(json.success).toBe(false);
    expect(res.status).toBe(401);
  });
});
