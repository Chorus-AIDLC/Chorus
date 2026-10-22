// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalUserDto } from "@/types/local-user";

const { authFetch, translate } = vi.hoisted(() => ({
  authFetch: vi.fn(),
  translate: (key: string, values?: Record<string, unknown>) => key + (values?.username ? ` ${values.username}` : "") + (values?.date ? ` ${values.date}` : ""),
}));
vi.mock("@/lib/auth-client", () => ({ authFetch }));
vi.mock("next-intl", () => ({ useTranslations: () => translate, useLocale: () => "en" }));
import WorkspaceUsersPage from "../page";

const identity = { user: { authType: "local", workspaceAdmin: true }, company: { localAuthEnabled: true } };
const alice: LocalUserDto = { uuid: "alice-uuid", companyUuid: "company-uuid", username: "alice", email: "alice@example.com", name: "Alice", workspaceAdmin: false, status: "active", createdAt: "2026-10-15T00:00:00Z" };
const relativeLink = `/login/local/accept?token=${"B".repeat(43)}`;
const link = { url: relativeLink, purpose: "invite", expiresAt: "2026-10-16T00:00:00Z" };
const browserLink = `${window.location.origin}${relativeLink}`;
function ok(data: unknown, meta?: unknown) { return new Response(JSON.stringify({ success: true, data, meta })); }
function fail(message: string, code = "CONFLICT", status = 409) { return new Response(JSON.stringify({ success: false, error: { code, message } }), { status }); }
function mutations() { return authFetch.mock.calls.filter(([, init]) => init?.method && init.method !== "GET"); }
function setup({ users = [alice], total = users.length, auth = identity }: { users?: LocalUserDto[]; total?: number; auth?: unknown } = {}) {
  authFetch.mockImplementation(async (url, init) => {
    if (url === "/api/auth/me") return ok(auth);
    if (!init?.method) return ok(users, { page: 1, pageSize: 20, total });
    return ok({ user: users[0], credentialLink: init.method === "POST" ? link : undefined });
  });
  return userEvent.setup();
}
async function loaded() { await screen.findByText("alice"); }
async function choose(user: ReturnType<typeof userEvent.setup>, action: string) {
  await user.click(screen.getByRole("button", { name: "actionsFor alice" }));
  await user.click(await screen.findByRole("menuitem", { name: `actions.${action}` }));
  return screen.findByRole("dialog");
}
function fillInvite() {
  fireEvent.change(screen.getByLabelText("fields.username"), { target: { value: "bob" } });
  fireEvent.change(screen.getByLabelText("fields.email"), { target: { value: "bob@example.com" } });
  fireEvent.change(screen.getByLabelText("fields.name"), { target: { value: "Bob" } });
}

