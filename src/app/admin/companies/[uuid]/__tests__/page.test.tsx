// @vitest-environment jsdom
import { Suspense } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextRequest } from "next/server";
import type { ApiHandler } from "@/lib/api-handler";

const { mockPrisma, translate } = vi.hoisted(() => ({
  translate: (key: string) => key,
  mockPrisma: {
    company: { findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    $transaction: vi.fn(),
    $queryRaw: vi.fn(),
  },
}));
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
// Authentication is a fixture; the production GET/PATCH, parser, error handler
// and company service all run unchanged. Only persistence is in-memory.
vi.mock("@/lib/auth", () => ({ requireSuperAdmin: (handler: ApiHandler<{ uuid: string }>) => handler }));
vi.mock("@/hooks/use-progress-router", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}));
vi.mock("next-intl", () => ({ useTranslations: () => translate, useLocale: () => "en" }));

import CompanyDetailPage from "../page";
import { GET, PATCH } from "@/app/api/admin/companies/[uuid]/route";

const uuid = "company-detail-fixture";
const context = { params: Promise.resolve({ uuid }) };
function makeCompany(localAuthEnabled = true) {
  return {
    id: 1, uuid, name: "Original workspace", localAuthEnabled,
    emailDomains: localAuthEnabled ? [] : ["example.com"],
    oidcIssuer: localAuthEnabled ? null : "https://id.example.com",
    oidcClientId: localAuthEnabled ? null : "original-client",
    oidcEnabled: !localAuthEnabled,
    createdAt: new Date("2026-10-15T00:00:00Z"),
    updatedAt: new Date("2026-10-15T00:00:00Z"),
    _count: { users: 1, agents: 0, projects: 0 },
  };
}
let company = makeCompany();
const patchResults: number[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  company = makeCompany();
  patchResults.length = 0;
  mockPrisma.company.findFirst.mockImplementation(async () => company);
  mockPrisma.company.findUnique.mockImplementation(async () => company);
  mockPrisma.company.update.mockImplementation(async ({ data }) => {
    company = { ...company, ...data };
    return company;
  });
  mockPrisma.$transaction.mockImplementation(async (callback) => callback(mockPrisma));
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url === `/api/admin/companies/${uuid}/initial-admin`) {
      return new Response(JSON.stringify({ success: true, data: { user: null, manageable: true } }));
    }
    const request = new NextRequest(`http://localhost${url}`, {
      method: init?.method, headers: init?.headers, body: init?.body,
    });
    const response = await (init?.method === "PATCH" ? PATCH : GET)(request, context);
    if (init?.method === "PATCH") patchResults.push(response.status);
    return response;
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function openEditor() {
  await act(async () => {
    render(<Suspense fallback={<div>Loading params</div>}><CompanyDetailPage params={context.params} /></Suspense>);
    await context.params;
  });
  await screen.findByLabelText("admin.companyName");
  return userEvent.setup();
}
function patchBody() {
  const call = vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === "PATCH");
  return JSON.parse(call![1]!.body as string);
}

