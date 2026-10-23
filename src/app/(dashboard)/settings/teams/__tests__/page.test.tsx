// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../../../../../../messages/en.json";
import zh from "../../../../../../messages/zh.json";
import { AGENT_TEAM_ROLE_DEFINITIONS } from "@/lib/agent-team-roles";
import type { AgentTeamCandidateDto, AgentTeamDto } from "@/types/agent-team";

const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock("@/lib/auth-client", () => ({ authFetch }));
import TeamsSettingsPage from "../page";

const capable: AgentTeamCandidateDto = { uuid: "agent-one", name: "Alice", effectivePermissions: [...AGENT_TEAM_ROLE_DEFINITIONS.lead.requiredPermissions] };
const second: AgentTeamCandidateDto = { ...capable, uuid: "agent-two", name: "Bob" };
const reader: AgentTeamCandidateDto = { uuid: "agent-reader", name: "Reader", effectivePermissions: [...AGENT_TEAM_ROLE_DEFINITIONS.review.requiredPermissions] };
const team: AgentTeamDto = { uuid: "team-one", companyUuid: "company", ownerUuid: "owner", name: "My team", description: "Personal template", createdAt: "2026-10-23T00:00:00Z", updatedAt: "2026-10-23T00:00:00Z", members: [] };

function ok(data: unknown) { return new Response(JSON.stringify({ success: true, data })); }
function fail(code = "INTERNAL_ERROR", details?: unknown) { return new Response(JSON.stringify({ success: false, error: { code, message: "Server message", details } }), { status: code === "VALIDATION_ERROR" ? 422 : 500 }); }
function setup(teams: AgentTeamDto[] = [], candidates = [capable, second, reader]) {
  authFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method) return ok(team);
    if (url.endsWith("/candidates")) return ok(candidates);
    if (url === "/api/agent-teams") return ok(teams);
    return ok(teams[0] ?? team);
  });
  return userEvent.setup();
}
function mount(locale: "en" | "zh" = "en") {
  return render(<NextIntlClientProvider locale={locale} messages={locale === "en" ? en : zh}><TeamsSettingsPage /></NextIntlClientProvider>);
}
async function create(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Create team" }));
  await waitFor(() => expect(screen.getByLabelText("Team name")).toBeEnabled());
  return within(screen.getByRole("dialog"));
}
function writes() { return authFetch.mock.calls.filter(([, init]) => init?.method); }
function role(name: string) { return within(screen.getByRole("group", { name })); }

