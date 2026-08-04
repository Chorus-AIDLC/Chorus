// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { forwardRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams("settings=agent-cwds"),
}));
const refresh = vi.fn();
vi.mock("@/hooks/use-progress-router", () => ({
  useRouter: () => ({ refresh }),
}));
const updateProjectAction = vi.fn();
vi.mock("../../actions", () => ({
  updateProjectAction: (...args: unknown[]) => updateProjectAction(...args),
  deleteProjectAction: vi.fn(),
}));
vi.mock("@/components/project-agent-cwd-settings", () => ({
  ProjectAgentCwdSettings: forwardRef(function MockCwdSettings(_, ref) {
    if (typeof ref === "object" && ref) {
      ref.current = {
        validate: vi.fn().mockResolvedValue({
          upserts: [{
            agentUuid: "agent-1",
            validationRequestUuid: "validation-1",
          }],
          clears: [],
        }),
      };
    }
    return <div data-testid="cwd-settings">cwd settings</div>;
  }),
}));

import { ProjectSettingsModal } from "../project-settings-modal";

describe("ProjectSettingsModal", () => {
  beforeEach(() => {
    refresh.mockReset();
    updateProjectAction.mockReset();
    updateProjectAction.mockResolvedValue({ success: true });
  });

  it("places Save Changes after cwd settings and announces a successful cwd save", async () => {
    const dispatchEvent = vi.spyOn(window, "dispatchEvent");
    render(
      <ProjectSettingsModal
        projectUuid="project-1"
        projectName="Project One"
        projectDescription={null}
      />,
    );

    const cwdSettings = screen.getByTestId("cwd-settings");
    const save = screen.getByRole("button", { name: "projectSettings.saveChanges" });
    expect(cwdSettings.compareDocumentPosition(save) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();

    fireEvent.click(save);

    await waitFor(() => expect(updateProjectAction).toHaveBeenCalled());
    expect(dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "project-cwd-updated",
      detail: { projectUuid: "project-1" },
    }));
    expect(refresh).toHaveBeenCalled();
  });
});
