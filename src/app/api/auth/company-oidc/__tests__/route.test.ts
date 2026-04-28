import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockGetCompanyByUuid = vi.hoisted(() => vi.fn());
vi.mock("@/services/company.service", () => ({
  getCompanyByUuid: mockGetCompanyByUuid,
}));

import { GET } from "@/app/api/auth/company-oidc/route";

function makeRequest(uuid?: string): NextRequest {
  const url = new URL("http://localhost:3000/api/auth/company-oidc");
  if (uuid !== undefined) {
    url.searchParams.set("uuid", uuid);
  }
  return new NextRequest(url);
}

const companyUuid = "company-0000-0000-0000-000000000001";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/auth/company-oidc", () => {
  it("returns OIDC config for a valid, oidcEnabled Company", async () => {
    mockGetCompanyByUuid.mockResolvedValue({
      id: 1,
      uuid: companyUuid,
      name: "Acme Inc",
      emailDomains: ["acme.com"],
      oidcIssuer: "https://auth.acme.com",
      oidcClientId: "client-abc",
      oidcEnabled: true,
    });

    const res = await GET(makeRequest(companyUuid), {
      params: Promise.resolve({}),
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data).toEqual({
      uuid: companyUuid,
      name: "Acme Inc",
      oidcIssuer: "https://auth.acme.com",
      oidcClientId: "client-abc",
    });
    // Do not leak emailDomains or other fields
    expect(json.data.emailDomains).toBeUndefined();
    expect(json.data.id).toBeUndefined();
    expect(json.data.oidcEnabled).toBeUndefined();
  });

  it("returns 404 when the Company does not exist", async () => {
    mockGetCompanyByUuid.mockResolvedValue(null);

    const res = await GET(makeRequest("does-not-exist"), {
      params: Promise.resolve({}),
    });
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.success).toBe(false);
    expect(json.error.code).toBe("NOT_FOUND");
  });

  it("returns 404 when the Company has oidcEnabled=false", async () => {
    mockGetCompanyByUuid.mockResolvedValue({
      id: 1,
      uuid: companyUuid,
      name: "Acme Inc",
      emailDomains: ["acme.com"],
      oidcIssuer: "https://auth.acme.com",
      oidcClientId: "client-abc",
      oidcEnabled: false,
    });

    const res = await GET(makeRequest(companyUuid), {
      params: Promise.resolve({}),
    });
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.success).toBe(false);
    expect(json.error.code).toBe("NOT_FOUND");
  });
});
