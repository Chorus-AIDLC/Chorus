// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../../../../../../../messages/en.json";
import { ProjectAccessProvider, type ProjectAccessLevel } from "@/contexts/project-access-context";
import { ProjectSettingsModal } from "../project-settings-modal";

const { authFetch, query, toastSuccess } = vi.hoisted(() => ({ authFetch: vi.fn(), query: { value: "settings=team" }, toastSuccess: vi.fn() }));
vi.mock("@/lib/auth-client", () => ({ authFetch }));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(query.value) }));
vi.mock("@/hooks/use-progress-router", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("../../actions", () => ({ updateProjectAction: vi.fn(), deleteProjectAction: vi.fn() }));
vi.mock("@/components/project-agent-cwd-settings", () => ({ ProjectAgentCwdSettings: () => <div>cwd settings</div> }));
vi.mock("../project-access-tab", () => ({ ProjectAccessTab: () => <div>access settings</div> }));
vi.mock("@/components/ui/agent-avatar", () => ({ AgentAvatar: () => <span /> }));
vi.mock("sonner", () => ({ toast: { success: toastSuccess } }));

const team = {
  projectUuid: "project-one", templateUuid: "template-one", templateName: "Personal team", frozen: false, overrides: {},
  roles: { product: [], development: [], review: [], lead: [{ agentUuid: "agent-one", agentName: "Alice", eligible: true, hasProjectAccess: true, missingPermissions: [], online: true, activeCount: 0 }] },
};

function mount(accessLevel: ProjectAccessLevel = "editor") {
  return render(<NextIntlClientProvider locale="en" messages={en}><ProjectAccessProvider accessLevel={accessLevel}>
    <ProjectSettingsModal projectUuid="project-one" projectName="Project One" projectDescription={null} />
  </ProjectAccessProvider></NextIntlClientProvider>);
}

beforeEach(() => {
  query.value = "settings=team";
  toastSuccess.mockReset();
  authFetch.mockReset();
  authFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    const data = url.endsWith("/candidates") ? [] : url === "/api/agent-teams" ? [{ uuid: "template-one", name: "Personal team", members: [{ role: "lead", agentUuid: "agent-one" }] }] : { team: init?.method === "PUT" ? { ...team, ...JSON.parse(init.body as string) } : team };
    return new Response(JSON.stringify({ success: true, data }));
  });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true, data: { visibility: "private", accessLevel: "viewer" } }))));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function dirtyTeam(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "Remove Alice" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Save team" })).toBeEnabled());
}

describe("Project Settings Team integration", () => {
  it("opens the team deep link with three tabs and loads data only upon activation", async () => {
    query.value = "settings=agent-cwds";
    const user = userEvent.setup();
    mount();
    expect(screen.getAllByRole("tab")).toHaveLength(3);
    expect(screen.getByRole("tab", { name: "General" })).toHaveAttribute("aria-selected", "true");
    expect(authFetch).not.toHaveBeenCalled();
    await user.click(screen.getByRole("tab", { name: "Team" }));
    expect(await screen.findByRole("group", { name: "Lead" })).toBeInTheDocument();
    expect(authFetch).toHaveBeenCalledWith("/api/projects/project-one/team", expect.anything());
  });

  it.each(["viewer", "editor"] as const)("lets a private project's non-admin %s save personal overrides independently of the access lock", async (accessLevel) => {
    const user = userEvent.setup();
    mount(accessLevel);
    expect(screen.getByRole("tab", { name: "Team" })).toHaveAttribute("aria-selected", "true");
    await dirtyTeam(user);
    if (accessLevel === "viewer") expect(screen.getByText(en.projectTeam.viewer)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hand off…" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Save team" }));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith(en.projectTeam.saved));
    expect(authFetch).toHaveBeenCalledWith("/api/projects/project-one/team", expect.objectContaining({ method: "PUT", body: JSON.stringify({ templateUuid: "template-one", overrides: { lead: [] } }) }));
    await user.click(screen.getByRole("tab", { name: "General" }));
    expect(await screen.findByTestId("settings-locked-hint")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Project One")).toBeDisabled();
  });

  it("guards tab switches, keeps edits on cancel and reloads saved state after discard", async () => {
    const user = userEvent.setup();
    mount();
    await dirtyTeam(user);
    await user.click(screen.getByRole("tab", { name: "General" }));
    expect(screen.getByRole("alertdialog", { name: en.projectTeam.discardTitle })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: en.projectTeam.keepEditing }));
    expect(screen.getByRole("tab", { name: "Team" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByText("Alice")).not.toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Access" }));
    await user.click(screen.getByRole("button", { name: en.projectTeam.discard }));
    expect(screen.getByRole("tab", { name: "Access" })).toHaveAttribute("aria-selected", "true");
    await user.click(screen.getByRole("tab", { name: "Team" }));
    expect(await screen.findByText("Alice")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save team" })).toBeDisabled();
    expect(authFetch.mock.calls.filter(([, init]) => init?.method)).toHaveLength(0);
  });

  it("keeps settings open on the Team tab while a save is pending", async () => {
    const user = userEvent.setup();
    mount();
    await dirtyTeam(user);
    let finishSave!: (response: Response) => void;
    authFetch.mockImplementationOnce(() => new Promise<Response>((resolve) => { finishSave = resolve; }));
    await user.click(screen.getByRole("button", { name: "Save team" }));
    await user.click(screen.getByRole("tab", { name: "Access" }));
    expect(screen.getByRole("tab", { name: "Team" })).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    finishSave(new Response(JSON.stringify({ success: true, data: { team: { ...team, overrides: { lead: [] } } } })));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith(en.projectTeam.saved));
    await user.click(screen.getByRole("tab", { name: "Access" }));
    expect(screen.getByRole("tab", { name: "Access" })).toHaveAttribute("aria-selected", "true");
  });

  it.each(["close", "escape"])("guards %s and discards changes before reopening", async (method) => {
    const user = userEvent.setup();
    mount();
    await dirtyTeam(user);
    if (method === "close") await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close" }));
    else await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: en.projectTeam.keepEditing }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: en.projectTeam.discard }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Settings" }));
    expect(await screen.findByText("Alice")).toBeInTheDocument();
  });
});
