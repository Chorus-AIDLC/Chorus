// @vitest-environment jsdom
import React from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

const authFetch = vi.fn();
vi.mock("@/lib/auth-client", () => ({
  authFetch: (...args: unknown[]) => authFetch(...args),
}));

// The badge is clickable → opens the agent's daemon chat via the presence context.
const openChatForAgent = vi.fn();
vi.mock("@/contexts/agent-presence-context", () => ({
  useAgentPresenceOptional: () => ({ openChatForAgent }),
}));

// Mock the Radix-based Tooltip primitive: Radix's hover/pointer open path is unreliable in
// jsdom, so we render TooltipContent inline (in a portal-like sibling, NOT inside the badge)
// to deterministically assert MY wiring — that the cwd is passed as the tooltip content and
// is NOT part of the badge's visible label. Radix's actual open-on-hover is its own contract.
vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode; asChild?: boolean }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="cwd-tooltip">{children}</div>
  ),
}));

import { ProjectCwdSummary } from "../project-cwd-summary";
import { getAgentColor } from "@/lib/agent-color";

// React/jsdom serialize an inline hex color to `rgb(...)`; convert for comparison.
function hexToRgb(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

function agentsResponse(
  agents: { uuid: string; name: string; host?: string; cwd: string | null }[],
) {
  return Promise.resolve({
    ok: true,
    json: async () => ({
      data: {
        agents: agents.map((a) => ({
          agent: { uuid: a.uuid, name: a.name },
          preference: a.cwd ? { host: a.host ?? "host-1", cwd: a.cwd } : null,
        })),
      },
    }),
  });
}

function badgeButton(name: string): HTMLButtonElement {
  return screen.getByText(name).closest("button") as HTMLButtonElement;
}

describe("ProjectCwdSummary", () => {
  beforeEach(() => {
    authFetch.mockReset();
    openChatForAgent.mockReset();
  });

  it("shows the agent NAME as the visible badge label and puts the cwd in the tooltip (not the label)", async () => {
    authFetch.mockImplementationOnce(() =>
      agentsResponse([
        { uuid: "agent-1", name: "Claude", cwd: "/work/dynamic-project" },
        { uuid: "agent-2", name: "Codex", cwd: null },
      ]),
    );

    render(<ProjectCwdSummary projectUuid="project-1" />);

    await screen.findByText("Claude");
    // The badge's own visible label is the agent name — the cwd is NOT in the button text
    // (this is the regression: previously the cwd was the only visible content).
    const btn = badgeButton("Claude");
    expect(btn.textContent).toContain("Claude");
    expect(btn.textContent).not.toContain("/work/dynamic-project");
    // The cwd IS wired into the tooltip content.
    expect(within(screen.getByTestId("cwd-tooltip")).getByText("/work/dynamic-project")).toBeTruthy();
    // Agent with no preference is filtered out.
    expect(screen.queryByText("Codex")).toBeNull();
  });

  it("distinguishes multiple agents by a per-agent identity dot even with common-prefix cwds", async () => {
    authFetch.mockImplementationOnce(() =>
      agentsResponse([
        { uuid: "a1", name: "Claude", cwd: "/home/ubuntu/dev/ai-pm" },
        { uuid: "a2", name: "Codex", cwd: "/home/ubuntu/dev/ai-pm-worktree" },
      ]),
    );

    render(<ProjectCwdSummary projectUuid="project-1" />);

    expect(await screen.findByText("Claude")).toBeTruthy();
    expect(screen.getByText("Codex")).toBeTruthy();
    const dots = screen.getAllByTestId("cwd-agent-dot");
    expect(dots).toHaveLength(2);
    expect(dots[0].style.backgroundColor).toBe(hexToRgb(getAgentColor("Claude")));
    expect(dots[1].style.backgroundColor).toBe(hexToRgb(getAgentColor("Codex")));
    expect(dots[0].style.backgroundColor).not.toBe(dots[1].style.backgroundColor);
    // Each agent's cwd lives in its own tooltip.
    const tips = screen.getAllByTestId("cwd-tooltip").map((el) => el.textContent);
    expect(tips).toContain("/home/ubuntu/dev/ai-pm");
    expect(tips).toContain("/home/ubuntu/dev/ai-pm-worktree");
  });

  it("opens the agent's chat (pinned to its host+cwd) when the badge is clicked", async () => {
    authFetch.mockImplementationOnce(() =>
      agentsResponse([
        { uuid: "a1", name: "Claude", host: "host-A", cwd: "/work/alpha" },
      ]),
    );

    const user = userEvent.setup();
    render(<ProjectCwdSummary projectUuid="project-1" />);

    await screen.findByText("Claude");
    await user.click(badgeButton("Claude"));

    expect(openChatForAgent).toHaveBeenCalledTimes(1);
    expect(openChatForAgent).toHaveBeenCalledWith("a1", {
      host: "host-A",
      cwd: "/work/alpha",
    });
  });

  it("reloads the fixed cwd marker after the project settings save event", async () => {
    authFetch
      .mockImplementationOnce(() => agentsResponse([{ uuid: "agent-1", name: "Agent One", cwd: null }]))
      .mockImplementationOnce(() =>
        agentsResponse([{ uuid: "agent-1", name: "Agent One", cwd: "/workspace/fixed" }]),
      );

    render(<ProjectCwdSummary projectUuid="project-1" />);
    await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(1));
    expect(screen.queryByLabelText("title")).toBeNull();

    await act(async () => {
      window.dispatchEvent(new CustomEvent("project-cwd-updated", {
        detail: { projectUuid: "project-1" },
      }));
    });

    expect(await screen.findByText("Agent One")).toBeTruthy();
    expect(within(screen.getByTestId("cwd-tooltip")).getByText("/workspace/fixed")).toBeTruthy();
    expect(authFetch).toHaveBeenCalledTimes(2);
  });

  it("ignores cwd updates for another project", async () => {
    authFetch.mockImplementation(() => agentsResponse([{ uuid: "agent-1", name: "Agent One", cwd: null }]));
    render(<ProjectCwdSummary projectUuid="project-1" />);
    await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(1));

    window.dispatchEvent(new CustomEvent("project-cwd-updated", {
      detail: { projectUuid: "project-2" },
    }));

    expect(authFetch).toHaveBeenCalledTimes(1);
  });
});
