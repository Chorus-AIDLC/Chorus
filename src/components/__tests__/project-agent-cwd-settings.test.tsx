// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/components/agent-presence/directory-browser", () => ({
  DirectoryBrowser: ({ onValidated }: {
    onValidated: (selection: Record<string, string>) => void;
  }) => (
    <button
      type="button"
      onClick={() => onValidated({
        agentUuid: "agent-1",
        connectionUuid: "connection-1",
        host: "host-1",
        cwd: "/workspace/normalized",
        validationRequestUuid: "validation-1",
      })}
    >
      choose normalized
    </button>
  ),
}));

import { ProjectAgentCwdSettings } from "@/components/project-agent-cwd-settings";

describe("ProjectAgentCwdSettings", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          agents: [{
            agent: { uuid: "agent-1", name: "Agent One" },
            onlineInstances: [],
            preference: {
              host: "old-host",
              cwd: "/old",
              status: "valid",
            },
          }],
        },
      }),
    }));
  });

  it("keeps a normalized selection as local draft without persisting it", async () => {
    const onDraftChange = vi.fn();
    render(
      <ProjectAgentCwdSettings
        projectUuid="project-1"
        onDraftChange={onDraftChange}
      />,
    );
    await screen.findByText("Agent One");
    fireEvent.click(screen.getByLabelText("projectSettings.agentCwds.replace"));
    fireEvent.click(screen.getByText("choose normalized"));

    expect(await screen.findByText("/workspace/normalized")).toBeTruthy();
    expect(onDraftChange).toHaveBeenCalledWith({
      upserts: [{
        agentUuid: "agent-1",
        validationRequestUuid: "validation-1",
        host: "host-1",
        cwd: "/workspace/normalized",
      }],
      clears: [],
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("records an explicit clear and renders an Agent-scoped error", async () => {
    const onDraftChange = vi.fn();
    render(
      <ProjectAgentCwdSettings
        projectUuid="project-1"
        onDraftChange={onDraftChange}
        agentError={{ agentUuid: "agent-1", message: "Validation expired" }}
      />,
    );
    await screen.findByText("Agent One");
    expect(screen.getByRole("alert").textContent).toBe("Validation expired");
    fireEvent.click(screen.getByLabelText("projectSettings.agentCwds.clear"));

    await waitFor(() => expect(onDraftChange).toHaveBeenCalledWith({
      upserts: [],
      clears: ["agent-1"],
    }));
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
