// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));
vi.mock("@/hooks/use-progress-router", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("@/components/project-agent-cwd-settings", () => ({
  ProjectAgentCwdSettings: ({
    onDraftChange,
    agentError,
  }: {
    onDraftChange: (value: {
      upserts: Array<{ agentUuid: string; validationRequestUuid: string }>;
      clears: string[];
    }) => void;
    agentError?: { agentUuid: string; message: string } | null;
  }) => (
    <div>
      <button
        type="button"
        onClick={() => onDraftChange({
          upserts: [{
            agentUuid: "agent-1",
            validationRequestUuid: "validation-1",
          }],
          clears: [],
        })}
      >
        select cwd draft
      </button>
      {agentError?.agentUuid === "agent-1" && (
        <p role="alert">{agentError.message}</p>
      )}
    </div>
  ),
}));

import { CreateProjectDialog } from "@/components/create-project-dialog";

describe("CreateProjectDialog cwd validation", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
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
    render(
      <CreateProjectDialog
        open
        onOpenChange={vi.fn()}
        groupUuid={null}
        groupName=""
      />,
    );

    fireEvent.change(
      screen.getByPlaceholderText("projectGroups.projectTitlePlaceholder"),
      { target: { value: "New Project" } },
    );
    fireEvent.click(screen.getByText("select cwd draft"));
    fireEvent.click(screen.getByText("projectGroups.createProject"));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Fresh successful validation required",
    );
    expect(screen.getByText("select cwd draft")).toBeTruthy();
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      "/api/projects",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"validationRequestUuid":"validation-1"'),
      }),
    ));
  });
});
