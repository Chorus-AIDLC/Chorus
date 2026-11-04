// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../../../../messages/en.json";
import zh from "../../../../messages/zh.json";
import { AGENT_TEAM_ROLE_DEFINITIONS } from "@/lib/agent-team-roles";
import type { AgentTeamCandidateDto, AgentTeamDto } from "@/types/agent-team";

const { authFetch, toastSuccess } = vi.hoisted(() => ({ authFetch: vi.fn(), toastSuccess: vi.fn() }));
vi.mock("@/lib/auth-client", () => ({ authFetch }));
vi.mock("sonner", () => ({ toast: { success: toastSuccess } }));
import { ProjectTeamTab } from "../project-team-tab";
import { ProjectAccessProvider } from "@/contexts/project-access-context";
import type { ProjectAgentTeamDto } from "@/types/project-agent-team";
import ja from "../../../../messages/ja.json";
import ko from "../../../../messages/ko.json";

const capable: AgentTeamCandidateDto = { uuid: "agent-one", name: "Alice", effectivePermissions: [...AGENT_TEAM_ROLE_DEFINITIONS.lead.requiredPermissions] };
const second: AgentTeamCandidateDto = { ...capable, uuid: "agent-two", name: "Bob" };
const reader: AgentTeamCandidateDto = { uuid: "agent-reader", name: "Reader", effectivePermissions: [...AGENT_TEAM_ROLE_DEFINITIONS.review.requiredPermissions] };
const team: AgentTeamDto = { uuid: "team-one", companyUuid: "company", ownerUuid: "owner", name: "My team", description: "Personal template", createdAt: "2026-10-23T00:00:00Z", updatedAt: "2026-10-23T00:00:00Z", members: [] };

function ok(data: unknown) { return new Response(JSON.stringify({ success: true, data })); }
function fail(code = "INTERNAL_ERROR", details?: unknown) { return new Response(JSON.stringify({ success: false, error: { code, message: "Server message", details } }), { status: code === "VALIDATION_ERROR" ? 422 : 500 }); }
function writes() { return authFetch.mock.calls.filter(([, init]) => init?.method); }
function role(name: string) { return within(screen.getByRole("group", { name })); }

async function openRoleActions(user: ReturnType<typeof userEvent.setup>, roleName: string) {
  await user.click(role(roleName).getByRole("button", { name: `${roleName} actions` }));
  return within(await screen.findByRole("menu"));
}
async function roleAction(user: ReturnType<typeof userEvent.setup>, roleName: string, action: string) {
  const menu = await openRoleActions(user, roleName);
  await user.click(menu.getByRole("menuitem", { name: action }));
}

beforeEach(() => {
  authFetch.mockReset();
  toastSuccess.mockReset();
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
  return render(<NextIntlClientProvider locale={locale} messages={{ en, zh, ja, ko }[locale]}><ProjectAccessProvider accessLevel={accessLevel}><ProjectTeamTab projectUuid="project-one" /></ProjectAccessProvider></NextIntlClientProvider>);
}

async function selectProjectLead(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "Hand off…" }));
  expect(screen.getByRole("button", { name: "Preview handoff" })).toBeDisabled();
  expect(screen.queryByRole("button", { name: "Confirm Idea handoff" })).not.toBeInTheDocument();
  const trigger = await screen.findByRole("combobox", { name: "Choose a lead explicitly…" });
  trigger.focus();
  await user.keyboard("{Enter}");
  await user.click(within(await screen.findByRole("listbox")).getByRole("option", { name: /Alice/ }));
}

