import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockGetCandidateCompaniesForEmail = vi.hoisted(() => vi.fn());
vi.mock("@/services/company.service", () => ({
  getCandidateCompaniesForEmail: mockGetCandidateCompaniesForEmail,
}));

import { GET } from "@/app/api/auth/company-oidc/route";

function makeRequest(params: { uuid?: string; email?: string }): NextRequest {
  const url = new URL("http://localhost:3000/api/auth/company-oidc");
  if (params.uuid !== undefined) url.searchParams.set("uuid", params.uuid);
  if (params.email !== undefined) url.searchParams.set("email", params.email);
  return new NextRequest(url);
}

const companyAUuid = "company-0000-0000-0000-00000000000a";
const companyBUuid = "company-0000-0000-0000-00000000000b";

const CANDIDATE_A = {
  uuid: companyAUuid,
  name: "Acme Inc",
  oidcIssuer: "https://auth.acme.com",
  oidcClientId: "client-a",
};
const CANDIDATE_B = {
  uuid: companyBUuid,
  name: "Beta Corp",
  oidcIssuer: "https://auth.beta.com",
  oidcClientId: "client-b",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/auth/company-oidc", () => {
  it("returns OIDC config when the uuid belongs to the email's candidates", async () => {
    mockGetCandidateCompaniesForEmail.mockResolvedValue([
      CANDIDATE_A,
      CANDIDATE_B,
    ]);

    const res = await GET(
      makeRequest({ uuid: companyAUuid, email: "alice@acme.com" }),
      { params: Promise.resolve({}) }
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data).toEqual({
      uuid: companyAUuid,
      name: "Acme Inc",
      oidcIssuer: "https://auth.acme.com",
      oidcClientId: "client-a",
    });
    // Do not leak other fields
    expect(json.data.emailDomains).toBeUndefined();
    expect(json.data.id).toBeUndefined();
    expect(json.data.oidcEnabled).toBeUndefined();
    expect(mockGetCandidateCompaniesForEmail).toHaveBeenCalledWith(
      "alice@acme.com"
    );
  });

  it("returns 400 validationError when email is missing", async () => {
    const res = await GET(makeRequest({ uuid: companyAUuid }), {
      params: Promise.resolve({}),
    });
    const json = await res.json();

    expect(res.status).toBe(422);
    expect(json.success).toBe(false);
    expect(json.error.code).toBe("VALIDATION_ERROR");
    expect(mockGetCandidateCompaniesForEmail).not.toHaveBeenCalled();
  });

  it("returns 400 validationError when uuid is missing", async () => {
    const res = await GET(makeRequest({ email: "alice@acme.com" }), {
      params: Promise.resolve({}),
    });
    const json = await res.json();

    expect(res.status).toBe(422);
    expect(json.success).toBe(false);
    expect(json.error.code).toBe("VALIDATION_ERROR");
    expect(mockGetCandidateCompaniesForEmail).not.toHaveBeenCalled();
  });

  it("returns 404 when the uuid is NOT in the email's candidate list", async () => {
    // email only resolves to Company A; asking for Company B's config must 404
    mockGetCandidateCompaniesForEmail.mockResolvedValue([CANDIDATE_A]);

    const res = await GET(
      makeRequest({ uuid: companyBUuid, email: "alice@acme.com" }),
      { params: Promise.resolve({}) }
    );
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.success).toBe(false);
    expect(json.error.code).toBe("NOT_FOUND");
  });

  it("returns 404 when the email has no candidates at all", async () => {
    mockGetCandidateCompaniesForEmail.mockResolvedValue([]);

    const res = await GET(
      makeRequest({ uuid: companyAUuid, email: "stranger@nowhere.com" }),
      { params: Promise.resolve({}) }
    );
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.success).toBe(false);
    expect(json.error.code).toBe("NOT_FOUND");
  });
});
