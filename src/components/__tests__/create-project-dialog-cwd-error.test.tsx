// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { forwardRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));
vi.mock("@/hooks/use-progress-router", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));
const validateCwdSettings = vi.fn();
vi.mock("@/components/project-agent-cwd-settings", () => ({
  ProjectAgentCwdSettings: forwardRef(function MockProjectAgentCwdSettings({
    agentError,
  }: {
    agentError?: { agentUuid: string; message: string } | null;
  }, ref) {
    if (typeof ref === "object" && ref) {
      ref.current = { validate: validateCwdSettings };
    }
    return (
    <div>
      <span>cwd draft remains</span>
      {agentError?.agentUuid === "agent-1" && (
        <p role="alert">{agentError.message}</p>
      )}
    </div>
    );
  }),
}));

import { CreateProjectDialog } from "@/components/create-project-dialog";

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
    fireEvent.click(screen.getByText("projectGroups.createProject"));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Fresh successful validation required",
    );
    expect(validateCwdSettings).toHaveBeenCalledTimes(1);
    expect(screen.getByText("cwd draft remains")).toBeTruthy();
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      "/api/projects",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"validationRequestUuid":"validation-1"'),
      }),
    ));
  });
});
