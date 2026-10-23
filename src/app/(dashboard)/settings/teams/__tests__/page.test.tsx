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
import { ProjectTeamEditor, ProjectTeamSettings } from "@/components/project-team-settings";
import { ProjectAccessProvider } from "@/contexts/project-access-context";
import type { ProjectAgentTeamDto } from "@/types/project-agent-team";
import ja from "../../../../../../messages/ja.json";
import ko from "../../../../../../messages/ko.json";

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

const projectTeam: ProjectAgentTeamDto = {
  projectUuid: "project-one", templateUuid: team.uuid, templateName: team.name, frozen: false, revision: 1, overrides: {}, myRoles: [], handoffWarning: null,
  roles: { product: [], development: [], review: [], lead: [{ agentUuid: capable.uuid, agentName: capable.name, eligible: true, missingPermissions: [], hasProjectAccess: true, online: false, activeCount: 0 }] },
};
const projectTemplate = { ...team, members: [{ role: "lead", agentUuid: capable.uuid, agentName: capable.name, eligible: true, missingPermissions: [] }] };

function setupProject(config: ProjectAgentTeamDto | null = projectTeam) {
  authFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === "PUT") return ok({ team: { ...projectTeam, ...config, ...JSON.parse(init.body as string) } });
    if (url.endsWith("/candidates")) return ok([capable, second, reader]);
    if (url === "/api/agent-teams") return ok([projectTemplate]);
    if (url.endsWith("/handoff")) return ok({ candidates: [{ uuid: "idea-one", title: "Own unfinished idea" }], count: 1, confirmationToken: "preview-token", expiresAt: "2099-01-01T00:00:00Z" });
    return ok({ team: config });
  });
  return userEvent.setup();
}

function mountProject(accessLevel: "viewer" | "editor" = "editor", locale: "en" | "zh" | "ja" | "ko" = "en") {
  return render(<NextIntlClientProvider locale={locale} messages={{ en, zh, ja, ko }[locale]}><ProjectAccessProvider accessLevel={accessLevel}><ProjectTeamEditor projectUuid="project-one" onClose={vi.fn()} /></ProjectAccessProvider></NextIntlClientProvider>);
}

async function selectProjectLead(user: ReturnType<typeof userEvent.setup>) {
  const trigger = await screen.findByRole("combobox", { name: "Choose a lead explicitly…" });
  trigger.focus();
  await user.keyboard("{Enter}");
  await user.click(within(await screen.findByRole("listbox")).getByRole("option", { name: /Alice/ }));
}

