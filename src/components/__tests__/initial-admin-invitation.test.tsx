// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://workspace.customer.example"}
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalUserDto } from "@/types/local-user";
import * as credentialLinks from "@/lib/credential-link";

const { translate } = vi.hoisted(() => ({
  translate: (key: string, values?: Record<string, unknown>) => key + (values?.date ? ` ${values.date}` : ""),
}));
vi.mock("next-intl", () => ({ useTranslations: () => translate, useLocale: () => "en" }));

import { InitialAdminInvitation } from "../initial-admin-invitation";

const companyUuid = "company-uuid";
const endpoint = `/api/admin/companies/${companyUuid}/initial-admin`;
const admin: LocalUserDto = {
  uuid: "initial-admin-uuid", companyUuid, username: "first-admin", email: "first@example.com",
  name: "First Admin", workspaceAdmin: true, status: "invited", createdAt: "2026-10-15T00:00:00Z",
};
const relativeLink = `/login/local/accept?token=${"C".repeat(43)}`;
const browserLink = `${window.location.origin}${relativeLink}`;
const credentialLink = { url: relativeLink, purpose: "invite", expiresAt: "2026-10-16T04:00:00Z" };
function ok(data: unknown) { return new Response(JSON.stringify({ success: true, data })); }
function fail(status = 500) { return new Response(JSON.stringify({ success: false, error: { message: "Rejected" } }), { status }); }
function posts() { return vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST"); }
function postBody(index = 0) { return JSON.parse(posts()[index][1]!.body as string); }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function loaded(state = { user: admin as LocalUserDto | null, manageable: true }) {
  vi.mocked(fetch).mockResolvedValue(ok(state));
  const user = userEvent.setup();
  render(<InitialAdminInvitation companyUuid={companyUuid} />);
  await screen.findByText(state.user ? state.user.name || state.user.username : "noInvitation");
  return user;
}
async function open(user: ReturnType<typeof userEvent.setup>, action: string) {
  await user.click(screen.getByRole("button", { name: action }));
  return screen.findByRole("dialog");
}
function fillReplacement(name = "Replacement Admin") {
  fireEvent.change(screen.getByLabelText("fields.username"), { target: { value: " replacement-admin " } });
  fireEvent.change(screen.getByLabelText("fields.email"), { target: { value: "replacement@example.com" } });
  fireEvent.change(screen.getByLabelText("fields.name"), { target: { value: name } });
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("InitialAdminInvitation", () => {
  it("loads the scoped invitation once and presents its identity and invited status", async () => {
    await loaded();
    expect(fetch).toHaveBeenCalledExactlyOnceWith(endpoint, { cache: "no-store" });
    expect(screen.getByText("first-admin · first@example.com")).toBeInTheDocument();
    expect(screen.getByText("statuses.invited")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "reinvite" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "revoke" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "replace" })).toBeEnabled();
  });

  it("requires confirmation before reinviting, then displays and copies the current-origin link", async () => {
    const user = await loaded();
    const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const dialog = await open(user, "reinvite");
    expect(within(dialog).getByText("reinviteHelp")).toBeInTheDocument();
    expect(posts()).toHaveLength(0);
    await user.click(within(dialog).getByRole("button", { name: "cancel" }));
    expect(posts()).toHaveLength(0);
    await open(user, "reinvite");
    vi.mocked(fetch).mockResolvedValueOnce(ok({ user: admin, manageable: true, credentialLink }));
    await user.click(screen.getByRole("button", { name: "confirm" }));
    expect(await screen.findByLabelText("issuedLink")).toHaveValue(browserLink);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(posts()).toEqual([[endpoint, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "reinvite", expectedUserUuid: admin.uuid }),
    }]]);
    expect(screen.getByText("issued")).toBeInTheDocument();
    expect(screen.getByText(/^expiresAt /)).toHaveTextContent(new Date(credentialLink.expiresAt).toLocaleString("en"));
    expect(screen.getByLabelText("issuedLink")).toHaveAttribute("readonly");
    await user.click(screen.getByRole("button", { name: "copyLink" }));
    expect(copy).toHaveBeenCalledWith(browserLink);
    expect(await screen.findByText("copied")).toBeInTheDocument();
  });

  it("requires confirmation to revoke and replaces the identity with the empty invitation state", async () => {
    const user = await loaded();
    const dialog = await open(user, "revoke");
    expect(within(dialog).getByText("revokeHelp")).toBeInTheDocument();
    expect(posts()).toHaveLength(0);
    vi.mocked(fetch).mockResolvedValueOnce(ok({ user: null, manageable: true }));
    await user.click(within(dialog).getByRole("button", { name: "confirm" }));
    expect(await screen.findByText("noInvitation")).toBeInTheDocument();
    expect(postBody()).toEqual({ action: "revoke", expectedUserUuid: admin.uuid });
    expect(screen.getByText("revoked")).toBeInTheDocument();
    expect(screen.queryByText("First Admin")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "revoke" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "invite" })).toBeEnabled();
    expect(screen.queryByLabelText("issuedLink")).not.toBeInTheDocument();
  });

  it.each(["", "   ", " Replacement Admin "])("replaces the expected identity with a trimmed optional name %j", async (name) => {
    const user = await loaded();
    await open(user, "replace"); fillReplacement(name);
    expect(screen.getByLabelText("fields.name")).not.toBeRequired();
    const replacement = { ...admin, uuid: "replacement-uuid", username: "replacement-admin", email: "replacement@example.com", name: name.trim() || null };
    vi.mocked(fetch).mockResolvedValueOnce(ok({ user: replacement, manageable: true, credentialLink }));
    await user.click(screen.getByRole("button", { name: "confirm" }));
    expect(await screen.findByLabelText("issuedLink")).toHaveValue(browserLink);
    expect(postBody()).toEqual({
      action: "replace", expectedUserUuid: admin.uuid,
      initialAdmin: { username: "replacement-admin", email: "replacement@example.com", ...(name.trim() ? { name: name.trim() } : {}) },
    });
    expect(screen.getByText("replacement-admin · replacement@example.com")).toBeInTheDocument();
    expect(screen.queryByText("First Admin")).not.toBeInTheDocument();
  });

  it("creates the first invitation with an explicit null expected UUID", async () => {
    const user = await loaded({ user: null, manageable: true });
    await open(user, "invite"); fillReplacement("");
    vi.mocked(fetch).mockResolvedValueOnce(ok({ user: admin, manageable: true, credentialLink }));
    await user.click(screen.getByRole("button", { name: "confirm" }));
    await screen.findByLabelText("issuedLink");
    expect(postBody()).toEqual({ action: "replace", expectedUserUuid: null, initialAdmin: { username: "replacement-admin", email: "replacement@example.com" } });
  });

  it("reports a stale 409 and allows refresh before acting on the newly current UUID", async () => {
    const user = await loaded(); await open(user, "reinvite");
    vi.mocked(fetch).mockResolvedValueOnce(fail(409));
    await user.click(screen.getByRole("button", { name: "confirm" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("stateChanged");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.queryByLabelText("issuedLink")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "cancel" }));
    const current = { ...admin, uuid: "new-current-uuid", name: "Current Admin" };
    vi.mocked(fetch).mockResolvedValueOnce(ok({ user: current, manageable: true }));
    await user.click(screen.getByRole("button", { name: "retry" }));
    await screen.findByText("Current Admin");
    await open(user, "reinvite");
    vi.mocked(fetch).mockResolvedValueOnce(ok({ user: current, manageable: true, credentialLink }));
    await user.click(screen.getByRole("button", { name: "confirm" }));
    await screen.findByLabelText("issuedLink");
    expect(postBody(1)).toEqual({ action: "reinvite", expectedUserUuid: current.uuid });
  });

  it.each(["API", "network"])("retains replacement dialog input after %s failure and permits retry", async (failure) => {
    const user = await loaded(); await open(user, "replace"); fillReplacement();
    if (failure === "API") vi.mocked(fetch).mockResolvedValueOnce(fail());
    else vi.mocked(fetch).mockRejectedValueOnce(new Error("offline"));
    await user.click(screen.getByRole("button", { name: "confirm" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("errors.operationFailed");
    expect(screen.getByLabelText("fields.username")).toHaveValue(" replacement-admin ");
    expect(screen.getByLabelText("fields.email")).toHaveValue("replacement@example.com");
    expect(screen.getByLabelText("fields.name")).toHaveValue("Replacement Admin");
    expect(screen.getByRole("button", { name: "confirm" })).toBeEnabled();
    expect(screen.queryByText("issued")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("issuedLink")).not.toBeInTheDocument();
    vi.mocked(fetch).mockResolvedValueOnce(ok({ user: admin, manageable: true, credentialLink }));
    await user.click(screen.getByRole("button", { name: "confirm" }));
    expect(await screen.findByLabelText("issuedLink")).toHaveValue(browserLink);
    expect(posts()).toHaveLength(2);
    expect(postBody(1)).toEqual(postBody());
  });

  it("keeps the issued link available when the clipboard denies access", async () => {
    const user = await loaded();
    const copy = vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("denied"));
    await open(user, "reinvite");
    vi.mocked(fetch).mockResolvedValueOnce(ok({ user: admin, manageable: true, credentialLink }));
    await user.click(screen.getByRole("button", { name: "confirm" }));
    await screen.findByLabelText("issuedLink");
    await user.click(screen.getByRole("button", { name: "copyLink" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("copyFailed");
    expect(screen.getByLabelText("issuedLink")).toHaveValue(browserLink);
    expect(copy).toHaveBeenCalledWith(browserLink);
    expect(screen.getByRole("button", { name: "copyLink" })).toBeEnabled();
    copy.mockResolvedValue();
    await user.click(screen.getByRole("button", { name: "copyLink" }));
    expect(await screen.findByText("copied")).toBeInTheDocument();
    expect(screen.queryByText("copyFailed")).not.toBeInTheDocument();
    expect(posts()).toHaveLength(1);
  });

  it.each(["resolve", "reject"])("keeps a fresh link copyable after refreshing a pending clipboard %s", async (settlement) => {
    const user = await loaded();
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const pending = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
    const copy = vi.spyOn(navigator.clipboard, "writeText").mockReturnValueOnce(pending).mockResolvedValue();
    await open(user, "reinvite");
    vi.mocked(fetch).mockResolvedValueOnce(ok({ user: admin, manageable: true, credentialLink }));
    await user.click(screen.getByRole("button", { name: "confirm" }));
    await screen.findByLabelText("issuedLink");
    await user.click(screen.getByRole("button", { name: "copyLink" }));
    expect(screen.getByRole("button", { name: "copyLink" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "retry" }));
    await screen.findByText("First Admin");
    await open(user, "reinvite");
    const fresh = { ...credentialLink, url: `/login/local/accept?token=${"D".repeat(43)}` };
    vi.mocked(fetch).mockResolvedValueOnce(ok({ user: admin, manageable: true, credentialLink: fresh }));
    await user.click(screen.getByRole("button", { name: "confirm" }));
    await screen.findByLabelText("issuedLink");
    expect(screen.getByRole("button", { name: "copyLink" })).toBeEnabled();
    await act(async () => { if (settlement === "resolve") resolve(); else reject(new Error("denied")); });
    expect(screen.queryByText("copied")).not.toBeInTheDocument();
    expect(screen.queryByText("copyFailed")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "copyLink" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "copyLink" }));
    expect(copy).toHaveBeenLastCalledWith(`${window.location.origin}${fresh.url}`);
    expect(await screen.findByText("copied")).toBeInTheDocument();
  });

  it("rebases a legacy absolute link for both display and clipboard", async () => {
    const user = await loaded();
    const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    await open(user, "reinvite");
    vi.mocked(fetch).mockResolvedValueOnce(ok({ user: admin, manageable: true, credentialLink: { ...credentialLink, url: `https://backend.example.com${relativeLink}` } }));
    await user.click(screen.getByRole("button", { name: "confirm" }));
    expect(await screen.findByLabelText("issuedLink")).toHaveValue(browserLink);
    await user.click(screen.getByRole("button", { name: "copyLink" }));
    expect(copy).toHaveBeenCalledWith(browserLink);
    expect(copy.mock.calls[0][0]).not.toContain("backend.example.com");
  });

  it("disables controls while submitting, prevents dismissal and excludes duplicate POSTs", async () => {
    const user = await loaded(); const dialog = await open(user, "replace"); fillReplacement();
    const pending = deferred<Response>(); vi.mocked(fetch).mockReturnValueOnce(pending.promise);
    const form = within(dialog).getByRole("button", { name: "confirm" }).closest("form")!;
    fireEvent.submit(form); fireEvent.submit(form);
    expect(posts()).toHaveLength(1);
    for (const label of ["fields.username", "fields.email", "fields.name"]) expect(within(dialog).getByLabelText(label)).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "saving" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "cancel" })).toBeDisabled();
    for (const action of ["reinvite", "revoke", "replace", "retry"]) expect(screen.getByRole("button", { name: action, hidden: true })).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await act(async () => pending.resolve(ok({ user: admin, manageable: true, credentialLink })));
    await screen.findByLabelText("issuedLink");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "reinvite" })).toBeEnabled();
  });

  it.each([{ isComposing: true }, { keyCode: 229 }])("protects IME Enter %j without submitting", async (ime) => {
    const user = await loaded(); await open(user, "replace"); fillReplacement();
    const event = new KeyboardEvent("keydown", { key: "Enter", ...ime, bubbles: true, cancelable: true });
    fireEvent(screen.getByLabelText("fields.name"), event);
    expect(event.defaultPrevented).toBe(true);
    expect(posts()).toHaveLength(0);
  });

  it.each([
    ["fields.username", "bad@username"],
    ["fields.username", "ab"],
    ["fields.email", "not-an-email"],
    ["fields.name", "a".repeat(201)],
  ])("validates %s before any replacement request", async (field, value) => {
    const user = await loaded(); await open(user, "replace"); fillReplacement();
    fireEvent.change(screen.getByLabelText(field), { target: { value } });
    fireEvent.submit(screen.getByRole("button", { name: "confirm" }).closest("form")!);
    expect(await screen.findByRole("alert")).toHaveTextContent("errors.invalidInput");
    expect(posts()).toHaveLength(0);
  });

  it("shows an activated initial admin as read-only with no invitation management controls", async () => {
    await loaded({ user: { ...admin, status: "active" }, manageable: false });
    expect(screen.getByText("statuses.active")).toBeInTheDocument();
    expect(screen.getByText("activated")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(posts()).toHaveLength(0);
  });

  it.each(["API", "network"])("retries a failed %s load", async (failure) => {
    if (failure === "API") vi.mocked(fetch).mockResolvedValueOnce(fail());
    else vi.mocked(fetch).mockRejectedValueOnce(new Error("offline"));
    const user = userEvent.setup(); render(<InitialAdminInvitation companyUuid={companyUuid} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("loadFailed");
    expect(screen.queryByRole("button", { name: "reinvite" })).not.toBeInTheDocument();
    vi.mocked(fetch).mockResolvedValueOnce(ok({ user: admin, manageable: true }));
    await user.click(screen.getByRole("button", { name: "retry" }));
    await screen.findByText("First Admin");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("shows loading until the request completes and ignores an older company's response", async () => {
    const pending = deferred<Response>(); vi.mocked(fetch).mockReturnValueOnce(pending.promise);
    const view = render(<InitialAdminInvitation companyUuid={companyUuid} />);
    expect(screen.getByRole("status")).toHaveTextContent("loading");
    vi.mocked(fetch).mockResolvedValueOnce(ok({ user: null, manageable: true }));
    view.rerender(<InitialAdminInvitation companyUuid="other-company" />);
    await screen.findByText("noInvitation");
    await act(async () => pending.resolve(ok({ user: admin, manageable: true })));
    expect(screen.getByText("noInvitation")).toBeInTheDocument();
    expect(screen.queryByText("First Admin")).not.toBeInTheDocument();
    expect(fetch).toHaveBeenLastCalledWith("/api/admin/companies/other-company/initial-admin", { cache: "no-store" });
  });

  it.each(["load", "submission"])("ignores a pending %s response after unmount", async (stage) => {
    const hydrate = vi.spyOn(credentialLinks, "credentialLinkUrl");
    const pending = deferred<Response>();
    const user = userEvent.setup();
    if (stage === "load") vi.mocked(fetch).mockReturnValueOnce(pending.promise);
    else vi.mocked(fetch).mockResolvedValueOnce(ok({ user: admin, manageable: true }));
    const view = render(<InitialAdminInvitation companyUuid={companyUuid} />);
    if (stage === "submission") {
      await screen.findByText("First Admin"); await open(user, "reinvite");
      vi.mocked(fetch).mockReturnValueOnce(pending.promise);
      await user.click(screen.getByRole("button", { name: "confirm" }));
    }
    view.unmount();
    vi.mocked(fetch).mockResolvedValueOnce(ok({ user: null, manageable: true }));
    render(<InitialAdminInvitation companyUuid="other-company" />);
    await screen.findByText("noInvitation");
    await act(async () => pending.resolve(ok({ user: admin, manageable: true, credentialLink })));
    expect(hydrate).not.toHaveBeenCalled();
    expect(view.container).toBeEmptyDOMElement();
    expect(screen.getByText("noInvitation")).toBeInTheDocument();
    expect(screen.queryByLabelText("issuedLink")).not.toBeInTheDocument();
    expect(screen.queryByText("issued")).not.toBeInTheDocument();
  });
});
