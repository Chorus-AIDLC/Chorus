// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) =>
    key === "title" ? "Project fixed directory" : key,
}));

const mockAuthFetch = vi.fn();
vi.mock("@/lib/auth-client", () => ({
  authFetch: (...args: unknown[]) => mockAuthFetch(...args),
}));

import { ProjectCwdSummary } from "../project-cwd-summary";

describe("ProjectCwdSummary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders configured Agent cwd values beside the project title", async () => {
    mockAuthFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          agents: [
            {
              agent: { uuid: "agent-1", name: "Claude" },
              preference: { cwd: "/work/dynamic-project" },
            },
            {
              agent: { uuid: "agent-2", name: "Codex" },
              preference: null,
            },
          ],
        },
      }),
    });

    render(<ProjectCwdSummary projectUuid="project-1" />);

    const summary = await screen.findByLabelText("Project fixed directory");
    expect(summary.textContent).toContain("/work/dynamic-project");
    expect(summary.getAttribute("class")).toContain("flex-wrap");
    expect(screen.queryByText("Codex")).toBeNull();
  });
});
