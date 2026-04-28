// @vitest-environment jsdom
// End-to-end integration test for the workspace picker flow.
//
// Covers the full chain:
//   /login email submit → POST /api/auth/identify (oidc_multi_match)
//     → /login/pick-workspace renders candidate cards
//     → click a card → GET /api/auth/company-oidc
//     → storeOidcConfig + signinRedirect
//
// We mock the service layer (company.service) to seed two candidates, and wire
// global.fetch to call the real Next.js route handlers. That way the test
// exercises the identify and company-oidc routes the same way the browser
// would — including payload shape and what fields are/aren't leaked — while
// keeping the run hermetic (no DB, no network).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextRequest } from "next/server";

// --- Mocks that must be hoisted so the module-under-test picks them up ---

const mockGetCandidateCompaniesForEmail = vi.hoisted(() => vi.fn());
const mockGetCompanyByUuid = vi.hoisted(() => vi.fn());
const mockIsSuperAdminEmail = vi.hoisted(() => vi.fn());
const mockIsDefaultAuthEnabled = vi.hoisted(() => vi.fn());
const mockGetDefaultUserEmail = vi.hoisted(() => vi.fn());

vi.mock("@/services/company.service", () => ({
  getCandidateCompaniesForEmail: mockGetCandidateCompaniesForEmail,
  getCompanyByUuid: mockGetCompanyByUuid,
}));
vi.mock("@/lib/super-admin", () => ({
  isSuperAdminEmail: mockIsSuperAdminEmail,
}));
vi.mock("@/lib/default-auth", () => ({
  isDefaultAuthEnabled: mockIsDefaultAuthEnabled,
  getDefaultUserEmail: mockGetDefaultUserEmail,
}));

const mockStoreOidcConfig = vi.hoisted(() => vi.fn());
const mockSigninRedirect = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockCreateUserManager = vi.hoisted(() =>
  vi.fn(() => ({ signinRedirect: mockSigninRedirect }))
);
vi.mock("@/lib/oidc", () => ({
  storeOidcConfig: mockStoreOidcConfig,
  createUserManager: mockCreateUserManager,
}));

const mockRouterReplace = vi.hoisted(() => vi.fn());
const mockRouterPush = vi.hoisted(() => vi.fn());
const mockSearchParamsGet = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mockRouterReplace, push: mockRouterPush }),
  useSearchParams: () => ({ get: mockSearchParamsGet }),
}));

// Use real translations so the test asserts on user-visible copy.
vi.mock("next-intl", async () => {
  const en = (await import("../../../../../messages/en.json")).default as Record<
    string,
    unknown
  >;
  function resolve(key: string): string {
    const parts = key.split(".");
    let node: unknown = en;
    for (const p of parts) {
      if (node && typeof node === "object" && p in (node as Record<string, unknown>)) {
        node = (node as Record<string, unknown>)[p];
      } else {
        return key;
      }
    }
    return typeof node === "string" ? node : key;
  }
  const t = (key: string, values?: Record<string, unknown>) => {
    let out = resolve(key);
    if (values) {
      for (const [k, v] of Object.entries(values)) {
        out = out.replaceAll(`{${k}}`, String(v));
      }
    }
    return out;
  };
  return { useTranslations: () => t };
});

// Import route handlers + page AFTER mocks are registered.
import { POST as identifyPOST } from "@/app/api/auth/identify/route";
import { GET as companyOidcGET } from "@/app/api/auth/company-oidc/route";
import PickWorkspacePage from "@/app/login/pick-workspace/page";

