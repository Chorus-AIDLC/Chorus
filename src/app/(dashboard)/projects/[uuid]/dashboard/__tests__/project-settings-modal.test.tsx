// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { forwardRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  ProjectAgentCwdSettings: forwardRef(function MockCwdSettings(props: { disabled?: boolean }, ref) {
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
    return <div data-testid="cwd-settings" data-disabled={String(!!props.disabled)}>cwd settings</div>;
  }),
}));

vi.mock("../project-access-tab", () => ({
  ProjectAccessTab: () => <div data-testid="access-tab" />,
}));

import { ProjectSettingsModal } from "../project-settings-modal";

function stubProject(visibility: "public" | "private", accessLevel: "viewer" | "editor" | "admin") {
  vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => new Response(JSON.stringify({
    success: true,
    data: { uuid: "project-1", name: "Project One", visibility, accessLevel },
  }))));
}

function renderModal() {
  return render(
    <ProjectSettingsModal
      projectUuid="project-1"
      projectName="Project One"
      projectDescription={null}
    />,
  );
}

describe("ProjectSettingsModal", () => {
  beforeEach(() => {
    refresh.mockReset();
    updateProjectAction.mockReset();
    updateProjectAction.mockResolvedValue({ success: true });
    stubProject("public", "editor");
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("fetches the caller's access and keeps settings editable on a public project", async () => {
    renderModal();
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/projects/project-1"));
    expect(screen.getByRole("tab", { name: "projectAccess.tabs.general" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "projectAccess.tabs.access" })).toBeInTheDocument();
    expect(screen.getByDisplayValue("Project One")).toBeEnabled();
    expect(screen.getByRole("button", { name: "projectSettings.saveChanges" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "common.delete" })).toBeEnabled();
    expect(screen.queryByTestId("settings-locked-hint")).not.toBeInTheDocument();
  });

  it.each(["viewer", "editor"] as const)(
    "locks basic info and delete for a non-admin %s on a private project",
    async (accessLevel) => {
      stubProject("private", accessLevel);
      renderModal();
      expect(await screen.findByTestId("settings-locked-hint")).toHaveTextContent(
        "projectAccess.settingsLockedHint",
      );
      expect(screen.getByDisplayValue("Project One")).toBeDisabled();
      expect(screen.getByRole("button", { name: "projectSettings.saveChanges" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "common.delete" })).toBeDisabled();
      expect(screen.getByText("projectAccess.deleteLockedHint")).toBeInTheDocument();
    },
  );

  it("keeps basic info and delete enabled for an admin on a private project", async () => {
    stubProject("private", "admin");
    renderModal();
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByDisplayValue("Project One")).toBeEnabled());
    expect(screen.queryByTestId("settings-locked-hint")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "common.delete" })).toBeEnabled();
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

    // Save is disabled until the caller's access is known (no flash of enabled controls).
    await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(save);

    await waitFor(() => expect(updateProjectAction).toHaveBeenCalled());
    expect(dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "project-cwd-updated",
      detail: { projectUuid: "project-1" },
    }));
    expect(refresh).toHaveBeenCalled();
  });

  it("keeps settings disabled (without the admin-only hint) while access is still loading", async () => {
    let release!: (r: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(() => new Promise<Response>((r) => (release = r)));
    render(<ProjectSettingsModal projectUuid="project-1" projectName="Project One" projectDescription={null} />);
    const save = screen.getByRole("button", { name: "projectSettings.saveChanges" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(screen.queryByTestId("settings-locked-hint")).toBeNull();
    release(new Response(JSON.stringify({ success: true, data: { visibility: "public", accessLevel: "editor" } })));
    await waitFor(() => expect(save.disabled).toBe(false));
  });

  it("fails closed when the access request fails (controls disabled, error shown)", async () => {
    vi.mocked(fetch).mockImplementationOnce(async () => new Response(JSON.stringify({ success: false }), { status: 500 }));
    render(<ProjectSettingsModal projectUuid="project-1" projectName="Project One" projectDescription={null} />);
    await screen.findByTestId("settings-access-failed");
    const save = screen.getByRole("button", { name: "projectSettings.saveChanges" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(screen.getByTestId("cwd-settings").getAttribute("data-disabled")).toBe("true");
  });
});