describe("personal project team controls", () => {
  it.each(["en", "zh", "ja", "ko"] as const)("shows localized role descriptions alongside empty/member state and a ghost-destructive unbind action (%s)", async (locale) => {
    setupProject();
    mountProject("editor", locale);
    const messages = { en, zh, ja, ko }[locale];
    for (const labels of Object.values(messages.settings.teams.roles)) {
      const row = within(await screen.findByRole("group", { name: labels.name }));
      expect(row.getByText(labels.description)).toHaveAttribute("title", labels.description);
    }
    expect(role(messages.settings.teams.roles.product.name).getByText(messages.projectTeam.emptyRole)).toBeInTheDocument();
    expect(role(messages.settings.teams.roles.lead.name).getByText("Alice")).toBeInTheDocument();
    const unbind = screen.getByRole("button", { name: messages.projectTeam.unbind });
    expect(unbind).toHaveAttribute("data-variant", "ghost");
    expect(unbind).toHaveClass("text-destructive", "hover:bg-destructive/10", "hover:text-destructive", "dark:hover:bg-destructive/20");
  });

  it.each([false, true])("shows overridden badges after editing a role (frozen=%s)", async (frozen) => {
    const user = setupProject({ ...projectTeam, frozen, templateUuid: frozen ? null : team.uuid });
    mountProject();
    const lead = within(await screen.findByRole("group", { name: "Lead" }));
    expect(lead.getByText(frozen ? "Frozen snapshot" : "Inherited")).toBeInTheDocument();
    await user.click(lead.getByRole("button", { name: "Remove Alice" }));
    expect(lead.getByText("Overridden")).toBeInTheDocument();
    expect(lead.queryByText(frozen ? "Frozen snapshot" : "Inherited")).not.toBeInTheDocument();
    expect(role("Product").getByText(frozen ? "Frozen snapshot" : "Inherited")).toBeInTheDocument();
  });

  it("shows persisted frozen overrides ahead of snapshot badges", async () => {
    setupProject({ ...projectTeam, frozen: true, templateUuid: null, overrides: { lead: [] } });
    mountProject();
    const lead = within(await screen.findByRole("group", { name: "Lead" }));
    expect(lead.getByText("Overridden")).toBeInTheDocument();
    expect(lead.queryByText("Frozen snapshot")).not.toBeInTheDocument();
    expect(role("Product").getByText("Frozen snapshot")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save team" })).toBeDisabled();
  });

  it("adds a candidate through the role popover and saves the role override without changing inheritance elsewhere", async () => {
    const user = setupProject();
    mountProject();
    await screen.findByRole("group", { name: "Development" });
    await user.click(role("Development").getByRole("button", { name: "Add agent to Development" }));
    const picker = screen.getByRole("combobox", { name: "Add agent to Development" });
    picker.focus();
    await user.keyboard("{Enter}");
    await user.click(await screen.findByRole("option", { name: "Bob" }));
    expect(role("Development").getByText("Overridden")).toBeInTheDocument();
    expect(role("Lead").getByText("Inherited")).toBeInTheDocument();
    expect(role("Development").getByRole("button", { name: "Remove Bob" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Save team" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(JSON.parse(writes()[0][1].body)).toEqual({ templateUuid: team.uuid, overrides: { development: [second.uuid] } });
  });

  it("renders inline for viewers who can remove, clear and save but cannot hand off", async () => {
    const user = setupProject();
    mountProject("viewer");
    expect(await screen.findByText(/Viewers can configure/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Preview handoff" })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hand off…" })).toBeDisabled();
    await user.click(role("Lead").getByRole("button", { name: "Remove Alice" }));
    await roleAction(user, "Lead", "Reset inheritance");
    expect(role("Lead").getByText("Alice")).toBeInTheDocument();
    await roleAction(user, "Lead", "Empty role");
    expect(screen.getByRole("button", { name: "Save team" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Save team" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(JSON.parse(writes()[0][1].body)).toEqual({ templateUuid: team.uuid, overrides: { lead: [] } });
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith(en.projectTeam.saved));
    expect(screen.getByRole("button", { name: "Hand off…" })).toBeDisabled();
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
    expect(writes()[0][0]).toBe("/api/projects/project-one/team");
    expect(JSON.parse(writes()[0][1].body)).toEqual({ templateUuid: team.uuid, overrides: {} });
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith(en.projectTeam.saved));
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
    let product = within(await screen.findByRole("group", { name: "Product" }));
    expect(product.getByText("Inherited")).toBeInTheDocument();
    await roleAction(user, "Product", "Empty role");
    expect(product.getByText("Overridden")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save team" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(JSON.parse(writes()[0][1].body).overrides).toEqual({ product: [] });
    mounted.unmount();
    mountProject("viewer");
    product = within(await screen.findByRole("group", { name: "Product" }));
    expect(product.getByText("Overridden")).toBeInTheDocument();
    expect((await openRoleActions(user, "Product")).getByRole("menuitem", { name: "Empty role" })).toHaveAttribute("data-disabled");
    await user.keyboard("{Escape}");
    await roleAction(user, "Product", "Reset inheritance");
    expect(product.getByText("Inherited")).toBeInTheDocument();
    expect((await openRoleActions(user, "Product")).getByRole("menuitem", { name: "Empty role" })).not.toHaveAttribute("data-disabled");
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Save team" }));
    await waitFor(() => expect(writes()).toHaveLength(2));
    expect(JSON.parse(writes()[1][1].body)).toEqual({ templateUuid: team.uuid, overrides: {} });
  });

  it("retains failed-save edits, supports empty overrides and resets inheritance", async () => {
    const user = setupProject();
    mountProject();
    const lead = within(await screen.findByRole("group", { name: "Lead" }));
    await roleAction(user, "Lead", "Empty role");
    expect(lead.getByText("Overridden")).toBeInTheDocument();
    expect(lead.getByText(/No members/)).toBeInTheDocument();
    authFetch.mockResolvedValueOnce(fail("VALIDATION_ERROR"));
    await user.click(screen.getByRole("button", { name: "Save team" }));
    expect(await screen.findByText(/Check member permissions/)).toBeInTheDocument();
    expect(lead.getByText("Overridden")).toBeInTheDocument();
    expect(toastSuccess).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Save team" }));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith(en.projectTeam.saved));
    expect(writes()).toHaveLength(2);
    expect(writes()[1][1].body).toBe(writes()[0][1].body);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await roleAction(user, "Lead", "Reset inheritance");
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
    let development = within(await screen.findByRole("group", { name: "Development" }));
    expect(development.getByText("deleted-agent")).toBeInTheDocument();
    expect(development.getByRole("button", { name: /Remove.*deleted-agent/ })).toBeEnabled();
    if (frozen) {
      expect((await openRoleActions(user, "Development")).queryByRole("menuitem", { name: "Reset inheritance" })).not.toBeInTheDocument();
      await user.keyboard("{Escape}");
    }
    expect((await openRoleActions(user, "Development")).getByRole("menuitem", { name: "Empty role" })).not.toHaveAttribute("data-disabled");
    await user.keyboard("{Escape}");
    await roleAction(user, "Development", "Empty role");
    await user.click(screen.getByRole("button", { name: "Save team" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(JSON.parse(writes()[0][1].body)).toEqual({ templateUuid: saved.templateUuid, overrides: { development: [] } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Save team" })).toBeDisabled());
    mounted.unmount();
    mountProject();
    development = within(await screen.findByRole("group", { name: "Development" }));
    expect(development.getByText(/No members/)).toBeInTheDocument();
    expect((await openRoleActions(user, "Development")).getByRole("menuitem", { name: "Empty role" })).toHaveAttribute("data-disabled");
    await user.keyboard("{Escape}");
  });

  it("saves editable frozen snapshots with a null template and confirms unbinding", async () => {
    const user = setupProject({ ...projectTeam, templateUuid: null, frozen: true });
    mountProject();
    expect(await screen.findByText(/was deleted/)).toBeInTheDocument();
    expect(role("Lead").getByText("Frozen snapshot")).toBeInTheDocument();
    await roleAction(user, "Lead", "Empty role");
    expect(role("Lead").getByText("Overridden")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save team" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(JSON.parse(writes()[0][1].body)).toEqual({ templateUuid: null, overrides: { lead: [] } });
    await user.click(screen.getByRole("button", { name: "Unbind" }));
    const dialog = within(screen.getByRole("alertdialog"));
    expect(dialog.getByText(/Existing Idea assignments and all Tasks remain unchanged/)).toBeInTheDocument();
    expect(writes()).toHaveLength(1);
    await user.click(dialog.getByRole("button", { name: "Confirm unbind" }));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith(en.projectTeam.unbound));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(writes()[1][1].method).toBe("DELETE");
    expect(writes()[1][0]).toBe("/api/projects/project-one/team");
    expect(screen.getByText(en.projectTeam.empty)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Hand off…" })).not.toBeInTheDocument();
  });

  it("cancels unbinding without deleting or changing the team", async () => {
    const user = setupProject();
    mountProject("viewer");
    await user.click(await screen.findByRole("button", { name: "Unbind" }));
    const dialog = within(screen.getByRole("alertdialog"));
    expect(dialog.getByText(en.projectTeam.unbindDescription)).toBeInTheDocument();
    expect(writes()).toHaveLength(0);
    await user.click(dialog.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(writes()).toHaveLength(0);
    expect(role("Lead").getByText("Alice")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save team" })).toBeDisabled();
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("keeps the unbind dialog and team after DELETE fails, then permits retry", async () => {
    const user = setupProject();
    mountProject();
    await user.click(await screen.findByRole("button", { name: "Unbind" }));
    const dialogElement = screen.getByRole("alertdialog");
    const dialog = within(dialogElement);
    authFetch.mockResolvedValueOnce(fail());
    await user.click(dialog.getByRole("button", { name: "Confirm unbind" }));
    expect(await dialog.findByRole("alert")).toHaveTextContent(en.projectTeam.failed);
    expect(screen.getByRole("alertdialog")).toBe(dialogElement);
    expect(dialog.getByRole("button", { name: "Confirm unbind" })).toBeEnabled();
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(toastSuccess).not.toHaveBeenCalled();
    await user.click(dialog.getByRole("button", { name: "Confirm unbind" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(writes().map(([url, init]) => [url, init.method])).toEqual([
      ["/api/projects/project-one/team", "DELETE"],
      ["/api/projects/project-one/team", "DELETE"],
    ]);
    expect(screen.getByText(en.projectTeam.empty)).toBeInTheDocument();
    expect(toastSuccess).toHaveBeenCalledExactlyOnceWith(en.projectTeam.unbound);
  });

  it("disables handoff for dirty edits and failed saves until saving succeeds", async () => {
    const user = setupProject();
    mountProject();
    expect(await screen.findByRole("button", { name: "Hand off…" })).toBeEnabled();
    await roleAction(user, "Product", "Empty role");
    expect(screen.getByRole("button", { name: "Hand off…" })).toBeDisabled();
    expect(screen.getByText(en.projectTeam.saveFirst)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Hand off…" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(writes()).toHaveLength(0);
    authFetch.mockResolvedValueOnce(fail());
    await user.click(screen.getByRole("button", { name: "Save team" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(en.projectTeam.failed);
    expect(screen.getByRole("button", { name: "Hand off…" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Save team" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Hand off…" })).toBeEnabled());
    expect(screen.queryByText(en.projectTeam.saveFirst)).not.toBeInTheDocument();
    expect(writes().map(([, init]) => init.method)).toEqual(["PUT", "PUT"]);
  });

  it.each(["Cancel", "Escape"])("discards the preview and lead after closing with %s and reopening handoff", async (dismissal) => {
    const user = setupProject();
    mountProject();
    await selectProjectLead(user);
    await user.click(screen.getByRole("button", { name: "Preview handoff" }));
    await screen.findByRole("link", { name: "Own unfinished idea" });
    expect(screen.getByRole("button", { name: "Confirm Idea handoff" })).toBeEnabled();
    if (dismissal === "Escape") await user.keyboard("{Escape}");
    else await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(writes()).toHaveLength(1);
    expect(toastSuccess).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Hand off…" }));
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByRole("combobox", { name: "Choose a lead explicitly…" })).not.toHaveTextContent("Alice");
    expect(dialog.queryByRole("region", { name: "Preview handoff" })).not.toBeInTheDocument();
    expect(dialog.queryByRole("link", { name: "Own unfinished idea" })).not.toBeInTheDocument();
    expect(dialog.queryByRole("button", { name: "Confirm Idea handoff" })).not.toBeInTheDocument();
    expect(dialog.getByRole("button", { name: "Preview handoff" })).toBeDisabled();
    expect(writes()).toHaveLength(1);
  });

  it("warns about a removed previous lead despite an eligible replacement, requiring explicit preview and confirm", async () => {
    const user = setupProject({ ...projectTeam, handoffWarning: { agentUuid: second.uuid, agentName: second.name, reason: "removed_from_lead" } });
    mountProject();
    expect(await screen.findByText(/Previous handoff recipient: Bob/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Preview handoff" })).not.toBeInTheDocument();
    await selectProjectLead(user);
    await user.click(screen.getByRole("button", { name: "Preview handoff" }));
    expect(await screen.findByRole("link", { name: "Own unfinished idea" })).toHaveAttribute("href", "/projects/project-one/dashboard/idea-one");
    expect(JSON.parse(writes()[0][1].body)).toEqual({ leadAgentUuid: capable.uuid, preview: true });
    expect(writes()[0][0]).toBe("/api/projects/project-one/team/handoff");
    expect(writes()[0][1].method).toBe("POST");
    expect(toastSuccess).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Confirm Idea handoff" }));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith(en.projectTeam.handedOff));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
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
    expect(writes().map(([, init]) => JSON.parse(init.body))).toEqual([
      { leadAgentUuid: capable.uuid, preview: true },
      { leadAgentUuid: capable.uuid, confirmationToken: "preview-token" },
      { leadAgentUuid: capable.uuid, preview: true },
    ]);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("shows eligibility separately from offline presence and prevents ineligible selection", async () => {
    const user = setupProject({ ...projectTeam, roles: { ...projectTeam.roles, lead: [{ ...projectTeam.roles.lead[0], eligible: false, missingPermissions: ["idea:admin"], activeCount: 2 }] } });
    mountProject();
    expect(await screen.findByText("Missing permissions: idea:admin")).toBeInTheDocument();
    expect(screen.getByText("Offline · 2 active / queued")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Hand off…" }));
    screen.getByRole("combobox", { name: "Choose a lead explicitly…" }).focus();
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("option", { name: /Alice/ })).toHaveAttribute("aria-disabled", "true");
    await user.click(screen.getByRole("option", { name: /Alice/ }));
    await user.keyboard("{Escape}");
    expect(screen.getByRole("button", { name: "Preview handoff" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Confirm Idea handoff" })).not.toBeInTheDocument();
    expect(writes()).toHaveLength(0);
  });

  it("does not allow preview or confirmation when there are no leads", async () => {
    const user = setupProject({ ...projectTeam, roles: { ...projectTeam.roles, lead: [] } });
    mountProject();
    await user.click(await screen.findByRole("button", { name: "Hand off…" }));
    screen.getByRole("combobox", { name: "Choose a lead explicitly…" }).focus();
    await user.keyboard("{Enter}");
    expect(await screen.findByText(en.projectTeam.noLead)).toBeInTheDocument();
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("button", { name: "Preview handoff" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Confirm Idea handoff" })).not.toBeInTheDocument();
    expect(writes()).toHaveLength(0);
  });

  it("preserves the lead selection after preview failure and permits explicit retry", async () => {
    const user = setupProject();
    mountProject();
    await selectProjectLead(user);
    authFetch.mockResolvedValueOnce(fail());
    await user.click(screen.getByRole("button", { name: "Preview handoff" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(en.projectTeam.failed);
    expect(screen.getByRole("combobox", { name: "Choose a lead explicitly…" })).toHaveTextContent("Alice");
    expect(screen.queryByRole("button", { name: "Confirm Idea handoff" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Preview handoff" }));
    expect(await screen.findByRole("button", { name: "Confirm Idea handoff" })).toBeEnabled();
    expect(writes()).toHaveLength(2);
    expect(writes()[1][1].body).toBe(writes()[0][1].body);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each(["en", "zh", "ja", "ko"] as const)("renders %s and keeps catalog keys in parity", async (locale) => {
    const user = setupProject();
    mountProject("editor", locale);
    await user.click(await screen.findByRole("button", { name: { en, zh, ja, ko }[locale].projectTeam.handoffAction }));
    expect(await screen.findByRole("heading", { name: { en, zh, ja, ko }[locale].projectTeam.handoff })).toBeInTheDocument();
    expect(Object.keys({ en, zh, ja, ko }[locale].projectTeam).sort()).toEqual(Object.keys(en.projectTeam).sort());
    expect(Object.keys({ en, zh, ja, ko }[locale].projectTeam.warningReasons).sort()).toEqual(Object.keys(en.projectTeam.warningReasons).sort());
  });
});