describe("Company detail UI → API → service", () => {
  it("mounts the real initial-admin card only for local detail and loads its scoped invitation", async () => {
    const user = await openEditor();
    expect(await screen.findByText("noInvitation")).toBeTruthy();
    expect(screen.getByText("title")).toBeTruthy();
    expect(fetch).toHaveBeenCalledWith(`/api/admin/companies/${uuid}/initial-admin`, { cache: "no-store" });
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => url === `/api/admin/companies/${uuid}/initial-admin`)).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "invite" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.querySelector("#replacement-username")).toBeTruthy();
    expect(dialog.querySelector("#replacement-email")).toBeTruthy();
    expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
    await user.click(screen.getByRole("button", { name: "cancel" }));
    expect(screen.getByLabelText("admin.companyName")).toBeTruthy();
  });

  it("does not mount or fetch the initial-admin card on OIDC detail", async () => {
    company = makeCompany(false);
    await openEditor();
    expect(screen.queryByText("noInvitation")).toBeNull();
    expect(screen.queryByText("title")).toBeNull();
    expect(screen.queryByRole("button", { name: "invite" })).toBeNull();
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith("/initial-admin"))).toBe(false);
    expect(screen.getByLabelText("admin.oidcIssuerUrl")).toBeTruthy();
  });

  it("hides domain and OIDC configuration on local workspaces", async () => {
    await openEditor();
    expect(screen.queryByLabelText("admin.emailDomains")).toBeNull();
    expect(screen.queryByLabelText("admin.oidcIssuerUrl")).toBeNull();
    expect(screen.queryByLabelText("admin.clientId")).toBeNull();
    expect(screen.queryByText("admin.oidcConfig")).toBeNull();
    expect(screen.queryByText("admin.oidcNotConfigured")).toBeNull();
  });

  it("renames a local workspace with a name-only payload and refreshes persisted detail", async () => {
    const user = await openEditor();
    await user.clear(screen.getByLabelText("admin.companyName"));
    await user.type(screen.getByLabelText("admin.companyName"), " Renamed local workspace ");
    await user.click(screen.getByRole("button", { name: "admin.saveChanges" }));
    await waitFor(() => expect(patchResults).toEqual([200]));
    expect(patchBody()).toEqual({ name: "Renamed local workspace" });
    expect(await screen.findByText("admin.companyUpdated")).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "Renamed local workspace" })).toBeTruthy();
    expect(company.localAuthEnabled).toBe(true);
    expect(company.emailDomains).toEqual([]);
    expect(company.oidcEnabled).toBe(false);
    expect(mockPrisma.company.update).toHaveBeenCalledWith(expect.objectContaining({ data: { name: "Renamed local workspace" } }));
  });

  it("preserves existing OIDC controls, payload and successful persistence", async () => {
    company = makeCompany(false);
    const user = await openEditor();
    await user.clear(screen.getByLabelText("admin.companyName"));
    await user.type(screen.getByLabelText("admin.companyName"), "Renamed OIDC workspace");
    await user.clear(screen.getByLabelText("admin.emailDomains"));
    await user.type(screen.getByLabelText("admin.emailDomains"), " EXAMPLE.COM, new.example.com ");
    await user.clear(screen.getByLabelText("admin.oidcIssuerUrl"));
    await user.type(screen.getByLabelText("admin.oidcIssuerUrl"), "https://new-id.example.com");
    await user.clear(screen.getByLabelText("admin.clientId"));
    await user.type(screen.getByLabelText("admin.clientId"), " new-client ");
    await user.click(screen.getByRole("button", { name: "admin.saveChanges" }));
    await waitFor(() => expect(patchResults).toEqual([200]));
    expect(patchBody()).toEqual({ name: "Renamed OIDC workspace", emailDomains: ["EXAMPLE.COM", "new.example.com"], oidcIssuer: "https://new-id.example.com", oidcClientId: "new-client", oidcEnabled: true });
    expect(await screen.findByRole("heading", { name: "Renamed OIDC workspace" })).toBeTruthy();
    expect(company.emailDomains).toEqual(["example.com", "new.example.com"]);
    expect(company.localAuthEnabled).toBe(false);
    expect(company.oidcClientId).toBe("new-client");
  });

  it.each([
    { localAuthEnabled: false },
    { oidcEnabled: true, oidcIssuer: "https://attacker.example", oidcClientId: "attacker", emailDomains: ["attacker.example"] },
    // This is the exact pre-fix editor payload, not just an enabled conversion.
    { name: "Renamed", emailDomains: [], oidcIssuer: null, oidcClientId: null, oidcEnabled: false },
  ])("rejects injected local authentication fields without persistence: %j", async (payload) => {
    const response = await PATCH(new NextRequest(`http://localhost/api/admin/companies/${uuid}`, { method: "PATCH", body: JSON.stringify(payload), headers: { "Content-Type": "application/json" } }), context);
    expect(response.status).toBe(400);
    expect((await response.json()).success).toBe(false);
    expect(mockPrisma.company.update).not.toHaveBeenCalled();
    expect(company).toEqual(makeCompany());
  });
});
