// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("@/hooks/use-progress-router", () => ({ useRouter: () => ({ push }) }));
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}));
// New translation keys are supplied to the parent separately; assert semantic
// interactions against stable keys without depending on its concurrent JSON edit.
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, string>) =>
    values ? `${key} ${Object.values(values).join(" ")}` : key,
}));

import NewCompanyPage from "../page";

const link = "https://chorus.example/login/local/accept?token=opaque-fixture";
const expiresAt = "2026-10-16T04:00:00.000Z";
const bootstrapData = {
  company: { uuid: "company-uuid", name: "Local workspace", localAuthEnabled: true, oidcEnabled: false },
  user: { uuid: "user-uuid", username: "first-admin", email: "first@example.com" },
  credentialLink: { url: link, expiresAt, purpose: "invite" },
};

function mockResponse(body: unknown, ok = true) {
  vi.mocked(fetch).mockResolvedValue({ ok, json: async () => body } as Response);
}

async function fillLocal(withName = true) {
  const user = userEvent.setup();
  await user.click(screen.getByRole("radio", { name: "admin.localBootstrap.localMode" }));
  await user.type(screen.getByLabelText("admin.companyName"), "Local workspace");
  await user.type(screen.getByLabelText("admin.localBootstrap.username"), "first-admin");
  await user.type(screen.getByLabelText("admin.localBootstrap.email"), "first@example.com");
  if (withName) await user.type(screen.getByLabelText("admin.localBootstrap.name"), " First Admin ");
  return user;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn());
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("NewCompanyPage local bootstrap", () => {
  it("posts local fields and retains the copy/share link and expiry until explicit navigation", async () => {
    mockResponse({ success: true, data: bootstrapData });
    render(<NewCompanyPage />);
    const user = await fillLocal();
    expect(screen.queryByLabelText("admin.emailDomain")).toBeNull();
    expect(screen.queryByLabelText("admin.oidcIssuerUrl")).toBeNull();
    await user.click(screen.getByRole("button", { name: "admin.createCompany" }));
    await screen.findByLabelText("admin.localBootstrap.invitationLink");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("/api/admin/companies/local", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Local workspace", initialAdmin: { username: "first-admin", email: "first@example.com", name: "First Admin" } }),
    });
    expect((screen.getByLabelText("admin.localBootstrap.invitationLink") as HTMLInputElement).value).toBe(link);
    expect(screen.getByText(`admin.localBootstrap.expiresAt ${expiresAt}`)).toBeTruthy();
    expect(screen.getByText("admin.localBootstrap.shareHelp")).toBeTruthy();
    expect(push).not.toHaveBeenCalled();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    await user.click(screen.getByRole("button", { name: "admin.localBootstrap.copyLink" }));
    expect(writeText).toHaveBeenCalledWith(link);
    expect(await screen.findByRole("status")).toBeTruthy();
    expect(push).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "admin.localBootstrap.continue" }));
    expect(push).toHaveBeenCalledWith("/admin/companies/company-uuid");
  });

  it.each(["", "   "])("rejects a missing or whitespace-only required administrator name: %j", async (name) => {
    mockResponse({ success: true, data: bootstrapData });
    render(<NewCompanyPage />);
    const user = await fillLocal(false);
    const nameInput = screen.getByLabelText("admin.localBootstrap.name") as HTMLInputElement;
    expect(nameInput.required).toBe(true);
    fireEvent.change(nameInput, { target: { value: name } });
    const create = screen.getByRole("button", { name: "admin.createCompany" }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    await user.click(create);
    // Guard programmatic/Enter submissions as well as the disabled button.
    fireEvent.submit(create.closest("form")!);
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("admin.localBootstrap.invitationLink")).toBeNull();
    expect(push).not.toHaveBeenCalled();
    await user.type(nameInput, "First Admin");
    expect(create.disabled).toBe(false);
    await user.click(create);
    await screen.findByLabelText("admin.localBootstrap.invitationLink");
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
    expect(body.initialAdmin.name).toBe("First Admin");
  });

  it.each([
    [{ success: false, error: "Identity already exists" }, false, "Identity already exists"],
    [{ success: false, error: { message: "Invalid username" } }, false, "Invalid username"],
    [{ success: true, data: bootstrapData }, false, "admin.createCompanyFailed"],
  ])("shows API rejection without losing form input or navigating", async (body, ok, message) => {
    mockResponse(body, ok);
    render(<NewCompanyPage />);
    const user = await fillLocal();
    await user.click(screen.getByRole("button", { name: "admin.createCompany" }));
    expect((await screen.findByRole("alert")).textContent).toBe(message);
    expect((screen.getByLabelText("admin.localBootstrap.username") as HTMLInputElement).value).toBe("first-admin");
    expect(screen.queryByLabelText("admin.localBootstrap.invitationLink")).toBeNull();
    expect(push).not.toHaveBeenCalled();
    mockResponse({ success: true, data: bootstrapData });
    await user.click(screen.getByRole("button", { name: "admin.createCompany" }));
    expect(await screen.findByLabelText("admin.localBootstrap.invitationLink")).toBeTruthy();
  });

  it("shows a localized network error and permits retry", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("offline"));
    render(<NewCompanyPage />);
    const user = await fillLocal();
    await user.click(screen.getByRole("button", { name: "admin.createCompany" }));
    expect((await screen.findByRole("alert")).textContent).toBe("admin.networkError");
    expect((screen.getByRole("button", { name: "admin.createCompany" }) as HTMLButtonElement).disabled).toBe(false);
    expect(push).not.toHaveBeenCalled();
  });

  it("keeps the link available when clipboard copying fails", async () => {
    mockResponse({ success: true, data: bootstrapData });
    render(<NewCompanyPage />);
    const user = await fillLocal();
    await user.click(screen.getByRole("button", { name: "admin.createCompany" }));
    await screen.findByLabelText("admin.localBootstrap.invitationLink");
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("denied"));
    await user.click(screen.getByRole("button", { name: "admin.localBootstrap.copyLink" }));
    expect((await screen.findByRole("alert")).textContent).toBe("admin.localBootstrap.copyFailed");
    expect((screen.getByLabelText("admin.localBootstrap.invitationLink") as HTMLInputElement).value).toBe(link);
    expect(screen.queryByRole("status")).toBeNull();
    expect(push).not.toHaveBeenCalled();
  });

  it("blocks IME Enter submission and invalid @ usernames", async () => {
    render(<NewCompanyPage />);
    await fillLocal();
    const username = screen.getByLabelText("admin.localBootstrap.username");
    const composingEnter = new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true });
    fireEvent(username, composingEnter);
    expect(composingEnter.defaultPrevented).toBe(true);
    const ime229 = new KeyboardEvent("keydown", { key: "Enter", keyCode: 229, bubbles: true, cancelable: true });
    fireEvent(username, ime229);
    expect(ime229.defaultPrevented).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.change(username, { target: { value: "not@username" } });
    expect((screen.getByRole("button", { name: "admin.createCompany" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("disables the form and mode picker during bootstrap", async () => {
    let resolve!: (value: Response) => void;
    vi.mocked(fetch).mockReturnValue(new Promise((done) => { resolve = done; }));
    render(<NewCompanyPage />);
    const user = await fillLocal();
    await user.click(screen.getByRole("button", { name: "admin.createCompany" }));
    expect((screen.getByLabelText("admin.localBootstrap.username") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("radio", { name: "admin.localBootstrap.oidcMode" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "common.creating" }) as HTMLButtonElement).disabled).toBe(true);
    resolve({ ok: true, json: async () => ({ success: true, data: bootstrapData }) } as Response);
    await screen.findByLabelText("admin.localBootstrap.invitationLink");
  });

  it("preserves OIDC fields, endpoint, payload and immediate navigation", async () => {
    mockResponse({ success: true, data: { uuid: "oidc-uuid" } });
    render(<NewCompanyPage />);
    const user = userEvent.setup();
    expect(screen.getByRole("radio", { name: "admin.localBootstrap.oidcMode" }).getAttribute("aria-checked")).toBe("true");
    await user.type(screen.getByLabelText("admin.companyName"), "OIDC workspace");
    await user.type(screen.getByLabelText("admin.emailDomain"), "example.com");
    await user.type(screen.getByLabelText("admin.oidcIssuerUrl"), "https://id.example.com");
    await user.type(screen.getByLabelText("admin.clientId"), "client-id");
    await user.click(screen.getByRole("button", { name: "admin.createCompany" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/admin/companies/oidc-uuid"));
    expect(fetch).toHaveBeenCalledWith("/api/admin/companies", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "OIDC workspace", emailDomains: ["example.com"], oidcIssuer: "https://id.example.com", oidcClientId: "client-id" }),
    });
    expect(screen.queryByLabelText("admin.localBootstrap.invitationLink")).toBeNull();
  });
});
