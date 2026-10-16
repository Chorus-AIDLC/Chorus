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

const mockLocalMatches = vi.hoisted(() => vi.fn());
vi.mock('@/lib/prisma', () => ({ prisma: { user: { findMany: mockLocalMatches } } }));
import { resetAuthThrottleForTests } from '@/lib/auth-throttle';
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
  resetAuthThrottleForTests();
  mockLocalMatches.mockResolvedValue([]);
  mockIsSuperAdminEmail.mockReturnValue(false);
  mockIsDefaultAuthEnabled.mockReturnValue(false);
  mockGetDefaultUserEmail.mockReturnValue(null);
});

describe("POST /api/auth/identify local discovery", () => {
  it("normalizes username and returns only applicable company configuration", async () => {
    mockLocalMatches.mockResolvedValue([{ company: { uuid: 'local-a', name: 'Local A' } }]);
    const res = await POST(makeRequest({ identifier: ' ALICE ' }), emptyCtx);
    expect((await res.json()).data).toEqual({ type: 'local', company: { uuid: 'local-a', name: 'Local A' } });
    expect(mockLocalMatches).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ username: 'alice', authType: 'local', deletedAt: null, status: { not: 'deleted' }, company: { localAuthEnabled: true, oidcEnabled: false } }), select: { company: { select: { uuid: true, name: true } } } }));
    expect(mockGetCandidateCompaniesForEmail).not.toHaveBeenCalled();
  });
  it("deduplicates local matches and combines them with all existing email login paths", async () => {
    mockIsSuperAdminEmail.mockReturnValue(true);
    mockIsDefaultAuthEnabled.mockReturnValue(true);
    mockGetDefaultUserEmail.mockReturnValue('alice@example.com');
    mockGetCandidateCompaniesForEmail.mockResolvedValue([companyA]);
    mockLocalMatches.mockResolvedValue([{ company: { uuid: 'local-a', name: 'Local A' } }, { company: { uuid: 'local-a', name: 'Local A' } }, { company: { uuid: 'local-b', name: 'Local B' } }]);
    const res = await POST(makeRequest({ identifier: 'ALICE@EXAMPLE.COM' }), emptyCtx);
    const data = (await res.json()).data;
    expect(data.type).toBe('multi_role');
    expect(data.roles.map((r: { kind: string }) => r.kind)).toEqual(['super_admin', 'default_auth', 'oidc', 'local', 'local']);
    expect(mockLocalMatches).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ localEmail: 'alice@example.com' }), orderBy: { companyUuid: 'asc' } }));
    expect(JSON.stringify(data)).not.toMatch(/workspaceAdmin|sessionVersion|status|password|userUuid/);
  });
  it("uses multi_role for local-only multiple tenants", async () => {
    mockLocalMatches.mockResolvedValue([{ company: { uuid: 'a', name: 'A' } }, { company: { uuid: 'b', name: 'B' } }]);
    const res = await POST(makeRequest({ identifier: 'alice' }), emptyCtx);
    expect((await res.json()).data).toEqual({ type: 'multi_role', roles: [{ kind: 'local', company: { uuid: 'a', name: 'A' } }, { kind: 'local', company: { uuid: 'b', name: 'B' } }] });
  });
  it.each(['unknown', 'bad identifier', '', 'x'.repeat(255)])("returns generic unknown response for %s without exposing an all-workspace directory", async identifier => {
    const res = await POST(makeRequest({ identifier }), emptyCtx);
    expect((await res.json()).data.type).toBe('not_found');
    expect(mockGetCandidateCompaniesForEmail).not.toHaveBeenCalled();
  });
  it("throttles discovery at the route", async () => {
    for (let i = 0; i < 30; i++) expect((await POST(makeRequest({ identifier: 'unknown' }), emptyCtx)).status).toBe(200);
    expect((await POST(makeRequest({ identifier: 'unknown' }), emptyCtx)).status).toBe(429);
    expect(mockLocalMatches).toHaveBeenCalledTimes(30);
    expect((await POST(makeRequest({ identifier: 'other' }), emptyCtx)).status).toBe(200);
  });
});

describe("POST /api/auth/identify", () => {
  it.each(["oidc", "super_admin", "default_auth"])("unrelated default-mode discovery traffic cannot exhaust %s discovery", async kind => {
    for (let i = 0; i < 35; i++) expect((await POST(makeRequest({ identifier: `unknown-${i}` }), emptyCtx)).status).toBe(200);
    mockGetCandidateCompaniesForEmail.mockResolvedValue(kind === "oidc" ? [companyA] : []);
    mockIsSuperAdminEmail.mockReturnValue(kind === "super_admin");
    mockIsDefaultAuthEnabled.mockReturnValue(kind === "default_auth");
    mockGetDefaultUserEmail.mockReturnValue("legitimate@example.com");
    const res = await POST(makeRequest({ email: "legitimate@example.com" }), emptyCtx);
    expect(res.status).toBe(200);
    expect((await res.json()).data.type).toBe(kind);
  });
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
