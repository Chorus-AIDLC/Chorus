// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

const validateDirectorySelection = vi.fn();
vi.mock("@/components/agent-presence/directory-browser", () => ({
  validateDirectorySelection: (...args: unknown[]) => validateDirectorySelection(...args),
  DirectoryBrowser: ({ onSelectionChange, showConfirm }: {
    onSelectionChange: (selection: Record<string, string>) => void;
    showConfirm: boolean;
  }) => (
    <div>
      <button
        type="button"
        onClick={() => onSelectionChange({
          agentUuid: "agent-1",
          connectionUuid: "connection-1",
          host: "host-1",
          cwd: "/workspace/draft",
        })}
      >
        choose draft
      </button>
      {showConfirm && <button type="button">confirm cwd</button>}
    </div>
  ),
}));

import {
  ProjectAgentCwdSettings,
  type ProjectAgentCwdSettingsHandle,
} from "@/components/project-agent-cwd-settings";

describe("ProjectAgentCwdSettings", () => {
  beforeEach(() => {
    validateDirectorySelection.mockReset();
    validateDirectorySelection.mockResolvedValue({
      agentUuid: "agent-1",
      connectionUuid: "connection-1",
      host: "host-1",
      cwd: "/workspace/normalized",
      validationRequestUuid: "validation-1",
    });
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
    const ref = createRef<ProjectAgentCwdSettingsHandle>();
    render(
      <ProjectAgentCwdSettings
        ref={ref}
        projectUuid="project-1"
      />,
    );
    await screen.findByText("Agent One");
    fireEvent.click(screen.getByLabelText("projectSettings.agentCwds.replace"));
    fireEvent.click(screen.getByText("choose draft"));

    expect(await screen.findByText("/workspace/draft")).toBeTruthy();
    expect(screen.queryByText("confirm cwd")).toBeNull();
    await act(async () => {
      await expect(ref.current?.validate()).resolves.toEqual({
        upserts: [{
          agentUuid: "agent-1",
          connectionUuid: "connection-1",
          validationRequestUuid: "validation-1",
          host: "host-1",
          cwd: "/workspace/normalized",
        }],
        clears: [],
      });
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("records an explicit clear and renders an Agent-scoped error", async () => {
    const ref = createRef<ProjectAgentCwdSettingsHandle>();
    render(
      <ProjectAgentCwdSettings
        ref={ref}
        projectUuid="project-1"
        agentError={{ agentUuid: "agent-1", message: "Validation expired" }}
      />,
    );
    await screen.findByText("Agent One");
    expect(screen.getByRole("alert").textContent).toBe("Validation expired");
    fireEvent.click(screen.getByLabelText("projectSettings.agentCwds.clear"));

    await waitFor(async () => expect(await ref.current?.validate()).toEqual({
      upserts: [],
      clears: ["agent-1"],
    }));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects an invalid custom draft instead of allowing project submit", async () => {
    validateDirectorySelection.mockRejectedValueOnce(new Error("NOT_FOUND"));
    const ref = createRef<ProjectAgentCwdSettingsHandle>();
    render(<ProjectAgentCwdSettings ref={ref} />);
    await screen.findByText("Agent One");
    fireEvent.click(screen.getByLabelText("projectSettings.agentCwds.replace"));
    fireEvent.click(screen.getByText("choose draft"));

    await act(async () => {
      await expect(ref.current?.validate()).resolves.toBeNull();
    });

    expect(validateDirectorySelection).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "/workspace/draft",
    }));
    expect(screen.getByText("/workspace/draft")).toBeTruthy();
    expect(screen.getByRole("alert").textContent)
      .toBe("directoryBrowser.errors.NOT_FOUND");
  });
});
