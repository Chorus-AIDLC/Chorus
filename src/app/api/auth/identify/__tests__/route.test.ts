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
    mockGetCandidateCompaniesForEmail.mockResolvedValue([]);

    const res = await POST(makeRequest({ email: "root@example.com" }), emptyCtx);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data).toEqual({ type: "super_admin" });
  });

  it("returns default_auth when default auth is enabled and the email matches", async () => {
    mockIsDefaultAuthEnabled.mockReturnValue(true);
    mockGetDefaultUserEmail.mockReturnValue("dev@example.com");
    mockGetCandidateCompaniesForEmail.mockResolvedValue([]);

    const res = await POST(makeRequest({ email: "dev@example.com" }), emptyCtx);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data).toEqual({ type: "default_auth" });
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

  it("returns multi_role when super_admin and default_auth resolve for the same email, with no secrets", async () => {
    mockIsSuperAdminEmail.mockReturnValue(true);
    mockIsDefaultAuthEnabled.mockReturnValue(true);
    mockGetDefaultUserEmail.mockReturnValue("root@example.com");
    mockGetCandidateCompaniesForEmail.mockResolvedValue([]);

    const res = await POST(makeRequest({ email: "root@example.com" }), emptyCtx);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data.type).toBe("multi_role");
    // Stable order: super_admin first, then default_auth.
    expect(json.data.roles).toEqual([
      { kind: "super_admin" },
      { kind: "default_auth" },
    ]);
    // Neither non-oidc role carries any company / secret material.
    for (const r of json.data.roles) {
      expect(r.company).toBeUndefined();
    }
  });

  it("returns multi_role when super_admin coexists with a single oidc company, carrying the full company payload", async () => {
    mockIsSuperAdminEmail.mockReturnValue(true);
    mockGetCandidateCompaniesForEmail.mockResolvedValue([companyA]);

    const res = await POST(makeRequest({ email: "root@acme.com" }), emptyCtx);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data.type).toBe("multi_role");
    // super_admin first (no secret), then the oidc entry with full payload.
    expect(json.data.roles).toEqual([
      { kind: "super_admin" },
      {
        kind: "oidc",
        company: {
          uuid: companyA.uuid,
          name: companyA.name,
          oidcIssuer: companyA.oidcIssuer,
          oidcClientId: companyA.oidcClientId,
        },
      },
    ]);
    expect(json.data.roles[0].company).toBeUndefined();
  });

  it("returns multi_role when default_auth coexists with multiple oidc companies, one entry per company in order", async () => {
    mockIsDefaultAuthEnabled.mockReturnValue(true);
    mockGetDefaultUserEmail.mockReturnValue("shared@example.com");
    mockGetCandidateCompaniesForEmail.mockResolvedValue([companyA, companyB]);

    const res = await POST(
      makeRequest({ email: "shared@example.com" }),
      emptyCtx
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data.type).toBe("multi_role");
    expect(json.data.roles).toEqual([
      { kind: "default_auth" },
      {
        kind: "oidc",
        company: {
          uuid: companyA.uuid,
          name: companyA.name,
          oidcIssuer: companyA.oidcIssuer,
          oidcClientId: companyA.oidcClientId,
        },
      },
      {
        kind: "oidc",
        company: {
          uuid: companyB.uuid,
          name: companyB.name,
          oidcIssuer: companyB.oidcIssuer,
          oidcClientId: companyB.oidcClientId,
        },
      },
    ]);
  });

  it("returns multi_role with all three kinds when super_admin, default_auth, and one oidc company all match", async () => {
    mockIsSuperAdminEmail.mockReturnValue(true);
    mockIsDefaultAuthEnabled.mockReturnValue(true);
    mockGetDefaultUserEmail.mockReturnValue("root@acme.com");
    mockGetCandidateCompaniesForEmail.mockResolvedValue([companyA]);

    const res = await POST(makeRequest({ email: "root@acme.com" }), emptyCtx);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data.type).toBe("multi_role");
    expect(json.data.roles.map((r: { kind: string }) => r.kind)).toEqual([
      "super_admin",
      "default_auth",
      "oidc",
    ]);
  });

  it("rejects a missing email with a validation error", async () => {
    const res = await POST(makeRequest({}), emptyCtx);
    const json = await res.json();

    expect(res.status).toBe(422);
    expect(json.success).toBe(false);
    expect(mockGetCandidateCompaniesForEmail).not.toHaveBeenCalled();
  });

  it("rejects a malformed email with a validation error", async () => {
    const res = await POST(makeRequest({ email: "not-an-email" }), emptyCtx);
    const json = await res.json();

    expect(res.status).toBe(422);
    expect(json.success).toBe(false);
    expect(mockGetCandidateCompaniesForEmail).not.toHaveBeenCalled();
  });
});
