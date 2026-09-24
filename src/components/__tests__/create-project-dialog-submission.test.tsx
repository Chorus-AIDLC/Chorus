// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { forwardRef, StrictMode, useImperativeHandle, useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { validate, refresh } = vi.hoisted(() => ({
  validate: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("@/hooks/use-progress-router", () => ({
  useRouter: () => ({ refresh }),
}));
// Keep timing assertions about the submission lifecycle, not animation frames.
vi.mock("framer-motion", () => ({
  AnimatePresence: ({ children }: { children: ReactNode }) => children,
  motion: {
    span: ({ children, className }: { children: ReactNode; className?: string }) => (
      <span className={className}>{children}</span>
    ),
  },
}));
vi.mock("@/components/project-agent-cwd-settings", () => ({
  ProjectAgentCwdSettings: forwardRef(function MockCwdSettings(
    { agentError }: { agentError?: { agentUuid: string; message: string } | null },
    ref,
  ) {
    useImperativeHandle(ref, () => ({ validate }));
    return (
      <div>
        <input aria-label="cwd draft" defaultValue="/workspace" />
        {agentError && <p role="alert">{agentError.agentUuid}: {agentError.message}</p>}
      </div>
    );
  }),
}));

import { CreateProjectDialog } from "@/components/create-project-dialog";

