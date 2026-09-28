// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { forwardRef, useImperativeHandle, useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectAgentCwdDraft } from "@/components/project-agent-cwd-settings";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));
vi.mock("@/hooks/use-progress-router", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("framer-motion", () => ({
  AnimatePresence: ({ children }: { children: ReactNode }) => children,
  motion: {
    span: ({ children, className }: { children: ReactNode; className?: string }) => (
      <span className={className}>{children}</span>
    ),
  },
}));
const { validateCwdSettings } = vi.hoisted(() => ({ validateCwdSettings: vi.fn() }));
vi.mock("@/components/project-agent-cwd-settings", () => ({
  ProjectAgentCwdSettings: forwardRef(function MockProjectAgentCwdSettings({
    agentError, initialDrafts, onDraftsChange,
  }: {
    agentError?: { agentUuid: string; message: string } | null;
    initialDrafts?: Record<string, ProjectAgentCwdDraft>;
    onDraftsChange?: (drafts: Record<string, ProjectAgentCwdDraft>) => void;
  }, ref) {
    useImperativeHandle(ref, () => ({ validate: validateCwdSettings }));
    const [cwd, setCwd] = useState(() => initialDrafts?.["agent-1"]?.cwd ?? "/workspace");
    return (
    <div>
      <input aria-label="cwd draft" value={cwd} onChange={(event) => {
        setCwd(event.target.value);
        onDraftsChange?.({
          "agent-1": {
            agentUuid: "agent-1", connectionUuid: "connection-1", host: "host-1",
            cwd: event.target.value,
          },
        });
      }} />
      {agentError?.agentUuid === "agent-1" && (
        <p role="alert">{agentError.message}</p>
      )}
    </div>
    );
  }),
}));

import { CreateProjectDialog } from "@/components/create-project-dialog";

function setup() {
  const onOpenChange = vi.fn();
  const props = { open: true, onOpenChange, groupUuid: null, groupName: "" };
  const view = render(<CreateProjectDialog {...props} />);
  fireEvent.change(screen.getByPlaceholderText("projectGroups.projectTitlePlaceholder"), {
    target: { value: "New Project" },
  });
  fireEvent.change(screen.getByPlaceholderText("projectGroups.projectDescriptionPlaceholder"), {
    target: { value: "Retained description" },
  });
  fireEvent.change(screen.getByRole("textbox", { name: "cwd draft" }), {
    target: { value: "/draft/kept" },
  });
  return {
    onOpenChange,
    button: screen.getByRole("button", { name: "projectGroups.createProject" }),
    setOpen: (open: boolean) => view.rerender(<CreateProjectDialog {...props} open={open} />),
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("CreateProjectDialog cwd validation", () => {
  beforeEach(() => {
    validateCwdSettings.mockReset();
    validateCwdSettings.mockResolvedValue({
      upserts: [{
        agentUuid: "agent-1",
        connectionUuid: "connection-1",
        host: "host-1",
        cwd: "/workspace",
        validationRequestUuid: "validation-1",
      }],
      clears: [],
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({
        success: false,
        error: {
          code: "CONFLICT",
          message: "Fresh successful validation required",
          details: { agentUuid: "agent-1" },
        },
      }),
    }));
  });

  it("preserves drafts and renders an Agent-scoped create error inline", async () => {
    const { button, setOpen, onOpenChange } = setup();
    fireEvent.click(button);

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Fresh successful validation required",
    );
    expect(validateCwdSettings).toHaveBeenCalledTimes(1);
    expect(validateCwdSettings).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(screen.getByRole("textbox", { name: "cwd draft" })).toHaveValue("/draft/kept");
    expect(button).toBeEnabled();
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      "/api/projects",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"validationRequestUuid":"validation-1"'),
      }),
    ));
    fireEvent.click(screen.getByRole("button", { name: "common.cancel" }));
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
    setOpen(false);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    setOpen(true);
    expect(screen.getByRole("textbox", { name: "cwd draft" })).toHaveValue("/draft/kept");
    expect(screen.getByPlaceholderText("projectGroups.projectTitlePlaceholder")).toHaveValue("New Project");
    expect(screen.getByPlaceholderText("projectGroups.projectDescriptionPlaceholder")).toHaveValue("Retained description");

    // Starting fresh validation clears the previous server-side agent error.
    validateCwdSettings.mockResolvedValueOnce(null);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "projectGroups.createProject" })));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(validateCwdSettings).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("textbox", { name: "cwd draft" })).toHaveValue("/draft/kept");
  });

  it.each([
    [500, "CONFLICT"], [409, "UNKNOWN"], [200, "VALIDATION_ERROR"],
  ])("does not treat agent details as definitive rejection for status %s and code %s", async (status, code) => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
      success: false,
      error: { code, message: "Do not show as a retryable cwd error", details: { agentUuid: "agent-1" } },
    }), { status }));
    const { button } = setup();
    await act(async () => fireEvent.click(button));
    expect(screen.getByRole("alert")).toHaveTextContent("projects.creationUnconfirmed");
    expect(screen.queryByText("Do not show as a retryable cwd error")).not.toBeInTheDocument();
    expect(button).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "cwd draft" })).toHaveValue("/draft/kept");
    expect(screen.getByRole("button", { name: "common.cancel" })).toBeEnabled();
  });
});
