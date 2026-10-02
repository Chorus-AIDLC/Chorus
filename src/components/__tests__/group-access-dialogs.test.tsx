// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { authFetch, refresh, push } = vi.hoisted(() => ({
  authFetch: vi.fn(), refresh: vi.fn(), push: vi.fn(),
}));
vi.mock("@/lib/auth-client", () => ({ authFetch }));
vi.mock("@/hooks/use-progress-router", () => ({ useRouter: () => ({ refresh, push }) }));
vi.mock("next-intl", async () => {
  const en = (await import("../../../messages/en.json")).default;
  const { createTranslator } = await vi.importActual<typeof import("next-intl")>("next-intl");
  const cache = new Map();
  return { useTranslations: (namespace = "") => {
    if (!cache.has(namespace)) cache.set(namespace, createTranslator({
      locale: "en", messages: en, namespace: namespace ? namespace as keyof typeof en : undefined,
    }));
    return cache.get(namespace);
  } };
});

import { ManageProjectGroupDialog } from "../manage-project-group-dialog";
import { MoveProjectConfirmDialog } from "../move-project-confirm-dialog";
import { CreateProjectGroupDialog } from "../create-project-group-dialog";

const group = {
  uuid: "group", name: "Group", visibility: "public", accessLevel: "editor",
  explicitRole: null, canManage: true, canCreateProject: true, accessInitialized: true,
};
function ok(data: unknown) { return new Response(JSON.stringify({ success: true, data })); }
const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  authFetch.mockImplementation(async (_url, init) => init?.method === "PATCH" ? ok(group) : ok(group));
  fetchMock.mockResolvedValue(ok({ members: [], confirmationToken: "move-token", companyAccess: "unchanged", changes: [] }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); document.documentElement.classList.remove("dark"); });

function manage() {
  return render(<ManageProjectGroupDialog open onOpenChange={vi.fn()} groupUuid="group"
    groupName="Group" groupDescription={null} projectCount={2} onUpdated={vi.fn()} />);
}
function move(onConfirm = vi.fn().mockResolvedValue(undefined), onOpenChange = vi.fn(), targetGroupUuid: string | null = "target") {
  render(<MoveProjectConfirmDialog open onOpenChange={onOpenChange} projectUuid="project"
    projectName="Project" sourceGroupName="Source" targetGroupName="Target"
    targetGroupUuid={targetGroupUuid} onConfirm={onConfirm} />);
  return { onConfirm, onOpenChange };
}

