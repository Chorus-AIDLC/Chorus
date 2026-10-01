// @vitest-environment jsdom
// Lock indicator on the /projects list: private projects show it, public don't.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));
vi.mock("@/contexts/realtime-context", () => ({
  useRealtimeEntityTypeEvent: () => {},
}));
vi.mock("@/contexts/project-quick-access-context", () => ({
  useProjectQuickAccess: () => ({ isPinned: () => false, pin: vi.fn(), unpin: vi.fn() }),
}));
vi.mock("@/components/create-project-dialog", () => ({ CreateProjectDialog: () => null }));
vi.mock("@/components/create-project-group-dialog", () => ({ CreateProjectGroupDialog: () => null }));
vi.mock("@/components/move-project-confirm-dialog", () => ({ MoveProjectConfirmDialog: () => null }));

import ProjectsPage from "../page";

function project(uuid: string, name: string, visibility?: string) {
  return {
    uuid,
    name,
    description: null,
    groupUuid: null,
    visibility,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    counts: { ideas: 0, documents: 0, tasks: 1, doneTasks: 0, proposals: 0 },
  };
}

function mockFetch(projects: unknown[]) {
  globalThis.fetch = vi.fn(async (url: string) => {
    const body = String(url).startsWith("/api/projects")
      ? { success: true, data: { data: projects } }
      : String(url).startsWith("/api/project-groups")
        ? { success: true, data: { groups: [] } }
        : { success: true, data: { data: [] } };
    return { json: async () => body } as Response;
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  // Expand the Ungrouped section so its rows render.
  localStorage.setItem("chorus_projects_expanded_groups", JSON.stringify(["__ungrouped__"]));
});

describe.each(["list", "grid"])("ProjectsPage lock indicator (%s view)", (viewMode) => {
  it("renders a lock only on the private project", async () => {
    localStorage.setItem("chorus_projects_view_mode", viewMode);
    mockFetch([project("p-private", "Secret", "private"), project("p-public", "Open", "public")]);

    render(<ProjectsPage />);
    await waitFor(() => expect(screen.getByText("Secret")).toBeTruthy());
    expect(screen.getByText("Open")).toBeTruthy();

    const locks = screen.getAllByTestId("project-lock-indicator");
    expect(locks).toHaveLength(1);
    expect(locks[0].textContent).toBe("projectAccess.privateBadge");
    // The lock sits in the private project's row, not the public one.
    expect(locks[0].parentElement?.textContent).toContain("Secret");
    expect(locks[0].parentElement?.textContent).not.toContain("Open");
  });

  it("renders no lock when visibility is public or absent", async () => {
    localStorage.setItem("chorus_projects_view_mode", viewMode);
    mockFetch([project("p-a", "Alpha", "public"), project("p-b", "Beta")]);

    render(<ProjectsPage />);
    await waitFor(() => expect(screen.getByText("Alpha")).toBeTruthy());
    expect(screen.queryByTestId("project-lock-indicator")).toBeNull();
  });
});
