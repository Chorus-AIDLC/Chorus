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
  DirectoryBrowser: ({ agentUuid, onSelectionChange, showConfirm }: {
    agentUuid: string;
    onSelectionChange: (selection: Record<string, string>) => void;
    showConfirm: boolean;
  }) => (
    <div>
      <button
        type="button"
        onClick={() => onSelectionChange({
          agentUuid,
          connectionUuid: "connection-1",
          host: "host-1",
          cwd: agentUuid === "agent-1" ? "/workspace/draft" : "/workspace/agent-2",
        })}
      >
        {agentUuid === "agent-1" ? "choose draft" : "choose agent-2"}
      </button>
      {showConfirm && <button type="button">confirm cwd</button>}
    </div>
  ),
}));

import {
  ProjectAgentCwdSettings,
  type ProjectAgentCwdDraft,
  type ProjectAgentCwdSettingsHandle,
} from "@/components/project-agent-cwd-settings";

const draft: ProjectAgentCwdDraft = {
  agentUuid: "agent-1",
  connectionUuid: "connection-1",
  host: "host-1",
  cwd: "/workspace/draft",
};

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
    }), undefined);
    expect(screen.getByText("/workspace/draft")).toBeTruthy();
    expect(screen.getByRole("alert").textContent)
      .toBe("directoryBrowser.errors.NOT_FOUND");
  });

  it("forwards the caller signal and persists successful normalization", async () => {
    const ref = createRef<ProjectAgentCwdSettingsHandle>();
    const onDraftsChange = vi.fn();
    const controller = new AbortController();
    render(<ProjectAgentCwdSettings
      ref={ref}
      initialDrafts={{ "agent-1": draft }}
      onDraftsChange={onDraftsChange}
    />);
    await screen.findByText("Agent One");

    await act(async () => {
      await ref.current!.validate(controller.signal);
    });

    expect(validateDirectorySelection).toHaveBeenCalledWith(draft, controller.signal);
    expect(screen.getByText("/workspace/normalized")).toBeTruthy();
    expect(onDraftsChange).toHaveBeenCalledWith({
      "agent-1": { ...draft, cwd: "/workspace/normalized", validationRequestUuid: "validation-1" },
    });
  });

  it.each([false, true])("rejects an already cancelled validation (has drafts: %s)", async (hasDrafts) => {
    const ref = createRef<ProjectAgentCwdSettingsHandle>();
    const onDraftsChange = vi.fn();
    render(<ProjectAgentCwdSettings
      ref={ref}
      initialDrafts={hasDrafts ? { "agent-1": draft } : {}}
      onDraftsChange={onDraftsChange}
    />);
    await screen.findByText("Agent One");
    const controller = new AbortController();
    controller.abort("dialog closed");

    await expect(ref.current!.validate(controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(validateDirectorySelection).not.toHaveBeenCalled();
    expect(onDraftsChange).not.toHaveBeenCalled();
    expect(screen.queryByText("choose draft")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it.each(["resolve", "reject"])("ignores a late %s after cancellation", async (outcome) => {
    let resolve!: (value: ProjectAgentCwdDraft) => void;
    let reject!: (error: Error) => void;
    validateDirectorySelection.mockReturnValueOnce(new Promise((done, fail) => {
      resolve = done;
      reject = fail;
    }));
    const ref = createRef<ProjectAgentCwdSettingsHandle>();
    const onDraftsChange = vi.fn();
    render(<ProjectAgentCwdSettings
      ref={ref}
      initialDrafts={{ "agent-1": draft }}
      onDraftsChange={onDraftsChange}
    />);
    await screen.findByText("Agent One");
    const controller = new AbortController();
    const validation = ref.current!.validate(controller.signal);
    const rejection = expect(validation).rejects.toMatchObject({ name: "AbortError" });
    controller.abort("dialog closed");

    await act(async () => {
      if (outcome === "resolve") {
        resolve({ ...draft, cwd: "/late", validationRequestUuid: "late" });
      } else {
        reject(new Error("TIMEOUT"));
      }
      await rejection;
    });

    expect(screen.getByText("/workspace/draft")).toBeTruthy();
    expect(screen.queryByText("/late")).toBeNull();
    expect(screen.queryByText("choose draft")).toBeNull();
    expect(onDraftsChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText("projectSettings.agentCwds.replace"));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("propagates AbortError without displaying a generic validation failure", async () => {
    validateDirectorySelection.mockRejectedValueOnce(new DOMException("Aborted", "AbortError"));
    const ref = createRef<ProjectAgentCwdSettingsHandle>();
    render(<ProjectAgentCwdSettings ref={ref} initialDrafts={{ "agent-1": draft }} />);
    await screen.findByText("Agent One");

    await act(async () => {
      await expect(ref.current!.validate()).rejects.toMatchObject({ name: "AbortError" });
    });
    expect(screen.queryByText("choose draft")).toBeNull();
    fireEvent.click(screen.getByLabelText("projectSettings.agentCwds.replace"));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("/workspace/draft")).toBeTruthy();
  });

  it("restores parent-retained drafts after remount and reports explicit clears", async () => {
    const onDraftsChange = vi.fn();
    const { unmount } = render(<ProjectAgentCwdSettings onDraftsChange={onDraftsChange} />);
    await screen.findByText("Agent One");
    fireEvent.click(screen.getByLabelText("projectSettings.agentCwds.replace"));
    fireEvent.click(screen.getByText("choose draft"));
    expect(onDraftsChange).toHaveBeenLastCalledWith({ "agent-1": draft });
    const retainedDrafts = onDraftsChange.mock.calls.at(-1)![0];
    unmount();

    render(<ProjectAgentCwdSettings initialDrafts={retainedDrafts} onDraftsChange={onDraftsChange} />);
    await screen.findByText("Agent One");
    expect(screen.getByText("/workspace/draft")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("projectSettings.agentCwds.clear"));
    expect(onDraftsChange).toHaveBeenLastCalledWith({});
    expect(screen.queryByText("/workspace/draft")).toBeNull();
  });

  it.each(["add another agent", "replace selection", "clear selection"])(
    "preserves newer drafts when the user chooses to %s during validation",
    async (edit) => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({
          success: true,
          data: { agents: ["agent-1", "agent-2"].map((uuid) => ({
            agent: { uuid, name: uuid }, onlineInstances: [], preference: null,
          })) },
        }),
      } as Response);
      let resolve!: (value: ProjectAgentCwdDraft) => void;
      validateDirectorySelection.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
      const ref = createRef<ProjectAgentCwdSettingsHandle>();
      const onDraftsChange = vi.fn();
      const original = { ...draft, cwd: "/workspace/original" };
      const { unmount } = render(<ProjectAgentCwdSettings
        ref={ref}
        initialDrafts={{ "agent-1": original }}
        onDraftsChange={onDraftsChange}
      />);
      await screen.findByText("agent-2");
      const pending = ref.current!.validate(new AbortController().signal);
      if (edit === "add another agent") {
        fireEvent.click(screen.getByLabelText("projectSettings.agentCwds.configure"));
        fireEvent.click(screen.getByText("choose agent-2"));
      } else if (edit === "replace selection") {
        fireEvent.click(screen.getByLabelText("projectSettings.agentCwds.replace"));
        fireEvent.click(screen.getByText("choose draft"));
      } else {
        fireEvent.click(screen.getByLabelText("projectSettings.agentCwds.clear"));
      }
      const normalized = { ...original, cwd: "/normalized/original", validationRequestUuid: "old-token" };
      await act(async () => {
        resolve(normalized);
        // Submitted payload still belongs to the original operation.
        await expect(pending).resolves.toEqual({ upserts: [normalized], clears: [] });
      });
      const retained = onDraftsChange.mock.calls.at(-1)![0];
      if (edit === "add another agent") {
        expect(screen.getByText("/workspace/agent-2")).toBeTruthy();
        expect(retained).toEqual({
          "agent-1": normalized,
          "agent-2": { ...draft, agentUuid: "agent-2", cwd: "/workspace/agent-2" },
        });
      } else if (edit === "replace selection") {
        expect(screen.getByText("/workspace/draft")).toBeTruthy();
        expect(retained).toEqual({ "agent-1": draft });
      } else {
        expect(screen.queryByText("/normalized/original")).toBeNull();
        expect(retained).toEqual({});
      }
      unmount();
      render(<ProjectAgentCwdSettings initialDrafts={retained} />);
      await screen.findByText("agent-2");
      if (edit === "add another agent") expect(screen.getByText("/workspace/agent-2")).toBeTruthy();
      else if (edit === "replace selection") expect(screen.getByText("/workspace/draft")).toBeTruthy();
      else expect(screen.queryByText("/normalized/original")).toBeNull();
    },
  );
});