beforeEach(() => {
  authFetch.mockReset();
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("workspace user administration interactions", () => {
  it.each([
    { user: { authType: "local", workspaceAdmin: false }, company: { localAuthEnabled: true } },
    { user: { authType: "oidc", workspaceAdmin: true }, company: { localAuthEnabled: true } },
    { user: { authType: "local", workspaceAdmin: true }, company: { localAuthEnabled: false } },
    { user: { workspaceAdmin: true }, company: { localAuthEnabled: true } },
  ])("denies direct navigation without the complete current local-admin contract: %j", async (auth) => {
    setup({ auth }); render(<WorkspaceUsersPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("deniedDescription");
    expect(screen.getByRole("link", { name: "backToSettings" })).toHaveAttribute("href", "/settings");
    expect(authFetch).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "actions.invite" })).not.toBeInTheDocument();
  });

  it("honors authoritative API denial even after an eligible auth/me projection", async () => {
    setup(); authFetch.mockImplementation(async (url) => url === "/api/auth/me" ? ok(identity) : fail("Access denied", "FORBIDDEN", 403));
    render(<WorkspaceUsersPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("deniedDescription");
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("paginates and changes page size via real shadcn controls", async () => {
    const user = setup({ total: 45 }); render(<WorkspaceUsersPage />); await loaded();
    expect(screen.getByRole("button", { name: "previous" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "next" }));
    await waitFor(() => expect(authFetch).toHaveBeenCalledWith("/api/workspace/users?page=2&pageSize=20", expect.anything()));
    await waitFor(() => expect(screen.getByRole("button", { name: "previous" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "previous" }));
    await user.click(screen.getByRole("combobox", { name: "pageSize" }));
    await user.click(await screen.findByRole("option", { name: "50" }));
    await waitFor(() => expect(authFetch).toHaveBeenCalledWith("/api/workspace/users?page=1&pageSize=50", expect.anything()));
    await waitFor(() => expect(screen.getByRole("button", { name: "next" })).toBeDisabled());
  });

  it("invites with admin checkbox, displays the issued link and expiry, and copies it", async () => {
    const user = setup(); const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    render(<WorkspaceUsersPage />); await loaded(); await user.click(screen.getByRole("button", { name: "actions.invite" })); fillInvite();
    await user.click(screen.getByRole("checkbox", { name: "roles.admin" }));
    await user.click(screen.getByRole("button", { name: "save" }));
    expect(await screen.findByLabelText("issuedLink")).toHaveValue(browserLink);
    expect(screen.getByText(/^expiresAt /)).toHaveTextContent(new Date(link.expiresAt).toLocaleString("en"));
    expect(mutations()).toEqual([["/api/workspace/users", expect.objectContaining({ method: "POST", body: JSON.stringify({ username: "bob", email: "bob@example.com", name: "Bob", workspaceAdmin: true }) })]]);
    await user.click(screen.getByRole("button", { name: "copyLink" }));
    expect(copy).toHaveBeenCalledWith(browserLink); expect(await screen.findByText("copied")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "close" })); expect(screen.queryByLabelText("issuedLink")).not.toBeInTheDocument();
  });

  it("discards a legacy backend origin when displaying and copying a credential link", async () => {
    const user = setup(); const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    render(<WorkspaceUsersPage />); await loaded();
    await user.click(screen.getByRole("button", { name: "actions.invite" })); fillInvite();
    authFetch.mockImplementation(async (_url, init) => init?.method
      ? ok({ user: alice, credentialLink: { ...link, url: `https://backend.example.com${relativeLink}` } })
      : ok([alice], { total: 1 }));
    await user.click(screen.getByRole("button", { name: "save" }));
    expect(await screen.findByLabelText("issuedLink")).toHaveValue(browserLink);
    await user.click(screen.getByRole("button", { name: "copyLink" }));
    expect(copy).toHaveBeenCalledWith(browserLink);
    expect(copy.mock.calls[0][0]).not.toContain("backend.example.com");
  });

  it("preserves the issued link when clipboard or post-mutation refresh fails", async () => {
    const user = setup(); vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("blocked"));
    render(<WorkspaceUsersPage />); await loaded(); await user.click(screen.getByRole("button", { name: "actions.invite" })); fillInvite();
    authFetch.mockImplementation(async (_url, init) => { if (!init?.method) throw new Error("offline"); return ok({ user: alice, credentialLink: link }); });
    await user.click(screen.getByRole("button", { name: "save" }));
    expect(await screen.findByLabelText("issuedLink")).toHaveValue(browserLink);
    await user.click(screen.getByRole("button", { name: "copyLink" }));
    expect(await screen.findByText("copyFailed")).toBeInTheDocument();
    expect(screen.getByLabelText("issuedLink")).toHaveValue(browserLink);
    await user.click(screen.getByRole("button", { name: "close" })); expect(screen.getByRole("alert")).toHaveTextContent("errors.loadFailed");
  });

  it("edits an invited identity and presents its replacement link", async () => {
    const user = setup({ users: [{ ...alice, status: "invited" }] });
    render(<WorkspaceUsersPage />); await loaded(); await choose(user, "edit");
    expect(screen.getByLabelText("fields.username")).toHaveValue("alice");
    fireEvent.change(screen.getByLabelText("fields.email"), { target: { value: "new@example.com" } });
    authFetch.mockImplementation(async (_url, init) => init?.method ? ok({ user: alice, credentialLink: link }) : ok([alice], { total: 1 }));
    await user.click(screen.getByRole("button", { name: "save" }));
    expect(await screen.findByLabelText("issuedLink")).toHaveValue(browserLink);
    expect(mutations()[0]).toEqual(["/api/workspace/users/alice-uuid", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ username: "alice", email: "new@example.com", name: "Alice" }) })]);
  });

  it.each([
    ["grant", "active", false, "PATCH", { workspaceAdmin: true }, ""],
    ["revoke", "active", true, "PATCH", { workspaceAdmin: false }, ""],
    ["disable", "active", false, "PATCH", { status: "disabled" }, ""],
    ["enable", "disabled", false, "PATCH", { status: "active" }, ""],
    ["reset", "active", false, "POST", { purpose: "reset" }, "/credentials"],
    ["reinvite", "invited", false, "POST", { purpose: "invite" }, "/credentials"],
    ["remove", "active", false, "DELETE", undefined, ""],
  ] as const)("confirms %s with the correct scoped lifecycle request", async (action, status, workspaceAdmin, method, body, suffix) => {
    const user = setup({ users: [{ ...alice, status, workspaceAdmin }] }); render(<WorkspaceUsersPage />); await loaded();
    const dialog = await choose(user, action);
    expect(within(dialog).getByText(`confirmations.${action} alice`)).toBeInTheDocument();
    expect(mutations()).toHaveLength(0);
    await user.click(within(dialog).getByRole("button", { name: "confirm" }));
    await waitFor(() => expect(mutations()).toHaveLength(1));
    expect(mutations()[0]).toEqual([`/api/workspace/users/alice-uuid${suffix}`, expect.objectContaining({ method, ...(body ? { body: JSON.stringify(body) } : {}) })]);
    if (method === "POST") expect(await screen.findByLabelText("issuedLink")).toHaveValue(browserLink);
    else await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("keeps last-admin failure visible in the confirmation dialog and does not show success", async () => {
    const user = setup({ users: [{ ...alice, workspaceAdmin: true }] }); render(<WorkspaceUsersPage />); await loaded(); await choose(user, "revoke");
    authFetch.mockResolvedValue(fail("Cannot remove the last effective Workspace Admin"));
    await user.click(screen.getByRole("button", { name: "confirm" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("errors.lastAdmin");
    expect(screen.getByRole("dialog")).toBeInTheDocument(); expect(screen.queryByText("operationSucceeded")).not.toBeInTheDocument();
  });

  it.each(["invite", "edit"] as const)("retains %s input on duplicate identity rejection and allows a corrected retry", async (action) => {
    const user = setup(); render(<WorkspaceUsersPage />); await loaded();
    if (action === "invite") await user.click(screen.getByRole("button", { name: "actions.invite" }));
    else await choose(user, "edit");
    fillInvite();
    authFetch.mockResolvedValueOnce(fail("Username or email already exists in this workspace"));
    await user.click(screen.getByRole("button", { name: "save" }));
    const dialog = screen.getByRole("dialog");
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("errors.duplicate");
    expect(within(dialog).getByLabelText("fields.username")).toHaveValue("bob");
    expect(within(dialog).getByLabelText("fields.email")).toHaveValue("bob@example.com");
    expect(within(dialog).getByLabelText("fields.name")).toHaveValue("Bob");
    expect(within(dialog).getByLabelText("fields.username")).toBeEnabled();
    expect(within(dialog).getByRole("button", { name: "save" })).toBeEnabled();
    expect(within(dialog).getByRole("button", { name: "cancel" })).toBeEnabled();
    expect(screen.queryByText("operationSucceeded")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("issuedLink")).not.toBeInTheDocument();
    expect(mutations()).toEqual([[action === "invite" ? "/api/workspace/users" : "/api/workspace/users/alice-uuid", expect.objectContaining({ method: action === "invite" ? "POST" : "PATCH" })]]);
    await user.clear(within(dialog).getByLabelText("fields.username"));
    await user.type(within(dialog).getByLabelText("fields.username"), "unique-bob");
    await user.clear(within(dialog).getByLabelText("fields.email"));
    await user.type(within(dialog).getByLabelText("fields.email"), "unique-bob@example.com");
    await user.click(within(dialog).getByRole("button", { name: "save" }));
    expect(await screen.findByText("operationSucceeded")).toBeInTheDocument();
    expect(mutations()).toHaveLength(2);
    expect(JSON.parse(mutations()[1][1].body)).toEqual({ username: "unique-bob", email: "unique-bob@example.com", name: "Bob", ...(action === "invite" ? { workspaceAdmin: false } : {}) });
    expect(screen.queryByText("errors.duplicate")).not.toBeInTheDocument();
    if (action === "invite") expect(await screen.findByLabelText("issuedLink")).toHaveValue(browserLink);
    else expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it.each(["API", "network"] as const)("recovers loading after a generic %s mutation failure without success or link handoff and retries", async (failure) => {
    const user = setup(); render(<WorkspaceUsersPage />); await loaded();
    await user.click(screen.getByRole("button", { name: "actions.invite" })); fillInvite();
    let resolve!: (response: Response) => void;
    let reject!: (error: Error) => void;
    authFetch.mockImplementationOnce(() => new Promise<Response>((done, failed) => { resolve = done; reject = failed; }));
    await user.click(screen.getByRole("button", { name: "save" }));
    expect(screen.getByRole("button", { name: "saving" })).toBeDisabled();
    expect(screen.getByLabelText("fields.username")).toBeDisabled();
    expect(screen.getByRole("button", { name: "cancel" })).toBeDisabled();
    await act(async () => {
      if (failure === "API") resolve(fail("Internal server error", "INTERNAL_ERROR", 500));
      else reject(new Error("offline"));
    });
    const dialog = screen.getByRole("dialog");
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("errors.operationFailed");
    expect(within(dialog).getByLabelText("fields.username")).toHaveValue("bob");
    expect(within(dialog).getByLabelText("fields.email")).toHaveValue("bob@example.com");
    expect(within(dialog).getByLabelText("fields.name")).toHaveValue("Bob");
    expect(within(dialog).getByLabelText("fields.username")).toBeEnabled();
    expect(within(dialog).getByRole("button", { name: "save" })).toBeEnabled();
    expect(within(dialog).getByRole("button", { name: "cancel" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "saving" })).not.toBeInTheDocument();
    expect(screen.queryByText("operationSucceeded")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("issuedLink")).not.toBeInTheDocument();
    expect(mutations()).toHaveLength(1);
    await user.click(within(dialog).getByRole("button", { name: "save" }));
    expect(await screen.findByLabelText("issuedLink")).toHaveValue(browserLink);
    expect(screen.getByText("operationSucceeded")).toBeInTheDocument();
    expect(screen.queryByText("errors.operationFailed")).not.toBeInTheDocument();
    expect(mutations()).toHaveLength(2);
    expect(mutations()[1]).toEqual(mutations()[0]);
  });

  it("validates identity, protects IME Enter and excludes duplicate pending submissions", async () => {
    const user = setup(); render(<WorkspaceUsersPage />); await loaded(); await user.click(screen.getByRole("button", { name: "actions.invite" })); fillInvite();
    fireEvent.change(screen.getByLabelText("fields.username"), { target: { value: "bad@name" } });
    fireEvent.submit(screen.getByRole("button", { name: "save" }).closest("form")!);
    expect(await screen.findByRole("alert")).toHaveTextContent("errors.invalidInput"); expect(mutations()).toHaveLength(0);
    fillInvite();
    const event = new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true });
    screen.getByLabelText("fields.name").dispatchEvent(event); expect(event.defaultPrevented).toBe(true); expect(mutations()).toHaveLength(0);
    let resolve!: (response: Response) => void;
    authFetch.mockImplementation(() => new Promise<Response>((done) => { resolve = done; }));
    const form = screen.getByRole("button", { name: "save" }).closest("form")!;
    fireEvent.submit(form); fireEvent.submit(form);
    expect(mutations()).toHaveLength(1); expect(screen.getByRole("button", { name: "saving" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "cancel" })).toBeDisabled();
    await act(async () => resolve(ok({ user: alice, credentialLink: link })));
    expect(await screen.findByLabelText("issuedLink")).toHaveValue(browserLink);
  });

  it("invites without an optional display name instead of submitting an invalid empty name", async () => {
    const user = setup(); render(<WorkspaceUsersPage />); await loaded();
    await user.click(screen.getByRole("button", { name: "actions.invite" })); fillInvite();
    fireEvent.change(screen.getByLabelText("fields.name"), { target: { value: "   " } });
    await user.click(screen.getByRole("button", { name: "save" }));
    expect(await screen.findByLabelText("issuedLink")).toHaveValue(browserLink);
    expect(JSON.parse(mutations()[0][1].body)).toEqual({ username: "bob", email: "bob@example.com", workspaceAdmin: false });
  });

  it("keeps a self-reset link available for copy after the revoked session receives 401", async () => {
    const user = setup(); const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    render(<WorkspaceUsersPage />); await loaded(); await choose(user, "reset");
    authFetch.mockImplementation(async (_url, init) => init?.method ? ok({ user: alice, credentialLink: { ...link, purpose: "reset" } }) : fail("Expired", "UNAUTHORIZED", 401));
    await user.click(screen.getByRole("button", { name: "confirm" }));
    expect(await screen.findByLabelText("issuedLink")).toHaveValue(browserLink);
    await user.click(screen.getByRole("button", { name: "copyLink" })); expect(copy).toHaveBeenCalledWith(browserLink);
    await user.click(screen.getByRole("button", { name: "close" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("deniedDescription");
    expect(screen.queryByRole("button", { name: "actions.invite" })).not.toBeInTheDocument();
  });

  it("retries a transient auth projection failure without treating it as permission denial", async () => {
    const user = setup(); authFetch.mockRejectedValueOnce(new Error("offline")); render(<WorkspaceUsersPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("errors.accessFailed");
    await user.click(screen.getByRole("button", { name: "retry" })); await loaded();
    expect(screen.getByRole("button", { name: "actions.invite" })).toBeEnabled();
  });

  it("does not allow removed users to be mutated or invited users to be enabled", async () => {
    const user = setup({ users: [{ ...alice, status: "invited" }, { ...alice, uuid: "deleted", username: "removed", status: "deleted" }] });
    render(<WorkspaceUsersPage />); await loaded();
    expect(screen.queryByRole("button", { name: "actionsFor removed" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "actionsFor alice" }));
    expect(await screen.findByRole("menuitem", { name: "actions.reinvite" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "actions.enable" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "actions.reset" })).not.toBeInTheDocument();
  });
});
