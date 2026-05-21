// @vitest-environment jsdom
//
// UI tests for the MoveIdeaDialog — covers the user-visible contract from
// task #3 ACs: preview load gates Confirm, success toast carries the actual
// `moved` counts, error path keeps the dialog open. Translations resolve
// against the real en.json so any drift between component and messages
// surfaces here.

import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// vi.mock factories run before module-level statements (hoisted), so the fns
// they reference must also be hoisted.
const { refreshMock, pushMock, toastSuccess, toastError } = vi.hoisted(() => ({
  refreshMock: vi.fn(),
  pushMock: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

const { moveIdeaActionMock, moveIdeaPreviewActionMock, getProjectsAndGroupsActionMock } = vi.hoisted(() => ({
  moveIdeaActionMock: vi.fn(),
  moveIdeaPreviewActionMock: vi.fn(),
  getProjectsAndGroupsActionMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: refreshMock, push: pushMock, replace: vi.fn() }),
}));

vi.mock("sonner", () => ({
  toast: { success: toastSuccess, error: toastError },
}));

vi.mock("../actions", () => ({
  moveIdeaAction: (...args: unknown[]) => moveIdeaActionMock(...args),
  moveIdeaPreviewAction: (...args: unknown[]) => moveIdeaPreviewActionMock(...args),
  getProjectsAndGroupsAction: (...args: unknown[]) => getProjectsAndGroupsActionMock(...args),
}));

vi.mock("next-intl", async () => {
  const en = (await import("../../../../../../../../messages/en.json")).default as Record<
    string,
    unknown
  >;
  function resolveKey(ns: string, key: string): string {
    const path = ns ? `${ns}.${key}`.split(".") : key.split(".");
    let node: unknown = en;
    for (const p of path) {
      if (node && typeof node === "object" && p in (node as Record<string, unknown>)) {
        node = (node as Record<string, unknown>)[p];
      } else {
        return `${ns ? ns + "." : ""}${key}`;
      }
    }
    return typeof node === "string" ? node : `${ns ? ns + "." : ""}${key}`;
  }
  function format(template: string, values?: Record<string, unknown>): string {
    if (!values) return template;
    return template.replace(/\{(\w+)\}/g, (_, name) =>
      name in values ? String(values[name]) : `{${name}}`,
    );
  }
  // Memoize per-namespace so consumers using `useTranslations("ideas")` get a
  // stable function reference. Without this the t() ref changes every render,
  // causing useCallback deps to invalidate and useEffect chains to loop.
  const tCache = new Map<string, (key: string, values?: Record<string, unknown>) => string>();
  return {
    useTranslations: (ns?: string) => {
      const k = ns ?? "";
      let fn = tCache.get(k);
      if (!fn) {
        fn = (key, values) => format(resolveKey(k, key), values);
        tCache.set(k, fn);
      }
      return fn;
    },
  };
});

// PointerEvent / hasPointerCapture / ResizeObserver are not implemented in
// jsdom but Radix Popover and cmdk need them.
class MockPointerEvent extends Event {
  button: number;
  ctrlKey: boolean;
  pointerType: string;
  constructor(type: string, props: PointerEventInit) {
    super(type, props);
    this.button = props.button ?? 0;
    this.ctrlKey = props.ctrlKey ?? false;
    this.pointerType = props.pointerType ?? "mouse";
  }
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(window as any).PointerEvent = MockPointerEvent;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(window as any).HTMLElement.prototype.hasPointerCapture = vi.fn();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(window as any).HTMLElement.prototype.releasePointerCapture = vi.fn();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(window as any).HTMLElement.prototype.scrollIntoView = vi.fn();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(window as any).ResizeObserver = class {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
};

import { MoveIdeaDialog } from "../move-idea-dialog";

const PROJECT_A = "00000000-0000-4000-8000-00000000aaaa";
const PROJECT_B = "00000000-0000-4000-8000-00000000bbbb";
const PROJECT_C = "00000000-0000-4000-8000-00000000cccc";
const IDEA_UUID = "00000000-0000-4000-8000-000000000111";
const GROUP_UUID = "00000000-0000-4000-8000-000000000222";

const ALL_PROJECTS = {
  success: true as const,
  data: {
    projects: [
      { uuid: PROJECT_A, name: "Source Project", groupUuid: GROUP_UUID },
      { uuid: PROJECT_B, name: "Target One", groupUuid: GROUP_UUID },
      { uuid: PROJECT_C, name: "Target Two", groupUuid: null },
    ],
    groups: [{ uuid: GROUP_UUID, name: "Engineering" }],
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  getProjectsAndGroupsActionMock.mockResolvedValue(ALL_PROJECTS);
  moveIdeaPreviewActionMock.mockResolvedValue({
    success: true,
    moved: { proposals: 2, documents: 1, tasks: 3, activities: 7 },
  });
  moveIdeaActionMock.mockResolvedValue({
    success: true,
    moved: { proposals: 2, documents: 1, tasks: 3, activities: 7 },
  });
});

function renderDialog(overrides: Partial<React.ComponentProps<typeof MoveIdeaDialog>> = {}) {
  const onOpenChange = vi.fn();
  const onMoved = vi.fn();
  const utils = render(
    <MoveIdeaDialog
      open
      onOpenChange={onOpenChange}
      ideaUuid={IDEA_UUID}
      projectUuid={PROJECT_A}
      onMoved={onMoved}
      {...overrides}
    />,
  );
  return { onOpenChange, onMoved, ...utils };
}

// The Select trigger is a button with role="combobox" once Radix has hydrated.
async function findSelectTrigger() {
  return await screen.findByRole("combobox");
}

describe("MoveIdeaDialog", () => {
  it("loads target projects (excluding the current one) when opened", async () => {
    renderDialog();
    await waitFor(() => {
      expect(getProjectsAndGroupsActionMock).toHaveBeenCalled();
    });
    // Wait for the target-project Select to render after projects load.
    const trigger = await findSelectTrigger();
    expect(trigger).toBeTruthy();
    expect(screen.getByText("Move idea to a different project")).toBeTruthy();
    // Confirm is disabled before any project selection.
    const confirm = screen.getByRole("button", { name: "Confirm move" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
  });

  it("fetches preview after selecting a target and renders the count summary", async () => {
    const user = userEvent.setup();
    renderDialog();
    const trigger = await findSelectTrigger();
    await user.click(trigger);
    const option = await screen.findByRole("option", { name: "Target One" });
    await user.click(option);

    await waitFor(() => {
      expect(moveIdeaPreviewActionMock).toHaveBeenCalledWith(IDEA_UUID, PROJECT_B);
    });

    // Counts surface in the preview block.
    await waitFor(() => {
      expect(
        screen.getByText("Will also move: 2 proposals, 1 documents, 3 tasks, 7 activities."),
      ).toBeTruthy();
    });
    expect(screen.getByText("This action cannot be undone.")).toBeTruthy();
    // Confirm is enabled once preview has loaded.
    const confirm = screen.getByRole("button", { name: "Confirm move" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);
  });

  it("on confirm: calls move action, fires success toast with moved counts, calls onMoved + router.refresh", async () => {
    const user = userEvent.setup();
    const { onOpenChange, onMoved } = renderDialog();

    const trigger = await findSelectTrigger();
    await user.click(trigger);
    await user.click(await screen.findByRole("option", { name: "Target Two" }));

    await waitFor(() => {
      const confirm = screen.getByRole("button", { name: "Confirm move" }) as HTMLButtonElement;
      expect(confirm.disabled).toBe(false);
    });

    await user.click(screen.getByRole("button", { name: "Confirm move" }));

    await waitFor(() => {
      expect(moveIdeaActionMock).toHaveBeenCalledWith(IDEA_UUID, PROJECT_C);
    });

    await waitFor(() => {
      expect(toastSuccess).toHaveBeenCalledWith(
        "Moved idea — 2 proposals, 1 documents, 3 tasks, 7 activities updated.",
        expect.objectContaining({
          action: expect.objectContaining({
            label: "View",
            onClick: expect.any(Function),
          }),
        }),
      );
    });

    // Action callback navigates to the moved idea's overview in the target
    // project — verifies the deep link shape (panel=<ideaUuid>&tab=overview).
    const toastArgs = toastSuccess.mock.calls[0];
    const onClick = toastArgs[1].action.onClick;
    onClick();
    expect(pushMock).toHaveBeenCalledWith(
      `/projects/${PROJECT_C}/dashboard?panel=${IDEA_UUID}&tab=overview`,
    );

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onMoved).toHaveBeenCalledWith({
      proposals: 2,
      documents: 1,
      tasks: 3,
      activities: 7,
    });
    expect(refreshMock).toHaveBeenCalled();
  });

  it("on move failure: keeps the dialog open and shows the error inline", async () => {
    const user = userEvent.setup();
    moveIdeaActionMock.mockResolvedValueOnce({ success: false, error: "boom" });
    const { onOpenChange } = renderDialog();

    const trigger = await findSelectTrigger();
    await user.click(trigger);
    await user.click(await screen.findByRole("option", { name: "Target One" }));

    await waitFor(() => {
      const confirm = screen.getByRole("button", { name: "Confirm move" }) as HTMLButtonElement;
      expect(confirm.disabled).toBe(false);
    });
    await user.click(screen.getByRole("button", { name: "Confirm move" }));
    await waitFor(() => expect(moveIdeaActionMock).toHaveBeenCalled());

    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(toastSuccess).not.toHaveBeenCalled();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Move failed: boom");
  });

  it("disables Confirm if the preview returns an error", async () => {
    const user = userEvent.setup();
    moveIdeaPreviewActionMock.mockResolvedValueOnce({ success: false, error: "no-go" });
    renderDialog();

    const trigger = await findSelectTrigger();
    await user.click(trigger);
    await user.click(await screen.findByRole("option", { name: "Target One" }));

    await waitFor(() => expect(moveIdeaPreviewActionMock).toHaveBeenCalled());
    // Confirm stays disabled because preview never settled successfully.
    await waitFor(() => {
      const confirm = screen.getByRole("button", { name: "Confirm move" }) as HTMLButtonElement;
      expect(confirm.disabled).toBe(true);
    });
  });
});
