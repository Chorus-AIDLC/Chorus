import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockGetCandidateCompaniesForEmail = vi.hoisted(() => vi.fn());
const mockIsSuperAdminEmail = vi.hoisted(() => vi.fn());
const mockIsDefaultAuthEnabled = vi.hoisted(() => vi.fn());
const mockGetDefaultUserEmail = vi.hoisted(() => vi.fn());

vi.mock("@/services/company.service", () => ({
  getCandidateCompaniesForEmail: mockGetCandidateCompaniesForEmail,
}));
vi.mock("@/lib/super-admin", () => ({
  isSuperAdminEmail: mockIsSuperAdminEmail,
}));
vi.mock("@/lib/default-auth", () => ({
  isDefaultAuthEnabled: mockIsDefaultAuthEnabled,
  getDefaultUserEmail: mockGetDefaultUserEmail,
}));

import { POST } from "@/app/api/auth/identify/route";

function makeRequest(body: unknown): NextRequest {
  return new NextRequest(new URL("http://localhost:3000/api/auth/identify"), {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const emptyCtx = { params: Promise.resolve({}) };

const companyA = {
  uuid: "company-aaaa-0000-0000-000000000001",
  name: "Acme Inc",
  oidcIssuer: "https://auth.acme.com",
  oidcClientId: "client-acme",
};
const companyB = {
  uuid: "company-bbbb-0000-0000-000000000002",
  name: "Beta Corp",
  oidcIssuer: "not-a-valid-url",
  oidcClientId: "client-beta",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockIsSuperAdminEmail.mockReturnValue(false);
  mockIsDefaultAuthEnabled.mockReturnValue(false);
  mockGetDefaultUserEmail.mockReturnValue(null);
});

describe("POST /api/auth/identify", () => {
  it("returns super_admin when the email is a Super Admin", async () => {
    mockIsSuperAdminEmail.mockReturnValue(true);

    const res = await POST(makeRequest({ email: "root@example.com" }), emptyCtx);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data).toEqual({ type: "super_admin" });
    expect(mockGetCandidateCompaniesForEmail).not.toHaveBeenCalled();
  });

  it("returns default_auth when default auth is enabled and the email matches", async () => {
    mockIsDefaultAuthEnabled.mockReturnValue(true);
    mockGetDefaultUserEmail.mockReturnValue("dev@example.com");

    const res = await POST(makeRequest({ email: "dev@example.com" }), emptyCtx);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data).toEqual({ type: "default_auth" });
    expect(mockGetCandidateCompaniesForEmail).not.toHaveBeenCalled();
  });

  it("returns not_found when there are zero candidate Companies", async () => {
    mockGetCandidateCompaniesForEmail.mockResolvedValue([]);

    const res = await POST(makeRequest({ email: "ghost@example.com" }), emptyCtx);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data.type).toBe("not_found");
    expect(typeof json.data.message).toBe("string");
    expect(mockGetCandidateCompaniesForEmail).toHaveBeenCalledWith(
      "ghost@example.com"
    );
  });

  it("returns oidc with full company payload on a single candidate match", async () => {
    mockGetCandidateCompaniesForEmail.mockResolvedValue([companyA]);

    const res = await POST(makeRequest({ email: "alice@acme.com" }), emptyCtx);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data).toEqual({
      type: "oidc",
      company: {
        uuid: companyA.uuid,
        name: companyA.name,
        oidcIssuer: companyA.oidcIssuer,
        oidcClientId: companyA.oidcClientId,
      },
    });
  });

  it("returns oidc_multi_match on 2+ candidates without leaking oidcClientId, using parseHost for issuer", async () => {
    mockGetCandidateCompaniesForEmail.mockResolvedValue([companyA, companyB]);

    const res = await POST(makeRequest({ email: "alice@shared.com" }), emptyCtx);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data.type).toBe("oidc_multi_match");
    expect(json.data.company).toBeUndefined();
    expect(json.data.candidates).toHaveLength(2);

    // companyA has a valid URL → parseHost returns the hostname
    expect(json.data.candidates[0]).toEqual({
      uuid: companyA.uuid,
      name: companyA.name,
      oidcIssuerHost: "auth.acme.com",
    });
    // companyB has a non-URL issuer → parseHost falls back to the raw string
    expect(json.data.candidates[1]).toEqual({
      uuid: companyB.uuid,
      name: companyB.name,
      oidcIssuerHost: "not-a-valid-url",
    });

    // No candidate leaks clientId
    for (const c of json.data.candidates) {
      expect(c.oidcClientId).toBeUndefined();
      expect(c.oidcIssuer).toBeUndefined();
    }
  });
});