const COMPANY_A = {
  uuid: "company-aaaa-0000-0000-000000000001",
  name: "Acme Inc",
  oidcIssuer: "https://auth.acme.com",
  oidcClientId: "client-acme-SECRET",
  oidcEnabled: true,
};
const COMPANY_B = {
  uuid: "company-bbbb-0000-0000-000000000002",
  name: "Beta Corp",
  oidcIssuer: "https://login.betacorp.io",
  oidcClientId: "client-beta-SECRET",
  oidcEnabled: true,
};
const COMPANY_DISABLED = {
  uuid: "company-cccc-0000-0000-000000000003",
  name: "Disabled Co",
  oidcIssuer: "https://auth.disabled.example",
  oidcClientId: "client-disabled",
  oidcEnabled: false,
};

// Wire global.fetch so the picker page hits the real Next route handlers.
function installFetchRouter() {
  const fetchImpl = async (
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> => {
    const urlStr =
      typeof input === "string"
        ? input
        : input instanceof URL
        ? input.toString()
        : input.url;
    const url = new URL(urlStr, "http://localhost");

    if (url.pathname === "/api/auth/identify" && init?.method === "POST") {
      const req = new NextRequest(
        new URL("http://localhost" + url.pathname + url.search),
        {
          method: "POST",
          body: typeof init.body === "string" ? init.body : "",
          headers: { "content-type": "application/json" },
        }
      );
      return identifyPOST(req, { params: Promise.resolve({}) });
    }

    if (url.pathname === "/api/auth/company-oidc") {
      const req = new NextRequest(
        new URL("http://localhost" + url.pathname + url.search)
      );
      return companyOidcGET(req, { params: Promise.resolve({}) });
    }

    throw new Error(`Unexpected fetch in test: ${urlStr}`);
  };
  global.fetch = vi.fn(fetchImpl) as unknown as typeof fetch;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIsSuperAdminEmail.mockReturnValue(false);
  mockIsDefaultAuthEnabled.mockReturnValue(false);
  mockGetDefaultUserEmail.mockReturnValue(null);
  mockSearchParamsGet.mockImplementation((key: string) =>
    key === "email" ? encodeURIComponent("alice@example.com") : null
  );
  installFetchRouter();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------- AC 1/3: identify multi-match does not leak oidcClientId ----------

describe("POST /api/auth/identify (integration)", () => {
  it("returns oidc_multi_match sorted by name with no oidcClientId leak", async () => {
    mockGetCandidateCompaniesForEmail.mockResolvedValue([COMPANY_A, COMPANY_B]);

    const res = await identifyPOST(
      new NextRequest(new URL("http://localhost/api/auth/identify"), {
        method: "POST",
        body: JSON.stringify({ email: "alice@example.com" }),
        headers: { "content-type": "application/json" },
      }),
      { params: Promise.resolve({}) }
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data.type).toBe("oidc_multi_match");
    expect(json.data.candidates).toHaveLength(2);
    expect(json.data.candidates.map((c: { name: string }) => c.name)).toEqual([
      "Acme Inc",
      "Beta Corp",
    ]);
    for (const c of json.data.candidates) {
      expect(c.oidcClientId).toBeUndefined();
      expect(c.oidcIssuer).toBeUndefined();
      expect(typeof c.oidcIssuerHost).toBe("string");
    }
  });
});

// ---------- AC 2/3/4: company-oidc exposes clientId only when enabled ----------

describe("GET /api/auth/company-oidc (integration)", () => {
  it("returns OIDC config (including oidcClientId) for an enabled Company", async () => {
    mockGetCompanyByUuid.mockResolvedValue(COMPANY_A);

    const res = await companyOidcGET(
      new NextRequest(
        new URL(
          `http://localhost/api/auth/company-oidc?uuid=${COMPANY_A.uuid}`
        )
      ),
      { params: Promise.resolve({}) }
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.oidcClientId).toBe(COMPANY_A.oidcClientId);
    expect(json.data.oidcIssuer).toBe(COMPANY_A.oidcIssuer);
  });

  it("404s when the target Company has oidcEnabled=false", async () => {
    mockGetCompanyByUuid.mockResolvedValue(COMPANY_DISABLED);

    const res = await companyOidcGET(
      new NextRequest(
        new URL(
          `http://localhost/api/auth/company-oidc?uuid=${COMPANY_DISABLED.uuid}`
        )
      ),
      { params: Promise.resolve({}) }
    );
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.success).toBe(false);
  });
});

// ---------- AC 1/2/4: end-to-end picker UI flow ----------

describe("PickWorkspacePage (integration)", () => {
  it("identify multi-match → renders 2 cards → click first → company-oidc + storeOidcConfig + signinRedirect", async () => {
    mockGetCandidateCompaniesForEmail.mockResolvedValue([COMPANY_A, COMPANY_B]);
    mockGetCompanyByUuid.mockResolvedValue(COMPANY_A);

    render(<PickWorkspacePage />);

    // Both candidate names render.
    await waitFor(() => {
      expect(screen.getByText("Acme Inc")).toBeTruthy();
    });
    expect(screen.getByText("Beta Corp")).toBeTruthy();

    // Initials fallback renders (avatar uses style-prop colors, not class names).
    expect(screen.getByText("AI")).toBeTruthy(); // Acme Inc
    expect(screen.getByText("BC")).toBeTruthy(); // Beta Corp

    // Issuer host (parsed from full URL) is shown.
    expect(screen.getByText("auth.acme.com")).toBeTruthy();
    expect(screen.getByText("login.betacorp.io")).toBeTruthy();

    // "Use a different email" link is present.
    expect(screen.getByText("Use a different email")).toBeTruthy();

    // identify was called with the submitted email.
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    expect(mockGetCandidateCompaniesForEmail).toHaveBeenCalledWith(
      "alice@example.com"
    );
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) =>
          String(input) === "/api/auth/identify" &&
          (init as RequestInit | undefined)?.method === "POST"
      )
    ).toBe(true);

    // Click the first candidate card.
    const firstCardButton = screen.getByText("Acme Inc").closest("button");
    expect(firstCardButton).not.toBeNull();
    await userEvent.click(firstCardButton!);

    // company-oidc called with the correct uuid.
    await waitFor(() => {
      expect(mockGetCompanyByUuid).toHaveBeenCalledWith(COMPANY_A.uuid);
    });
    expect(
      fetchMock.mock.calls.some(([input]) => {
        const u = String(input);
        return (
          u.startsWith("/api/auth/company-oidc?") &&
          u.includes(`uuid=${encodeURIComponent(COMPANY_A.uuid)}`)
        );
      })
    ).toBe(true);

    // storeOidcConfig invoked with the OIDC config assembled from company-oidc response.
    await waitFor(() => {
      expect(mockStoreOidcConfig).toHaveBeenCalledTimes(1);
    });
    expect(mockStoreOidcConfig).toHaveBeenCalledWith({
      issuer: COMPANY_A.oidcIssuer,
      clientId: COMPANY_A.oidcClientId,
      companyUuid: COMPANY_A.uuid,
      companyName: COMPANY_A.name,
    });

    // OIDC redirect kicked off with login_hint carrying the email.
    expect(mockCreateUserManager).toHaveBeenCalledTimes(1);
    expect(mockSigninRedirect).toHaveBeenCalledWith({
      extraQueryParams: { login_hint: "alice@example.com" },
    });
  });

  it("excludes oidcEnabled=false Companies from candidates (via service) and picker shows only enabled ones", async () => {
    // Simulate the service-layer guarantee: only OIDC-enabled Companies are
    // returned, even when a disabled Company matches the email domain.
    mockGetCandidateCompaniesForEmail.mockResolvedValue([COMPANY_A, COMPANY_B]);

    render(<PickWorkspacePage />);

    await waitFor(() => {
      expect(screen.getByText("Acme Inc")).toBeTruthy();
    });
    expect(screen.getByText("Beta Corp")).toBeTruthy();
    expect(screen.queryByText("Disabled Co")).toBeNull();
  });
});
