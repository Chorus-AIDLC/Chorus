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
  const cache = new Map();
  return { useTranslations: (namespace = "") => {
    if (!cache.has(namespace)) cache.set(namespace, (key: string, values: Record<string, string> = {}) => {
      let value: unknown = en;
      for (const part of (namespace ? `${namespace}.${key}` : key).split(".")) value = (value as Record<string, unknown>)?.[part];
      return typeof value === "string" ? value.replace(/\{(\w+)\}/g, (_, name) => values[name] ?? `{${name}}`) : key;
    });
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
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

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
    authFetch.mockResolvedValue(ok({ ...group, visibility: "private", accessLevel: "viewer", explicitRole: "viewer", canManage: false }));
    fetchMock.mockResolvedValue(ok({ members: [{ uuid: "m", userUuid: "u", name: "Alice", role: "admin", createdAt: "now" }] }));
    manage();
    expect(await screen.findByText("Alice")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("Group")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save Changes" })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove Alice" })).not.toBeInTheDocument();
  });

  it("keeps Public-group explicit Viewer membership separate from the editor baseline", async () => {
    authFetch.mockResolvedValue(ok({ ...group, explicitRole: "viewer" }));
    fetchMock.mockResolvedValue(ok({ members: [{ uuid: "m", userUuid: "u", name: "Alice", role: "admin", createdAt: "now" }] }));
    manage();
    await screen.findByText("Alice");
    expect(screen.getByDisplayValue("Group")).toBeEnabled();
    expect(screen.getByRole("radio", { name: /^Private/ })).toBeDisabled();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove Alice" })).not.toBeInTheDocument();
  });

  it("requires explicit initialization and explains how to arrange a common Admin", async () => {
    authFetch.mockImplementation(async (_url, init) => {
      if (init?.method === "PATCH") return new Response(JSON.stringify({ success: false }), { status: 403 });
      return ok({ ...group, accessInitialized: false });
    });
    const user = userEvent.setup();
    manage();
    expect(await screen.findByText(/Legacy groups have no automatic Admin/)).toHaveTextContent("common administrator");
    expect(fetchMock).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Initialize as group Admin" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("grant a common administrator project Admin access");
    expect(authFetch.mock.calls.filter(([, init]) => init?.method === "PATCH")[0][1].body).toBe(JSON.stringify({ initializeAccess: true }));
  });

  it("loads Admin controls after successful explicit initialization", async () => {
    let initialized = false;
    authFetch.mockImplementation(async (_url, init) => {
      if (init?.method === "PATCH") initialized = true;
      return ok({ ...group, accessInitialized: initialized, accessLevel: initialized ? "admin" : "editor", explicitRole: initialized ? "admin" : null });
    });
    const user = userEvent.setup();
    manage();
    await user.click(await screen.findByRole("button", { name: "Initialize as group Admin" }));
    await waitFor(() => expect(screen.getByRole("radio", { name: /^Private/ })).toBeEnabled());
    expect(await screen.findByRole("button", { name: "Delete this group" })).toBeEnabled();
    expect(fetchMock).toHaveBeenCalledWith("/api/project-groups/group/members", undefined);
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