describe("personal project team controls", () => {
  it("exposes a separate viewer-accessible entry and does not permit handoff", async () => {
    const user = setupProject();
    render(<NextIntlClientProvider locale="en" messages={en}><ProjectAccessProvider accessLevel="viewer"><ProjectTeamSettings projectUuid="project-one" /></ProjectAccessProvider></NextIntlClientProvider>);
    await user.click(screen.getByRole("button", { name: "My project team" }));
    expect(await screen.findByText(/Viewers can configure/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Preview handoff" })).not.toBeInTheDocument();
    const lead = within(screen.getByRole("region", { name: "Lead" }));
    await user.click(lead.getByRole("button", { name: "Empty role" }));
    expect(screen.getByRole("button", { name: "Save team" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Save team" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(JSON.parse(writes()[0][1].body)).toEqual({ templateUuid: team.uuid, overrides: { lead: [] } });
  });

  it("binds an empty personal team without automatic assignment", async () => {
    const user = setupProject(null);
    mountProject();
    expect(await screen.findByText(/No team is bound/)).toBeInTheDocument();
    screen.getByRole("combobox", { name: "Personal template" }).focus();
    await user.keyboard("{Enter}");
    await user.click(await screen.findByRole("option", { name: "My team" }));
    await user.click(screen.getByRole("button", { name: "Save team" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0][1].method).toBe("PUT");
  });

  it("explicitly empties an already-empty inherited role with no candidates and restores inheritance", async () => {
    const user = setupProject();
    const fetch = authFetch.getMockImplementation()!;
    let saved = projectTeam;
    authFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/candidates")) return ok([]);
      if (init?.method === "PUT") {
        saved = { ...saved, ...JSON.parse(init.body as string) };
        return ok({ team: saved });
      }
      if (url.endsWith("/team")) return ok({ team: saved });
      return fetch(url, init);
    });
    const mounted = mountProject("viewer");
    let product = within(await screen.findByRole("region", { name: "Product" }));
    expect(product.getByText("Inherited")).toBeInTheDocument();
    await user.click(product.getByRole("button", { name: "Empty role" }));
    expect(product.getByText("Overridden")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save team" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(JSON.parse(writes()[0][1].body).overrides).toEqual({ product: [] });
    mounted.unmount();
    mountProject("viewer");
    product = within(await screen.findByRole("region", { name: "Product" }));
    expect(product.getByText("Overridden")).toBeInTheDocument();
    expect(product.getByRole("button", { name: "Empty role" })).toBeDisabled();
    await user.click(product.getByRole("button", { name: "Reset inheritance" }));
    expect(product.getByText("Inherited")).toBeInTheDocument();
    expect(product.getByRole("button", { name: "Empty role" })).toBeEnabled();
  });

  it("retains failed-save edits, supports empty overrides and resets inheritance", async () => {
    const user = setupProject();
    mountProject();
    const lead = within(await screen.findByRole("region", { name: "Lead" }));
    await user.click(lead.getByRole("button", { name: "Empty role" }));
    expect(lead.getByText("Overridden")).toBeInTheDocument();
    expect(lead.getByText(/No members/)).toBeInTheDocument();
    authFetch.mockResolvedValueOnce(fail("VALIDATION_ERROR"));
    await user.click(screen.getByRole("button", { name: "Save team" }));
    expect(await screen.findByText(/Check member permissions/)).toBeInTheDocument();
    expect(lead.getByText("Overridden")).toBeInTheDocument();
    await user.click(lead.getByRole("button", { name: "Reset inheritance" }));
    expect(lead.getByText("Inherited")).toBeInTheDocument();
    expect(lead.getByText("Alice")).toBeInTheDocument();
  });

  it.each([true, false])("shows and clears a deleted override immediately with no candidates (frozen=%s)", async (frozen) => {
    let saved: ProjectAgentTeamDto = {
      ...projectTeam, templateUuid: frozen ? null : projectTeam.templateUuid, frozen,
      overrides: { development: ["deleted-agent"] },
      roles: { product: [], development: [], review: [], lead: [] },
    };
    const user = setupProject(saved);
    authFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/agent-teams" || url.endsWith("/candidates")) return ok([]);
      if (init?.method === "PUT") saved = { ...saved, ...JSON.parse(init.body as string) };
      return ok({ team: saved });
    });
    const mounted = mountProject();
    let development = within(await screen.findByRole("region", { name: "Development" }));
    expect(development.getByText("deleted-agent")).toBeInTheDocument();
    expect(development.getByRole("button", { name: /Remove.*deleted-agent/ })).toBeEnabled();
    if (frozen) expect(development.queryByRole("button", { name: "Reset inheritance" })).not.toBeInTheDocument();
    expect(development.getByRole("button", { name: "Empty role" })).toBeEnabled();
    await user.click(development.getByRole("button", { name: "Empty role" }));
    await user.click(screen.getByRole("button", { name: "Save team" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(JSON.parse(writes()[0][1].body)).toEqual({ templateUuid: saved.templateUuid, overrides: { development: [] } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Save team" })).toBeDisabled());
    mounted.unmount();
    mountProject();
    development = within(await screen.findByRole("region", { name: "Development" }));
    expect(development.getByText(/No members/)).toBeInTheDocument();
    expect(development.getByRole("button", { name: "Empty role" })).toBeDisabled();
  });

  it("saves editable frozen snapshots with a null template and confirms unbinding", async () => {
    const user = setupProject({ ...projectTeam, templateUuid: null, frozen: true });
    mountProject();
    expect(await screen.findByText(/was deleted/)).toBeInTheDocument();
    await user.click(within(screen.getByRole("region", { name: "Lead" })).getByRole("button", { name: "Empty role" }));
    await user.click(screen.getByRole("button", { name: "Save team" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(JSON.parse(writes()[0][1].body)).toEqual({ templateUuid: null, overrides: { lead: [] } });
    await user.click(screen.getByRole("button", { name: "Unbind" }));
    expect(screen.getByText(/Existing Idea assignments and all Tasks remain unchanged/)).toBeInTheDocument();
    expect(writes()).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Confirm unbind" }));
    expect(await screen.findByText(/Personal team unbound/)).toBeInTheDocument();
    expect(writes()[1][1].method).toBe("DELETE");
  });

  it("warns about a removed previous lead despite an eligible replacement, requiring explicit preview and confirm", async () => {
    const user = setupProject({ ...projectTeam, handoffWarning: { agentUuid: second.uuid, agentName: second.name, reason: "removed_from_lead" } });
    mountProject();
    expect(await screen.findByText(/Previous handoff recipient: Bob/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Preview handoff" })).toBeDisabled();
    await selectProjectLead(user);
    await user.click(screen.getByRole("button", { name: "Preview handoff" }));
    expect(await screen.findByRole("link", { name: "Own unfinished idea" })).toHaveAttribute("href", "/projects/project-one/dashboard/idea-one");
    expect(JSON.parse(writes()[0][1].body)).toEqual({ leadAgentUuid: capable.uuid, preview: true });
    await user.click(screen.getByRole("button", { name: "Confirm Idea handoff" }));
    expect(await screen.findByText(/Idea handoff confirmed/)).toBeInTheDocument();
    expect(JSON.parse(writes()[1][1].body)).toEqual({ leadAgentUuid: capable.uuid, confirmationToken: "preview-token" });
    expect(screen.queryByText(/Previous handoff recipient/)).not.toBeInTheDocument();
  });

  it("rejects a stale preview locally until explicitly refreshed, preserving lead selection", async () => {
    const user = setupProject();
    mountProject();
    await selectProjectLead(user);
    await user.click(screen.getByRole("button", { name: "Preview handoff" }));
    await screen.findByRole("button", { name: "Confirm Idea handoff" });
    authFetch.mockResolvedValueOnce(fail("CONFLICT"));
    await user.click(screen.getByRole("button", { name: "Confirm Idea handoff" }));
    expect(await screen.findByText(/This preview is stale/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Confirm Idea handoff" })).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Choose a lead explicitly…" })).toHaveTextContent("Alice");
    await user.click(screen.getByRole("button", { name: "Preview handoff" }));
    expect(await screen.findByRole("button", { name: "Confirm Idea handoff" })).toBeEnabled();
  });

  it("shows eligibility separately from offline presence and prevents ineligible selection", async () => {
    const user = setupProject({ ...projectTeam, roles: { ...projectTeam.roles, lead: [{ ...projectTeam.roles.lead[0], eligible: false, missingPermissions: ["idea:admin"], activeCount: 2 }] } });
    mountProject();
    expect(await screen.findByText("Missing permissions: idea:admin")).toBeInTheDocument();
    expect(screen.getByText("Offline · 2 active / queued")).toBeInTheDocument();
    screen.getByRole("combobox", { name: "Choose a lead explicitly…" }).focus();
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("option", { name: /Alice/ })).toHaveAttribute("aria-disabled", "true");
    await user.keyboard("{Escape}");
    expect(writes()).toHaveLength(0);
  });

  it.each(["en", "zh", "ja", "ko"] as const)("renders %s and keeps catalog keys in parity", async (locale) => {
    setupProject();
    mountProject("editor", locale);
    expect(await screen.findByRole("heading", { name: { en, zh, ja, ko }[locale].projectTeam.handoff })).toBeInTheDocument();
    expect(Object.keys({ en, zh, ja, ko }[locale].projectTeam).sort()).toEqual(Object.keys(en.projectTeam).sort());
    expect(Object.keys({ en, zh, ja, ko }[locale].projectTeam.warningReasons).sort()).toEqual(Object.keys(en.projectTeam.warningReasons).sort());
  });
});

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
    await user.click(dialog.getByLabelText("Team name"));
    await user.paste("  Delivery  ");
    await user.click(dialog.getByLabelText("Description (optional)"));
    await user.paste("  My agents  ");
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
    await user.click(screen.getByLabelText("Team name"));
    await user.paste("Keep name");
    await user.click(screen.getByLabelText("Description (optional)"));
    await user.paste("Keep description");
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
    await user.click(screen.getByLabelText("Team name"));
    await user.paste("Permission drift");
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
    expect(dialog.getByText(/Bound project teams retain their latest effective members as frozen snapshots/)).toBeInTheDocument();
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