describe("group access dialogs", () => {
  it("lets ordinary Public-group editors edit settings without member or visibility authority", async () => {
    manage();
    const input = await screen.findByDisplayValue("Group");
    await waitFor(() => expect(input).toBeEnabled());
    expect(screen.getByRole("radio", { name: /Public/ })).toBeDisabled();
    expect(screen.queryByText("Members")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Delete this group/ })).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "Renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(authFetch).toHaveBeenCalledWith("/api/project-groups/group", expect.objectContaining({
      method: "PATCH", body: JSON.stringify({ name: "Renamed", description: null }),
    })));
  });

  it("shows a group Viewer only the roster and read-only access", async () => {
    authFetch.mockResolvedValue(ok({ ...group, visibility: "private", accessLevel: "viewer", explicitRole: "viewer", canManage: false, accessInitialized: false }));
    fetchMock.mockResolvedValue(ok({ members: [{ uuid: "m", userUuid: "u", name: "Alice", role: "admin", createdAt: "now" }] }));
    manage();
    expect(await screen.findByText("Alice")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("Group")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save Changes" })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove Alice" })).not.toBeInTheDocument();
  });

  it("keeps Public-group explicit Viewer membership separate from the editor baseline", async () => {
    authFetch.mockResolvedValue(ok({ ...group, explicitRole: "viewer", accessInitialized: false }));
    fetchMock.mockResolvedValue(ok({ members: [{ uuid: "m", userUuid: "u", name: "Alice", role: "admin", createdAt: "now" }] }));
    manage();
    await screen.findByText("Alice");
    expect(screen.getByDisplayValue("Group")).toBeEnabled();
    expect(screen.getByRole("radio", { name: /^Private/ })).toBeDisabled();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove Alice" })).not.toBeInTheDocument();
  });

  it.each([false, true, undefined])("keeps a group without an explicit Admin read-only without a claim action (accessInitialized=%s)", async (accessInitialized) => {
    authFetch.mockResolvedValue(ok({ ...group, accessInitialized }));
    const user = userEvent.setup();
    manage();
    expect(await screen.findByTestId("group-access-tab")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /^Private/ })).toBeDisabled();
    expect(screen.queryByText("Members")).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Initialize|claim/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete this group" })).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    await user.click(screen.getByRole("radio", { name: /^Private/ }));
    expect(authFetch.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([false, true, undefined])("automatically loads Admin controls from the explicit role (accessInitialized=%s)", async (accessInitialized) => {
    authFetch.mockResolvedValue(ok({ ...group, accessInitialized, accessLevel: "admin", explicitRole: "admin" }));
    manage();
    await waitFor(() => expect(screen.getByRole("radio", { name: /^Private/ })).toBeEnabled());
    expect(await screen.findByRole("button", { name: "Delete this group" })).toBeEnabled();
    expect(await screen.findByRole("combobox", { name: "Select a user" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Initialize|claim/i })).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/project-groups/group/members", undefined);
    expect(authFetch.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(0);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(0);
  });

  it("confirms group visibility with aggregate counts and the original preview token", async () => {
    authFetch.mockResolvedValue(ok({ ...group, accessLevel: "admin", explicitRole: "admin" }));
    fetchMock.mockImplementation(async (url, init) => {
      if (url.endsWith("/members")) return ok({ members: [] });
      if (init?.method === "PATCH") return ok({ ...group, visibility: "private" });
      return ok({
        confirmationToken: "group-summary-token", companyAccess: "closed",
        summary: {
          affectedUserCount: 2, gainedAccessCount: 0, lostAccessCount: 2,
          increasedPermissionsCount: 0, decreasedPermissionsCount: 0, affectedProjectCount: 1,
        },
        projects: [{
          projectUuid: "private-child-uuid", name: "Private Child Name", companyAccess: "closed",
          changes: [{ userUuid: "private-user-uuid", name: "Private Person", email: "private@example.com", beforeRole: "editor", afterRole: "none" }],
        }],
      });
    });
    const user = userEvent.setup();
    manage();
    await user.click(await screen.findByRole("radio", { name: /^Private/ }));
    const impact = await screen.findByTestId("access-impact-preview");
    expect(impact).toHaveTextContent("2 users affected.");
    expect(impact).toHaveTextContent("2 users lose access to the group or a child project.");
    expect(impact).toHaveTextContent("1 child project affected.");
    for (const value of ["private-child-uuid", "Private Child Name", "private-user-uuid", "Private Person", "private@example.com"]) {
      expect(impact.innerHTML).not.toContain(value);
    }
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Change visibility" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/project-groups/group", expect.objectContaining({
      method: "PATCH", body: JSON.stringify({ visibility: "private", confirmationToken: "group-summary-token" }),
    })));
  });

  it("saves description edits through the labeled shadcn textarea", async () => {
    manage();
    const description = await screen.findByRole("textbox", { name: "Description (optional)" });
    expect(description).toHaveAttribute("data-slot", "textarea");
    fireEvent.change(description, { target: { value: " Updated description " } });
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(authFetch).toHaveBeenCalledWith("/api/project-groups/group", expect.objectContaining({
      method: "PATCH", body: JSON.stringify({ name: "Group", description: "Updated description" }),
    })));
  });

  it.each(["light", "dark"])("preserves keep/delete choices using shadcn controls in the %s theme", async (theme) => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    authFetch.mockImplementation(async () => ok({ ...group, accessLevel: "admin", explicitRole: "admin" }));
    const user = userEvent.setup();
    manage();
    const deleteButton = await screen.findByRole("button", { name: "Delete this group" });
    expect(deleteButton).toHaveAttribute("data-slot", "button");
    await user.click(deleteButton);
    const keep = screen.getByRole("radio", { name: /Move .* to Ungrouped/ });
    const remove = screen.getByRole("radio", { name: /Delete .* permanently/ });
    expect(keep).toBeChecked();
    expect(remove).not.toBeChecked();
    expect(keep).toHaveAttribute("data-slot", "radio-group-item");
    await user.click(remove);
    expect(remove).toBeChecked();
    expect(keep).not.toBeChecked();
    await user.click(keep);
    expect(keep).toBeChecked();
    await user.click(screen.getByRole("button", { name: "Delete Group" }));
    await waitFor(() => expect(authFetch).toHaveBeenCalledWith("/api/project-groups/group", { method: "DELETE" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/projects"));
  });

  it("sends deleteProjects only when the Admin chooses permanent deletion", async () => {
    authFetch.mockImplementation(async () => ok({ ...group, accessLevel: "admin", explicitRole: "admin" }));
    const user = userEvent.setup();
    manage();
    await user.click(await screen.findByRole("button", { name: "Delete this group" }));
    await user.click(screen.getByRole("radio", { name: /Delete .* permanently/ }));
    await user.click(screen.getByRole("button", { name: "Delete Group" }));
    await waitFor(() => expect(authFetch).toHaveBeenCalledWith("/api/project-groups/group?deleteProjects=true", { method: "DELETE" }));
  });

  it("creates a private group with explicit visibility and shows errors without dismissing", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ success: false, error: { code: "FORBIDDEN" } }), { status: 403 }));
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(<CreateProjectGroupDialog open onOpenChange={onOpenChange} />);
    await user.type(screen.getByPlaceholderText("e.g., Mobile Apps"), "Private group");
    await user.click(screen.getByRole("radio", { name: /^Private/ }));
    await user.click(screen.getByRole("button", { name: "Create Group" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Failed to create project group");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ name: "Private group", visibility: "private" });
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});

describe("movement access confirmation", () => {
  it("previews the destination and only confirms with its token", async () => {
    const user = userEvent.setup();
    const { onConfirm, onOpenChange } = move();
    await screen.findByTestId("access-impact-preview");
    expect(fetchMock).toHaveBeenCalledWith("/api/projects/project/group/preview?groupUuid=target");
    expect(onConfirm).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Confirm Move" }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith("move-token"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("uses an empty destination for detaching and shows retained-access information", async () => {
    fetchMock.mockResolvedValue(ok({ confirmationToken: "detach", companyAccess: "unchanged", changes: [] }));
    move(undefined, undefined, null);
    await screen.findByTestId("access-impact-preview");
    expect(fetchMock).toHaveBeenCalledWith("/api/projects/project/group/preview?groupUuid=");
    expect(screen.getByText("Company access is unchanged.")).toBeInTheDocument();
  });

  it("blocks movement while authorization preview fails", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ success: false }), { status: 403 }));
    const { onConfirm } = move();
    expect(await screen.findByRole("alert")).toHaveTextContent("Check your administration rights");
    expect(screen.getByRole("button", { name: "Confirm Move" })).toBeDisabled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("keeps a failed move open and requires confirmation of a fresh preview", async () => {
    const onConfirm = vi.fn().mockRejectedValueOnce(new Error("stale")).mockResolvedValue(undefined);
    const user = userEvent.setup();
    const { onOpenChange } = move(onConfirm);
    await screen.findByTestId("access-impact-preview");
    fetchMock.mockResolvedValue(ok({ confirmationToken: "fresh-token", companyAccess: "closed", changes: [] }));
    await user.click(screen.getByRole("button", { name: "Confirm Move" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Movement failed");
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(onConfirm).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole("button", { name: "Confirm Move" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Confirm Move" }));
    await waitFor(() => expect(onConfirm).toHaveBeenLastCalledWith("fresh-token"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
