// @vitest-environment jsdom
// Lock indicator on the project-group dashboard project list.
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const mockAuthFetch = vi.hoisted(() => vi.fn());

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));
vi.mock("next/navigation", () => ({
  useParams: () => ({ uuid: "group-1" }),
}));
vi.mock("@/hooks/use-progress-router", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/lib/auth-client", () => ({ authFetch: mockAuthFetch }));
vi.mock("@/components/manage-project-group-dialog", () => ({ ManageProjectGroupDialog: () => null }));
vi.mock("@/components/create-project-dialog", () => ({ CreateProjectDialog: () => null }));

import ProjectGroupDashboardPage from "../page";

function dashboard(projects: { uuid: string; name: string; visibility?: string }[]) {
  return {
    success: true,
    data: {
      group: { uuid: "group-1", name: "Group One", description: null },
      stats: {
        projectCount: projects.length,
        totalTasks: 0,
        completedTasks: 0,
        completionRate: 0,
        openIdeas: 0,
        activeProposals: 0,
      },
      projects: projects.map((p) => ({ ...p, taskCount: 0, completionRate: 0 })),
      recentActivity: [],
    },
  };
}

describe("ProjectGroupDashboardPage lock indicator", () => {
  it("shows a lock for private projects only", async () => {
    mockAuthFetch.mockResolvedValue({
      ok: true,
      json: async () =>
        dashboard([
          { uuid: "p1", name: "Hidden", visibility: "private" },
          { uuid: "p2", name: "Visible", visibility: "public" },
        ]),
    });

    render(<ProjectGroupDashboardPage />);
    await waitFor(() => expect(screen.getByText("Hidden")).toBeTruthy());

    const locks = screen.getAllByTestId("project-lock-indicator");
    expect(locks).toHaveLength(1);
    expect(locks[0].parentElement?.textContent).toContain("Hidden");
    expect(locks[0].textContent).toBe("projectAccess.privateBadge");
  });

  it.each([
    ["project-only", null, false, false],
    ["Viewer", "viewer", false, false],
    ["Editor", "editor", false, true],
    ["Admin", "admin", true, true],
  ] as const)("gates group controls for %s access", async (_role, explicitRole, canManage, canCreateProject) => {
    mockAuthFetch.mockImplementation(async (url: string) => ({
      ok: true,
      json: async () => url.endsWith("/dashboard")
        ? dashboard([{ uuid: "p1", name: "Allowed child", visibility: "private" }])
        : { success: true, data: {
          uuid: "group-1", name: "Private group", description: null, visibility: "private",
          accessLevel: explicitRole ?? "viewer", explicitRole, canManage, canCreateProject,
          accessInitialized: true,
        } },
    }));
    render(<ProjectGroupDashboardPage />);
    await screen.findByText("Allowed child");
    expect(screen.getByTestId("group-lock-indicator")).toHaveTextContent("projectGroups.privateBadge");
    if (canManage) expect(screen.getByRole("button", { name: "projectGroups.manageGroup" })).toBeInTheDocument();
    else expect(screen.queryByRole("button", { name: "projectGroups.manageGroup" })).not.toBeInTheDocument();
    if (explicitRole && !canManage) expect(screen.getByRole("button", { name: "projectGroups.viewMembers" })).toBeInTheDocument();
    if (canCreateProject) expect(screen.getByRole("button", { name: "groupDashboard.newProject" })).toBeInTheDocument();
    else expect(screen.queryByRole("button", { name: "groupDashboard.newProject" })).not.toBeInTheDocument();
  });

  it("shows no lock when every project is public", async () => {
    mockAuthFetch.mockResolvedValue({
      ok: true,
      json: async () => dashboard([{ uuid: "p2", name: "Visible", visibility: "public" }]),
    });

    render(<ProjectGroupDashboardPage />);
    await waitFor(() => expect(screen.getByText("Visible")).toBeTruthy());
    expect(screen.queryByTestId("project-lock-indicator")).toBeNull();
  });
});
