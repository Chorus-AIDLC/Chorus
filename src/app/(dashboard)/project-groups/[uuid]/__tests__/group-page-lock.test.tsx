// @vitest-environment jsdom
// Lock indicator on the project-group dashboard project list.
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

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