async function openPicker(user: ReturnType<typeof userEvent.setup>, roleName: string) {
  const trigger = role(roleName).getByRole("combobox");
  trigger.focus();
  await user.keyboard("{Enter}");
  return within(await screen.findByRole("listbox"));
}
async function addAgent(user: ReturnType<typeof userEvent.setup>, roleName: string, name: string) {
  const picker = await openPicker(user, roleName);
  await user.click(picker.getByRole("option", { name }));
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

describe("personal team settings", () => {
  it("shows loading, private scope, the empty state, and Settings navigation", async () => {
    setup();
    mount();
    expect(screen.getByRole("status")).toHaveTextContent("Loading your teams");
    expect(await screen.findByRole("heading", { name: "No teams yet" })).toBeInTheDocument();
    expect(screen.getByText(/Private to you/)).toHaveTextContent("do not grant permissions or project access");
    expect(screen.getByRole("link", { name: "Back to Settings" })).toHaveAttribute("href", "/settings");
    expect(authFetch).toHaveBeenCalledWith("/api/agent-teams", { cache: "no-store" });
  });

  it("creates with multiple own agents per role and the same agent across roles", async () => {
    const user = setup(); mount();
    const dialog = await create(user);
    await user.type(dialog.getByLabelText("Team name"), "  Delivery  ");
    await user.type(dialog.getByLabelText("Description (optional)"), "  My agents  ");
    await addAgent(user, "Product", "Alice");
    await addAgent(user, "Product", "Bob");
    await addAgent(user, "Development", "Alice");
    await user.click(dialog.getByRole("button", { name: "Save team" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(writes()).toHaveLength(1);
    expect(writes()[0][0]).toBe("/api/agent-teams");
    expect(writes()[0][1].method).toBe("POST");
    expect(JSON.parse(writes()[0][1].body)).toEqual({ name: "Delivery", description: "My agents", members: [
      { role: "product", agentUuid: capable.uuid }, { role: "product", agentUuid: second.uuid }, { role: "development", agentUuid: capable.uuid },
    ] });
    expect(screen.getByText("Team saved.")).toBeInTheDocument();
    expect(authFetch.mock.calls.filter(([url]) => url === "/api/agent-teams")).toHaveLength(3);
  });

  it("allows empty templates, explains no own agents, and validates a blank name", async () => {
    const user = setup([], []); mount();
    const dialog = await create(user);
    expect(dialog.getByText(/You have no agents yet/)).toBeInTheDocument();
    expect(dialog.getByRole("link", { name: "Manage your agents in Settings" })).toHaveAttribute("href", "/settings");
    expect(dialog.getAllByRole("group", { name: /^(Product|Development|Review|Lead)$/ })).toHaveLength(4);
    expect(dialog.getByRole("button", { name: "Save team" })).toBeDisabled();
    await user.type(dialog.getByLabelText("Team name"), "   ");
    expect(dialog.getByRole("button", { name: "Save team" })).toBeDisabled();
    await user.type(dialog.getByLabelText("Team name"), "Empty");
    await user.click(dialog.getByRole("button", { name: "Save team" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(JSON.parse(writes()[0][1].body).members).toEqual([]);
  });

  it("uses shared requirements and disables only invalid new role choices with exact missing bits", async () => {
    const user = setup(); mount(); await create(user);
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
    expect(role("Product").getByText(/^Required permissions:/)).not.toBeVisible();
    await user.click(role("Product").getByText("Permission requirements"));
    expect(role("Product").getByText(/^Required permissions:/)).toHaveTextContent(AGENT_TEAM_ROLE_DEFINITIONS.product.requiredPermissions.join(", "));
    let picker = await openPicker(user, "Product");
    const productReader = picker.getByRole("option", { name: /Reader/ });
    expect(productReader).toHaveAttribute("aria-disabled", "true");
    expect(productReader).toHaveAccessibleDescription("Missing permissions: idea:write, proposal:write, document:write");
    await user.keyboard("{Escape}");
    picker = await openPicker(user, "Development");
    expect(picker.getByRole("option", { name: /Reader/ })).toHaveAccessibleDescription("Missing permissions: task:write");
    await user.keyboard("{Escape}");
    await addAgent(user, "Review", "Reader");
    expect(role("Review").getByRole("button", { name: "Remove Reader" })).toBeEnabled();
  });

  it("refreshes detail and candidates before editing; retains invalid members during rename and allows removal", async () => {
    const drifted: AgentTeamDto = { ...team, members: [{ role: "development", agentUuid: reader.uuid, agentName: reader.name, eligible: false, missingPermissions: ["task:write"] }] };
    const user = setup([drifted]); mount();
    expect(await screen.findByText("Missing permissions: task:write")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Edit team My team" }));
    await waitFor(() => expect(screen.getByLabelText("Team name")).toBeEnabled());
    expect(authFetch).toHaveBeenCalledWith(`/api/agent-teams/${team.uuid}`, { cache: "no-store" });
    expect(authFetch).toHaveBeenCalledWith("/api/agent-teams/candidates", { cache: "no-store" });
    const selected = role("Development").getByRole("button", { name: "Remove Reader" });
    expect(selected).toBeInTheDocument();
    expect(selected).toBeEnabled();
    expect(selected).toHaveAccessibleDescription(/Existing member/);
    await user.clear(screen.getByLabelText("Team name"));
    await user.type(screen.getByLabelText("Team name"), "Renamed");
    await user.click(screen.getByRole("button", { name: "Save team" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(writes()[0][1].method).toBe("PATCH");
    expect(JSON.parse(writes()[0][1].body)).toEqual({ name: "Renamed", description: team.description, members: [{ role: "development", agentUuid: reader.uuid }] });
    await user.click(await screen.findByRole("button", { name: "Edit team My team" }));
    await waitFor(() => expect(screen.getByLabelText("Team name")).toBeEnabled());
    const removable = role("Development").getByRole("button", { name: "Remove Reader" });
    await user.click(removable);
    expect(removable).not.toBeInTheDocument();
    const picker = await openPicker(user, "Development");
    expect(picker.getByRole("option", { name: /Reader/ })).toHaveAttribute("aria-disabled", "true");
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Save team" }));
    await waitFor(() => expect(writes()).toHaveLength(2));
    expect(JSON.parse(writes()[1][1].body).members).toEqual([]);
  });

  it("keeps invalid existing members visible and removable even when candidates omit them", async () => {
    const existing: AgentTeamDto = { ...team, members: [{ role: "development", agentUuid: reader.uuid, agentName: reader.name, eligible: false, missingPermissions: ["task:write"] }] };
    const user = setup([existing], []); mount();
    await user.click(await screen.findByRole("button", { name: "Edit team My team" }));
    await waitFor(() => expect(screen.getByLabelText("Team name")).toBeEnabled());
    const selected = role("Development").getByRole("button", { name: "Remove Reader" });
    expect(selected).toBeInTheDocument();
    expect(selected).toHaveAccessibleDescription(/Missing permissions: task:write/);
    await user.click(selected);
    expect(selected).not.toBeInTheDocument();
  });

  it.each(["network", "validation"])("preserves all input on %s save errors and supports retry", async (failure) => {
    const user = setup(); mount(); await create(user);
    await user.type(screen.getByLabelText("Team name"), "Keep name");
    await user.type(screen.getByLabelText("Description (optional)"), "Keep description");
    await addAgent(user, "Product", "Alice");
    if (failure === "network") authFetch.mockRejectedValueOnce(new Error("offline"));
    else authFetch.mockResolvedValueOnce(fail("VALIDATION_ERROR", { members: [{ role: "product", agentUuid: capable.uuid, missingPermissions: ["idea:write"] }] }));
    await user.click(screen.getByRole("button", { name: "Save team" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/input is preserved/);
    if (failure === "validation") expect(alert).toHaveTextContent("Alice · Product: Missing permissions: idea:write");
    expect(screen.getByLabelText("Team name")).toHaveValue("Keep name");
    expect(screen.getByLabelText("Description (optional)")).toHaveValue("Keep description");
    expect(role("Product").getByRole("button", { name: "Remove Alice" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save team" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(writes()).toHaveLength(2);
  });

  it("offers retry for list and candidate failures without showing a false empty state", async () => {
    const user = setup(); authFetch.mockResolvedValueOnce(fail()); mount();
    expect(await screen.findByRole("alert")).toHaveTextContent("request failed");
    expect(screen.queryByText("No teams yet")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText("No teams yet");
    authFetch.mockRejectedValueOnce(new Error("offline"));
    await user.click(screen.getByRole("button", { name: "Create team" }));
    const dialog = within(screen.getByRole("dialog"));
    await dialog.findByRole("alert");
    expect(dialog.getByRole("button", { name: "Save team" })).toBeDisabled();
    expect(dialog.queryByText(/You have no agents yet/)).not.toBeInTheDocument();
    await user.click(dialog.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(dialog.getByLabelText("Team name")).toBeEnabled());
    expect(role("Product").getByRole("combobox")).toBeEnabled();
  });

  it("disables newly invalid choices after write-time permission drift without discarding form input", async () => {
    const user = setup(); mount(); await create(user);
    await user.type(screen.getByLabelText("Team name"), "Permission drift");
    await addAgent(user, "Product", "Alice");
    const selection = role("Product").getByRole("button", { name: "Remove Alice" });
    authFetch.mockResolvedValueOnce(fail("VALIDATION_ERROR", { members: [{ role: "product", agentUuid: capable.uuid, missingPermissions: ["idea:write"] }] }));
    await user.click(screen.getByRole("button", { name: "Save team" }));
    await screen.findByRole("alert");
    expect(selection).toBeInTheDocument();
    expect(selection).toHaveAccessibleDescription("Missing permissions: idea:write");
    await user.click(selection);
    expect(selection).not.toBeInTheDocument();
    const picker = await openPicker(user, "Product");
    expect(picker.getByRole("option", { name: /Alice/ })).toHaveAttribute("aria-disabled", "true");
    await user.keyboard("{Escape}");
    expect(screen.getByLabelText("Team name")).toHaveValue("Permission drift");
    await user.click(screen.getByRole("button", { name: "Save team" }));
    await waitFor(() => expect(writes()).toHaveLength(2));
    expect(JSON.parse(writes()[1][1].body).members).toEqual([]);
  });

  it("does not edit stale list data when the fresh detail request fails", async () => {
    const user = setup([team]); mount();
    await screen.findByRole("button", { name: "Edit team My team" });
    authFetch.mockImplementationOnce(async () => ok([reader]));
    authFetch.mockResolvedValueOnce(fail("NOT_FOUND"));
    await user.click(screen.getByRole("button", { name: "Edit team My team" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("no longer available");
    expect(screen.getByRole("button", { name: "Save team" })).toBeDisabled();
    expect(screen.getByLabelText("Team name")).toBeDisabled();
    authFetch.mockResolvedValueOnce(ok([reader]));
    authFetch.mockResolvedValueOnce(ok({ ...team, name: "Fresh name", description: "Fresh description" }));
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByLabelText("Team name")).toBeEnabled());
    expect(screen.getByLabelText("Team name")).toHaveValue("Fresh name");
    expect(screen.getByLabelText("Description (optional)")).toHaveValue("Fresh description");
    const picker = await openPicker(user, "Product");
    expect(picker.getByRole("option", { name: /Reader/ })).toHaveAttribute("aria-disabled", "true");
  });

  it("requires deletion confirmation, preserves the confirmation on errors, and refreshes after retry", async () => {
    const user = setup([team]); mount();
    await user.click(await screen.findByRole("button", { name: "Delete team My team" }));
    expect(writes()).toHaveLength(0);
    let dialog = within(screen.getByRole("alertdialog"));
    expect(dialog.getByText(/Your agents will not be deleted/)).toBeInTheDocument();
    await user.click(dialog.getByRole("button", { name: "Cancel" }));
    expect(writes()).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Delete team My team" }));
    dialog = within(screen.getByRole("alertdialog"));
    authFetch.mockResolvedValueOnce(fail());
    await user.click(dialog.getByRole("button", { name: "Confirm deletion" }));
    expect(await dialog.findByRole("alert")).toHaveTextContent("request failed");
    await user.click(dialog.getByRole("button", { name: "Confirm deletion" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(writes().map(([url, init]) => [url, init.method])).toEqual([[`/api/agent-teams/${team.uuid}`, "DELETE"], [`/api/agent-teams/${team.uuid}`, "DELETE"]]);
    expect(screen.getByText("Team deleted. Your agents are unchanged.")).toBeInTheDocument();
  });

  it("blocks duplicate saves and dismissal while the request is pending", async () => {
    const user = setup(); mount(); await create(user);
    await user.type(screen.getByLabelText("Team name"), "Slow save");
    let resolveSave!: (response: Response) => void;
    authFetch.mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveSave = resolve; }));
    await user.click(screen.getByRole("button", { name: "Save team" }));
    expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    fireEvent.submit(screen.getByLabelText("Team name").closest("form")!);
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(writes()).toHaveLength(1);
    resolveSave(ok(team));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("supports keyboard selection and Chinese labels with the same message keys", async () => {
    const user = setup(); mount("zh");
    expect(await screen.findByText("暂无团队")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "创建团队" }));
    await waitFor(() => expect(screen.getByLabelText("团队名称")).toBeEnabled());
    role("产品").getByRole("combobox").focus();
    await user.keyboard("{Enter}");
    await screen.findByRole("listbox");
    await user.keyboard("b{Enter}");
    expect(role("产品").getByRole("button", { name: "移除 Bob" })).toBeInTheDocument();
    const picker = await openPicker(user, "开发");
    expect(picker.getByRole("option", { name: /Reader/ })).toHaveAccessibleDescription("缺少权限：task:write");
    await user.keyboard("{Escape}");
    expect(Object.keys(zh.settings.teams).sort()).toEqual(Object.keys(en.settings.teams).sort());
    expect(screen.getByRole("button", { name: "保存团队" })).toBeDisabled();
  });
});
