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
import { getAgentColor } from "@/lib/agent-color";

// React/jsdom serialize an inline hex color to `rgb(...)`; convert for comparison.
function hexToRgb(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

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

function badgeFor(name: string): HTMLElement | null {
  return screen.getByText(name).closest("span[title]") as HTMLElement | null;
}

describe("ProjectCwdSummary", () => {
  beforeEach(() => {
    authFetch.mockReset();
  });

  it("shows the agent name as the visible label with the cwd in the tooltip", async () => {
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
    expect(summary.getAttribute("class")).toContain("flex-wrap");
    // Agent name is visible; the cwd path is in the badge tooltip, not the label.
    expect(await screen.findByText("Claude")).toBeTruthy();
    expect(badgeFor("Claude")?.getAttribute("title")).toBe("/work/dynamic-project");
    expect(summary.textContent).not.toContain("/work/dynamic-project");
    // Agent with no preference is filtered out entirely.
    expect(screen.queryByText("Codex")).toBeNull();
  });

  it("distinguishes multiple agents by a per-agent identity dot even with common-prefix cwds", async () => {
    authFetch.mockImplementationOnce(() => Promise.resolve({
      ok: true,
      json: async () => ({
        data: {
          agents: [
            {
              agent: { uuid: "a1", name: "Claude" },
              preference: { cwd: "/home/ubuntu/dev/ai-pm" },
            },
            {
              agent: { uuid: "a2", name: "Codex" },
              preference: { cwd: "/home/ubuntu/dev/ai-pm-worktree" },
            },
          ],
        },
      }),
    }));

    render(<ProjectCwdSummary projectUuid="project-1" />);

    // Both agents are identifiable by their visible names (no hover needed)...
    expect(await screen.findByText("Claude")).toBeTruthy();
    expect(screen.getByText("Codex")).toBeTruthy();
    // ...and each cwd lives in its own badge tooltip.
    expect(badgeFor("Claude")?.getAttribute("title")).toBe("/home/ubuntu/dev/ai-pm");
    expect(badgeFor("Codex")?.getAttribute("title")).toBe(
      "/home/ubuntu/dev/ai-pm-worktree",
    );
    // Each identity dot is colored by the shared per-agent palette helper.
    const dots = screen.getAllByTestId("cwd-agent-dot");
    expect(dots).toHaveLength(2);
    expect(dots[0].style.backgroundColor).toBe(hexToRgb(getAgentColor("Claude")));
    expect(dots[1].style.backgroundColor).toBe(hexToRgb(getAgentColor("Codex")));
    // Distinct agents → distinct dot colors.
    expect(dots[0].style.backgroundColor).not.toBe(dots[1].style.backgroundColor);
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

    // Agent name becomes visible; the cwd is carried in the badge tooltip.
    const label = await screen.findByText("Agent One");
    expect(label.closest("span[title]")?.getAttribute("title")).toBe(
      "/workspace/fixed",
    );
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
