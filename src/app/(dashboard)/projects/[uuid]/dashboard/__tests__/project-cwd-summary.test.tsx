// @vitest-environment jsdom
import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

const authFetch = vi.fn();
vi.mock("@/lib/auth-client", () => ({
  authFetch: (...args: unknown[]) => authFetch(...args),
}));

import { ProjectCwdSummary } from "../project-cwd-summary";

function response(cwd: string | null) {
  return Promise.resolve({
    ok: true,
    json: async () => ({
      data: {
        agents: [{
          agent: { uuid: "agent-1", name: "Agent One" },
          preference: cwd ? { cwd } : null,
        }],
      },
    }),
  });
}

describe("ProjectCwdSummary", () => {
  beforeEach(() => {
    authFetch.mockReset();
  });

  it("renders configured Agent cwd values beside the project title", async () => {
    authFetch.mockImplementationOnce(() => Promise.resolve({
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
    }));

    render(<ProjectCwdSummary projectUuid="project-1" />);

    const summary = await screen.findByLabelText("title");
    expect(summary.textContent).toContain("/work/dynamic-project");
    expect(summary.getAttribute("class")).toContain("flex-wrap");
    expect(screen.queryByText("Codex")).toBeNull();
  });

  it("reloads the fixed cwd marker after the project settings save event", async () => {
    authFetch
      .mockImplementationOnce(() => response(null))
      .mockImplementationOnce(() => response("/workspace/fixed"));

    render(<ProjectCwdSummary projectUuid="project-1" />);
    await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(1));
    expect(screen.queryByLabelText("title")).toBeNull();

    await act(async () => {
      window.dispatchEvent(new CustomEvent("project-cwd-updated", {
        detail: { projectUuid: "project-1" },
      }));
    });

    expect(await screen.findByText("/workspace/fixed")).toBeTruthy();
    expect(authFetch).toHaveBeenCalledTimes(2);
  });

  it("ignores cwd updates for another project", async () => {
    authFetch.mockImplementation(() => response(null));
    render(<ProjectCwdSummary projectUuid="project-1" />);
    await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(1));

    window.dispatchEvent(new CustomEvent("project-cwd-updated", {
      detail: { projectUuid: "project-2" },
    }));

    expect(authFetch).toHaveBeenCalledTimes(1);
  });
});