const cwdDrafts = {
  upserts: [{
    agentUuid: "agent-1",
    connectionUuid: "connection-1",
    host: "host-1",
    cwd: "/workspace",
    validationRequestUuid: "validation-1",
  }],
  clears: [],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function response(data: unknown = { success: true }) {
  return { json: vi.fn().mockResolvedValue(data) } as unknown as Response;
}

function setup() {
  const onOpenChange = vi.fn();
  const onCreated = vi.fn();
  const props = { open: true, onOpenChange, onCreated, groupUuid: "group-1", groupName: "Group 1" };
  const view = render(<StrictMode><CreateProjectDialog {...props} /></StrictMode>);
  const input = screen.getByPlaceholderText("projectGroups.projectTitlePlaceholder");
  const description = screen.getByPlaceholderText("projectGroups.projectDescriptionPlaceholder");
  fireEvent.change(input, { target: { value: "  New project  " } });
  fireEvent.change(description, { target: { value: "  Description  " } });
  return {
    ...view, props, input, description, onOpenChange, onCreated,
    button: screen.getByRole("button", { name: "projectGroups.createProject" }),
    cancel: screen.getByRole("button", { name: "common.cancel" }),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  validate.mockReset().mockResolvedValue(cwdDrafts);
  refresh.mockReset();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response()));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("CreateProjectDialog submission exclusion", () => {
  it.each(["click", "Enter", "mixed", "key repeat"] as const)(
    "excludes repeated %s events during validation, POST and success feedback",
    async (gesture) => {
      const validation = deferred<typeof cwdDrafts>();
      const request = deferred<Response>();
      validate.mockReturnValue(validation.promise);
      vi.mocked(fetch).mockReturnValue(request.promise);
      const { input, button, cancel, onOpenChange, onCreated } = setup();
      const submitRepeatedly = () => {
        act(() => {
          for (let i = 0; i < 5; i++) {
            if (gesture === "click" || (gesture === "mixed" && i % 2 === 0)) {
              fireEvent.click(button);
            } else {
              fireEvent.keyDown(input, { key: "Enter", repeat: gesture === "key repeat" && i > 0 });
            }
          }
        });
      };

      submitRepeatedly();
      expect(validate).toHaveBeenCalledTimes(1);
      expect(fetch).not.toHaveBeenCalled();
      expect(button).toBeDisabled();
      expect(cancel).toBeDisabled();
      expect(screen.getByText("common.creating")).toBeInTheDocument();

      await act(async () => validation.resolve(cwdDrafts));
      submitRepeatedly();
      expect(validate).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(onOpenChange).not.toHaveBeenCalled();

      await act(async () => request.resolve(response()));
      expect(screen.queryByText("common.creating")).not.toBeInTheDocument();
      submitRepeatedly();
      await act(async () => vi.advanceTimersByTime(599));
      submitRepeatedly();
      expect(button).toBeDisabled();
      expect(cancel).toBeDisabled();
      expect(validate).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(onOpenChange).not.toHaveBeenCalled();
      expect(onCreated).not.toHaveBeenCalled();
      expect(refresh).not.toHaveBeenCalled();

      await act(async () => vi.advanceTimersByTime(1));
      expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
      expect(onCreated).toHaveBeenCalledTimes(1);
      expect(refresh).toHaveBeenCalledTimes(1);
    },
  );

  it("snapshots trimmed title, description and group before validation and sends validated cwd references", async () => {
    const validation = deferred<typeof cwdDrafts>();
    validate.mockReturnValue(validation.promise);
    const { input, description, button, rerender, props } = setup();
    fireEvent.click(button);
    fireEvent.change(input, { target: { value: "Edited later" } });
    fireEvent.change(description, { target: { value: "Later description" } });
    rerender(<StrictMode><CreateProjectDialog {...props} groupUuid="group-2" /></StrictMode>);
    await act(async () => validation.resolve(cwdDrafts));
    expect(fetch).toHaveBeenCalledExactlyOnceWith("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "New project",
        description: "Description",
        groupUuid: "group-1",
        agentCwds: [{ agentUuid: "agent-1", validationRequestUuid: "validation-1" }],
      }),
    });
  });

  it("ignores blank titles and both native and legacy IME Enter signals", async () => {
    const { input, button } = setup();
    fireEvent.change(input, { target: { value: " \t " } });
    fireEvent.click(button);
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.change(input, { target: { value: "测试" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    expect(validate).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    await act(async () => fireEvent.keyDown(input, { key: "Enter", keyCode: 13 }));
    expect(validate).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("CreateProjectDialog error recovery", () => {
  it.each([
    "validation null", "validation rejection", "validation throw", "API error",
    "Agent error", "fetch rejection", "JSON rejection",
  ])("preserves drafts and allows a deliberate retry after %s", async (failure) => {
    let expectedError: string | null = null;
    switch (failure) {
      case "validation null":
        validate.mockResolvedValueOnce(null);
        break;
      case "validation rejection":
        validate.mockRejectedValueOnce(new Error("validation failed"));
        expectedError = "common.genericError";
        break;
      case "validation throw":
        validate.mockImplementationOnce(() => { throw new Error("validation failed"); });
        expectedError = "common.genericError";
        break;
      case "API error":
        vi.mocked(fetch).mockResolvedValueOnce(response({ success: false, error: "Create failed" }));
        expectedError = "Create failed";
        break;
      case "Agent error":
        vi.mocked(fetch).mockResolvedValueOnce(response({
          success: false,
          error: { message: "Revalidate directory", details: { agentUuid: "agent-1" } },
        }));
        expectedError = "agent-1: Revalidate directory";
        break;
      case "fetch rejection":
        vi.mocked(fetch).mockRejectedValueOnce(new Error("offline"));
        expectedError = "common.genericError";
        break;
      case "JSON rejection":
        vi.mocked(fetch).mockResolvedValueOnce({
          json: vi.fn().mockRejectedValue(new Error("invalid JSON")),
        } as unknown as Response);
        expectedError = "common.genericError";
        break;
    }
    const { input, description, button, cancel, onOpenChange } = setup();
    const cwd = screen.getByRole("textbox", { name: "cwd draft" });
    fireEvent.change(cwd, { target: { value: "/draft/kept" } });
    await act(async () => fireEvent.click(button));
    expect(button).toBeEnabled();
    expect(cancel).toBeEnabled();
    expect(input).toHaveValue("  New project  ");
    expect(description).toHaveValue("  Description  ");
    expect(cwd).toHaveValue("/draft/kept");
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(validate).toHaveBeenCalledTimes(1);
    const failedPostCount = failure.startsWith("validation") ? 0 : 1;
    expect(fetch).toHaveBeenCalledTimes(failedPostCount);
    if (expectedError) expect(screen.getByText(expectedError)).toBeInTheDocument();
    if (failure === "Agent error") expect(screen.getByRole("alert")).toHaveTextContent(expectedError!);

    // Waiting never retries an ambiguous failure automatically.
    await act(async () => vi.advanceTimersByTime(1000));
    expect(fetch).toHaveBeenCalledTimes(failedPostCount);
    await act(async () => fireEvent.keyDown(input, { key: "Enter" }));
    expect(validate).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledTimes(failedPostCount + 1);
    if (expectedError) expect(screen.queryByText(expectedError)).not.toBeInTheDocument();
    await act(async () => vi.advanceTimersByTime(600));
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
  });
});

describe("CreateProjectDialog dismissal and lifetime", () => {
  async function dismiss(method: string, cancel: HTMLElement) {
    // Radix registers its outside-pointer listener on the next timer tick.
    await act(async () => vi.advanceTimersByTime(0));
    if (method === "Cancel") fireEvent.click(cancel);
    if (method === "Escape") fireEvent.keyDown(document, { key: "Escape" });
    if (method === "outside pointer") {
      fireEvent.pointerDown(document.body, { pointerType: "mouse", button: 0 });
    }
  }

  it.each(["Cancel", "Escape", "outside pointer"])(
    "blocks %s during every active phase and permits it after failure",
    async (method) => {
      const validation = deferred<typeof cwdDrafts>();
      const request = deferred<Response>();
      validate.mockReturnValueOnce(validation.promise);
      vi.mocked(fetch).mockReturnValueOnce(request.promise);
      const { button, cancel, onOpenChange } = setup();

      // Control: this gesture really reaches the production Radix dialog.
      await dismiss(method, cancel);
      expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
      onOpenChange.mockClear();
      fireEvent.click(button);
      await dismiss(method, cancel);
      expect(onOpenChange).not.toHaveBeenCalled();
      await act(async () => validation.resolve(cwdDrafts));
      await dismiss(method, cancel);
      expect(onOpenChange).not.toHaveBeenCalled();

      await act(async () => request.resolve(response({ success: false, error: "Try again" })));
      await dismiss(method, cancel);
      expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
      onOpenChange.mockClear();
      await act(async () => fireEvent.click(button));
      await dismiss(method, cancel);
      expect(onOpenChange).not.toHaveBeenCalled();
      await act(async () => vi.advanceTimersByTime(600));
      expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
    },
  );

  it("resets after successful closure and accepts the same name in a newly selected group", async () => {
    function Host() {
      const [open, setOpen] = useState(true);
      const [groupUuid, setGroupUuid] = useState<string | null>(null);
      return (
        <>
          <button onClick={() => { setGroupUuid("group-2"); setOpen(true); }}>Reopen</button>
          <CreateProjectDialog open={open} onOpenChange={setOpen} groupUuid={groupUuid} groupName="" />
        </>
      );
    }
    render(<Host />);
    const title = () => screen.getByPlaceholderText("projectGroups.projectTitlePlaceholder");
    fireEvent.change(title(), { target: { value: "Same name" } });
    await act(async () => fireEvent.keyDown(title(), { key: "Enter" }));
    expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string)).toEqual({
      name: "Same name",
      agentCwds: [{ agentUuid: "agent-1", validationRequestUuid: "validation-1" }],
    });
    await act(async () => vi.advanceTimersByTime(600));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reopen" }));
    expect(title()).toHaveValue("");
    expect(screen.getByPlaceholderText("projectGroups.projectDescriptionPlaceholder")).toHaveValue("");
    fireEvent.change(title(), { target: { value: "Same name" } });
    await act(async () => fireEvent.keyDown(title(), { key: "Enter" }));
    expect(validate).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(vi.mocked(fetch).mock.calls[1][1]!.body as string)).toMatchObject({
      name: "Same name", groupUuid: "group-2",
    });
    await act(async () => vi.advanceTimersByTime(600));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it.each(["validation", "request", "response body", "success timer"])(
    "ignores stale %s completion after unmount and leaves a new dialog untouched",
    async (phase) => {
      const validation = deferred<typeof cwdDrafts>();
      const request = deferred<Response>();
      const body = deferred<{ success: boolean }>();
      if (phase === "validation") validate.mockReturnValueOnce(validation.promise);
      if (phase === "request") vi.mocked(fetch).mockReturnValueOnce(request.promise);
      if (phase === "response body") {
        vi.mocked(fetch).mockResolvedValueOnce({ json: () => body.promise } as unknown as Response);
      }
      const old = setup();
      await act(async () => fireEvent.click(old.button));
      old.unmount();
      const fresh = setup();
      await act(async () => {
        validation.resolve(cwdDrafts);
        request.resolve(response());
        body.resolve({ success: true });
      });
      await act(async () => vi.advanceTimersByTime(1000));
      expect(fetch).toHaveBeenCalledTimes(phase === "validation" ? 0 : 1);
      expect(old.onOpenChange).not.toHaveBeenCalled();
      expect(old.onCreated).not.toHaveBeenCalled();
      expect(fresh.onOpenChange).not.toHaveBeenCalled();
      expect(refresh).not.toHaveBeenCalled();
      expect(fresh.input).toHaveValue("  New project  ");
      expect(fresh.button).toBeEnabled();
    },
  );

  it.each(["validation", "request", "response body"])(
    "handles a late %s rejection after unmount without running callbacks",
    async (phase) => {
      const pending = deferred<never>();
      if (phase === "validation") validate.mockReturnValueOnce(pending.promise);
      if (phase === "request") vi.mocked(fetch).mockReturnValueOnce(pending.promise);
      if (phase === "response body") {
        vi.mocked(fetch).mockResolvedValueOnce({ json: () => pending.promise } as unknown as Response);
      }
      const { button, unmount, onOpenChange, onCreated } = setup();
      await act(async () => fireEvent.click(button));
      unmount();
      await act(async () => pending.reject(new Error("late failure")));
      await act(async () => vi.advanceTimersByTime(1000));
      expect(onOpenChange).not.toHaveBeenCalled();
      expect(onCreated).not.toHaveBeenCalled();
      expect(refresh).not.toHaveBeenCalled();
    },
  );
});
