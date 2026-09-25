// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { forwardRef, StrictMode, useImperativeHandle, useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectAgentCwdDraft } from "@/components/project-agent-cwd-settings";

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
    { agentError, initialDrafts, onDraftsChange }: {
      agentError?: { agentUuid: string; message: string } | null;
      initialDrafts?: Record<string, ProjectAgentCwdDraft>;
      onDraftsChange?: (drafts: Record<string, ProjectAgentCwdDraft>) => void;
    },
    ref,
  ) {
    useImperativeHandle(ref, () => ({ validate }));
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

const successData = { success: true, data: { uuid: "project-1" } };

function response(data: unknown = successData, status = 201) {
  return new Response(JSON.stringify(data), { status });
}

function pendingBody(promise: Promise<unknown>) {
  return { ok: true, status: 201, json: () => promise } as Response;
}

function rejection(code = "CONFLICT", message = "Try again") {
  return response({ success: false, error: { code, message } }, 409);
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
    setOpen: (open: boolean) => view.rerender(
      <StrictMode><CreateProjectDialog {...props} open={open} /></StrictMode>,
    ),
    button: screen.getByRole("button", { name: "projectGroups.createProject" }),
    cancel: screen.getByRole("button", { name: "common.cancel" }),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  validate.mockReset().mockResolvedValue(cwdDrafts);
  refresh.mockReset();
  vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => response()));
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
      expect(cancel).toBeEnabled();
      expect(screen.getByText("common.creating")).toBeInTheDocument();

      await act(async () => validation.resolve(cwdDrafts));
      submitRepeatedly();
      expect(validate).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(cancel).toBeDisabled();
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
    "Agent error", "validation unexpected AbortError",
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
      case "validation unexpected AbortError":
        validate.mockRejectedValueOnce(new DOMException("Not this attempt's cancellation", "AbortError"));
        expectedError = "common.genericError";
        break;
      case "validation throw":
        validate.mockImplementationOnce(() => { throw new Error("validation failed"); });
        expectedError = "common.genericError";
        break;
      case "API error":
        vi.mocked(fetch).mockResolvedValueOnce(rejection("BAD_REQUEST", "Create failed"));
        expectedError = "Create failed";
        break;
      case "Agent error":
        vi.mocked(fetch).mockResolvedValueOnce(response({
          success: false,
          error: { code: "VALIDATION_ERROR", message: "Revalidate directory", details: { agentUuid: "agent-1" } },
        }, 400));
        expectedError = "agent-1: Revalidate directory";
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

    // A definitive failure still requires a user submission.
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

describe("CreateProjectDialog unconfirmed creation", () => {
  it.each([
    ["network failure", () => Promise.reject(new Error("offline"))],
    ["POST AbortError", () => Promise.reject(new DOMException("Connection aborted", "AbortError"))],
    ["invalid JSON", () => Promise.resolve(new Response("{", { status: 201 }))],
    ["5xx with known code", () => Promise.resolve(response({
      success: false, error: { code: "CONFLICT", message: "Unknown outcome" },
    }, 500))],
    ["4xx with unknown code", () => Promise.resolve(rejection("UNKNOWN"))],
    ["4xx without code", () => Promise.resolve(response({ success: false, error: { message: "Unknown outcome" } }, 400))],
    ["4xx legacy string error", () => Promise.resolve(response({ success: false, error: "Unknown outcome" }, 400))],
    ["2xx rejection envelope", () => Promise.resolve(response({ success: false, error: { code: "CONFLICT" } }))],
    ["malformed envelope", () => Promise.resolve(response(null))],
    ["missing project UUID", () => Promise.resolve(response({ success: true, data: {} }))],
    ["non-string project UUID", () => Promise.resolve(response({ success: true, data: { uuid: 123 } }))],
    ["missing success flag", () => Promise.resolve(response({ data: { uuid: "project-1" } }))],
    ["non-ok success envelope", () => Promise.resolve(response(successData, 500))],
  ] as const)("keeps %s locked until explicit confirmation, including after reopening", async (_label, result) => {
    vi.mocked(fetch).mockImplementationOnce(result);
    const { input, button, cancel, setOpen, onCreated, onOpenChange } = setup();
    fireEvent.change(screen.getByRole("textbox", { name: "cwd draft" }), {
      target: { value: "/draft/kept" },
    });
    await act(async () => fireEvent.click(button));
    expect(screen.getByRole("alert")).toHaveTextContent("projects.creationUnconfirmed");
    expect(screen.getByRole("alert")).toHaveTextContent("projects.creationRetryWarning");
    expect(button).toBeDisabled();
    expect(cancel).toBeEnabled();
    fireEvent.click(button);
    fireEvent.keyDown(input, { key: "Enter" });
    await act(async () => vi.advanceTimersByTime(60_000));
    expect(validate).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(onCreated).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    fireEvent.click(cancel);
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
    setOpen(false);
    setOpen(true);
    const reopenedInput = screen.getByPlaceholderText("projectGroups.projectTitlePlaceholder");
    const reopenedButton = screen.getByRole("button", { name: "projectGroups.createProject" });
    expect(reopenedInput).toHaveValue("  New project  ");
    expect(screen.getByPlaceholderText("projectGroups.projectDescriptionPlaceholder")).toHaveValue("  Description  ");
    expect(screen.getByRole("textbox", { name: "cwd draft" })).toHaveValue("/draft/kept");
    expect(reopenedButton).toBeDisabled();
    fireEvent.click(reopenedButton);
    fireEvent.keyDown(reopenedInput, { key: "Enter" });
    expect(validate).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "projects.confirmNewCreation" }));
    expect(reopenedButton).toBeEnabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(1);
    await act(async () => fireEvent.click(reopenedButton));
    expect(validate).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each(["request", "response body"] as const)(
    "bounds the entire POST including %s at 20 seconds without automatically retrying",
    async (stage) => {
      const request = deferred<Response>();
      const body = deferred<unknown>();
      vi.mocked(fetch).mockReturnValueOnce(request.promise);
      const { button, cancel, input, onCreated, onOpenChange, setOpen } = setup();
      await act(async () => fireEvent.click(button));
      await act(async () => vi.advanceTimersByTime(15_000));
      if (stage === "response body") {
        await act(async () => request.resolve(pendingBody(body.promise)));
      }
      await act(async () => vi.advanceTimersByTime(4_999));
      expect(cancel).toBeDisabled();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      await act(async () => vi.advanceTimersByTime(1));
      expect(screen.getByRole("alert")).toHaveTextContent("projects.creationUnconfirmed");
      expect(button).toBeDisabled();
      expect(cancel).toBeEnabled();
      fireEvent.keyDown(input, { key: "Enter" });
      await act(async () => vi.advanceTimersByTime(60_000));
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(validate).toHaveBeenCalledTimes(1);
      expect(onCreated).not.toHaveBeenCalled();
      expect(onOpenChange).not.toHaveBeenCalled();
      fireEvent.click(cancel);
      setOpen(false);
      setOpen(true);
      expect(screen.getByRole("button", { name: "projectGroups.createProject" })).toBeDisabled();
      expect(screen.getByRole("alert")).toHaveTextContent("projects.creationUnconfirmed");
    },
  );

  it.each([
    ["BAD_REQUEST", 400], ["UNAUTHORIZED", 401], ["FORBIDDEN", 403],
    ["NOT_FOUND", 404], ["CONFLICT", 409], ["VALIDATION_ERROR", 422],
  ] as const)("allows retry after definitive %s (%s)", async (code, status) => {
    vi.mocked(fetch).mockResolvedValueOnce(response({
      success: false, error: { code },
    }, status));
    const { button } = setup();
    await act(async () => fireEvent.click(button));
    expect(button).toBeEnabled();
    expect(screen.getByText("projects.createFailed")).toBeInTheDocument();
    expect(screen.queryByText("projects.creationUnconfirmed")).not.toBeInTheDocument();
    await act(async () => fireEvent.click(button));
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe("CreateProjectDialog stale attempts", () => {
  it.each(["validation", "success feedback"] as const)(
    "late old success cannot release a newer attempt during %s",
    async (stage) => {
      const oldRequest = deferred<Response>();
      const validation = deferred<typeof cwdDrafts>();
      vi.mocked(fetch).mockReturnValueOnce(oldRequest.promise);
      const { button, onCreated, onOpenChange } = setup();
      await act(async () => fireEvent.click(button));
      await act(async () => vi.advanceTimersByTime(20_000));
      fireEvent.click(screen.getByRole("button", { name: "projects.confirmNewCreation" }));
      if (stage === "validation") validate.mockReturnValueOnce(validation.promise);
      await act(async () => fireEvent.click(button));
      await act(async () => oldRequest.resolve(response()));
      await act(async () => vi.advanceTimersByTime(599));
      expect(button).toBeDisabled();
      fireEvent.keyDown(screen.getByPlaceholderText("projectGroups.projectTitlePlaceholder"), { key: "Enter" });
      expect(validate).toHaveBeenCalledTimes(2);
      expect(fetch).toHaveBeenCalledTimes(stage === "validation" ? 1 : 2);
      expect(onOpenChange).not.toHaveBeenCalled();
      expect(onCreated).toHaveBeenCalledTimes(1);
      expect(refresh).toHaveBeenCalledTimes(1);
      if (stage === "validation") await act(async () => validation.resolve(cwdDrafts));
      await act(async () => vi.advanceTimersByTime(stage === "validation" ? 600 : 1));
      expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
      expect(onCreated).toHaveBeenCalledTimes(2);
      expect(refresh).toHaveBeenCalledTimes(2);
    },
  );

  it.each(["success", "null", "rejection"] as const)(
    "ignores old validation %s after host closure and a new validation",
    async (outcome) => {
      const oldValidation = deferred<typeof cwdDrafts | null>();
      const newValidation = deferred<typeof cwdDrafts>();
      validate.mockReturnValueOnce(oldValidation.promise).mockReturnValueOnce(newValidation.promise);
      const { button, setOpen, onOpenChange, onCreated } = setup();
      fireEvent.click(button);
      const oldSignal = validate.mock.calls[0][0] as AbortSignal;
      setOpen(false);
      expect(oldSignal.aborted).toBe(true);
      setOpen(true);
      const input = screen.getByPlaceholderText("projectGroups.projectTitlePlaceholder");
      fireEvent.keyDown(input, { key: "Enter" });
      const newSignal = validate.mock.calls[1][0] as AbortSignal;
      expect(newSignal).not.toBe(oldSignal);
      expect(newSignal.aborted).toBe(false);
      await act(async () => {
        if (outcome === "rejection") oldValidation.reject(new Error("stale validation"));
        else oldValidation.resolve(outcome === "null" ? null : cwdDrafts);
      });
      expect(fetch).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "common.creating" })).toBeDisabled();
      expect(screen.queryByText("common.genericError")).not.toBeInTheDocument();
      fireEvent.keyDown(input, { key: "Enter" });
      expect(validate).toHaveBeenCalledTimes(2);
      await act(async () => newValidation.resolve(cwdDrafts));
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(onOpenChange).not.toHaveBeenCalled();
      expect(onCreated).not.toHaveBeenCalled();
    },
  );

  it.each(["success", "definitive rejection", "network rejection", "JSON rejection", "unknown response"] as const)(
    "late old %s cannot close or unlock a reopened dialog with a new POST",
    async (outcome) => {
      const oldRequest = deferred<Response>();
      const newRequest = deferred<Response>();
      vi.mocked(fetch).mockReturnValueOnce(oldRequest.promise).mockReturnValueOnce(newRequest.promise);
      const { button, setOpen, onCreated, onOpenChange } = setup();
      await act(async () => fireEvent.click(button));
      await act(async () => vi.advanceTimersByTime(20_000));
      fireEvent.click(screen.getByRole("button", { name: "common.cancel" }));
      setOpen(false);
      setOpen(true);
      onOpenChange.mockClear();
      fireEvent.click(screen.getByRole("button", { name: "projects.confirmNewCreation" }));
      const input = screen.getByPlaceholderText("projectGroups.projectTitlePlaceholder");
      fireEvent.change(input, { target: { value: "New attempt draft" } });
      await act(async () => fireEvent.keyDown(input, { key: "Enter" }));
      // Settle the old request near the new request's deadline to catch stale timer cleanup.
      await act(async () => vi.advanceTimersByTime(19_000));
      await act(async () => {
        if (outcome === "network rejection") oldRequest.reject(new Error("old network failure"));
        else if (outcome === "JSON rejection") oldRequest.resolve(new Response("{", { status: 201 }));
        else if (outcome === "definitive rejection") oldRequest.resolve(rejection("CONFLICT", "Old error"));
        else oldRequest.resolve(response(outcome === "success" ? successData : {}));
      });
      await act(async () => vi.advanceTimersByTime(600));
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(input).toHaveValue("New attempt draft");
      expect(screen.getByRole("button", { name: "common.creating" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "common.cancel" })).toBeDisabled();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(screen.queryByText("Old error")).not.toBeInTheDocument();
      expect(screen.queryByText("common.genericError")).not.toBeInTheDocument();
      fireEvent.keyDown(input, { key: "Enter" });
      expect(validate).toHaveBeenCalledTimes(2);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(onOpenChange).not.toHaveBeenCalled();
      expect(onCreated).toHaveBeenCalledTimes(outcome === "success" ? 1 : 0);
      expect(refresh).toHaveBeenCalledTimes(outcome === "success" ? 1 : 0);
      await act(async () => vi.advanceTimersByTime(400));
      expect(screen.getByRole("alert")).toHaveTextContent("projects.creationUnconfirmed");
      expect(screen.getByRole("button", { name: "projectGroups.createProject" })).toBeDisabled();
    },
  );

  it.each(["success", "rejection"] as const)(
    "late old %s preserves a newer definitive error",
    async (outcome) => {
      const oldRequest = deferred<Response>();
      vi.mocked(fetch).mockReturnValueOnce(oldRequest.promise).mockResolvedValueOnce(
        rejection("CONFLICT", "New attempt error"),
      );
      const { button, onCreated, onOpenChange } = setup();
      await act(async () => fireEvent.click(button));
      await act(async () => vi.advanceTimersByTime(20_000));
      fireEvent.click(screen.getByRole("button", { name: "projects.confirmNewCreation" }));
      await act(async () => fireEvent.click(button));
      await act(async () => {
        oldRequest.resolve(outcome === "success" ? response() : rejection("CONFLICT", "Old error"));
      });
      await act(async () => vi.advanceTimersByTime(600));
      expect(screen.getByText("New attempt error")).toBeInTheDocument();
      expect(screen.queryByText("Old error")).not.toBeInTheDocument();
      expect(button).toBeEnabled();
      expect(onOpenChange).not.toHaveBeenCalled();
      expect(onCreated).toHaveBeenCalledTimes(outcome === "success" ? 1 : 0);
    },
  );

  it.each(["unconfirmed", "success feedback"] as const)(
    "a success after dismissal during %s only refreshes and retains the reopened draft",
    async (stage) => {
      const request = deferred<Response>();
      vi.mocked(fetch).mockReturnValueOnce(request.promise);
      const { button, setOpen, onCreated, onOpenChange } = setup();
      fireEvent.change(screen.getByRole("textbox", { name: "cwd draft" }), {
        target: { value: "/draft/kept" },
      });
      await act(async () => fireEvent.click(button));
      if (stage === "unconfirmed") await act(async () => vi.advanceTimersByTime(20_000));
      else await act(async () => request.resolve(response()));
      // Hosts can change the controlled open prop even while success feedback is locked.
      setOpen(false);
      setOpen(true);
      const input = screen.getByPlaceholderText("projectGroups.projectTitlePlaceholder");
      fireEvent.change(input, { target: { value: "Reopened draft" } });
      if (stage === "unconfirmed") await act(async () => request.resolve(response()));
      await act(async () => vi.advanceTimersByTime(600));
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(input).toHaveValue("Reopened draft");
      expect(screen.getByRole("textbox", { name: "cwd draft" })).toHaveValue("/draft/kept");
      expect(onOpenChange).not.toHaveBeenCalled();
      expect(onCreated).toHaveBeenCalledTimes(1);
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("alert")).toHaveTextContent("projects.creationConfirmed");
      fireEvent.keyDown(input, { key: "Enter" });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("button", { name: "projectGroups.createProject" })).toBeDisabled();
    },
  );

  it.each(["unconfirmed", "posting", "success feedback"] as const)(
    "requires an explicit new operation when %s succeeds while closed",
    async (stage) => {
      const request = deferred<Response>();
      vi.mocked(fetch).mockReturnValueOnce(request.promise);
      const { button, setOpen, onCreated, onOpenChange } = setup();
      await act(async () => fireEvent.click(button));
      if (stage === "unconfirmed") await act(async () => vi.advanceTimersByTime(20_000));
      if (stage === "success feedback") await act(async () => request.resolve(response()));
      setOpen(false);
      if (stage !== "success feedback") await act(async () => request.resolve(response()));
      await act(async () => vi.advanceTimersByTime(600));
      expect(onCreated).toHaveBeenCalledTimes(1);
      expect(onOpenChange).not.toHaveBeenCalled();
      setOpen(true);
      expect(screen.getByRole("alert")).toHaveTextContent("projects.creationConfirmed");
      expect(screen.queryByText("projects.creationRetryWarning")).not.toBeInTheDocument();
      const input = screen.getByPlaceholderText("projectGroups.projectTitlePlaceholder");
      expect(input).toHaveValue("  New project  ");
      const submit = screen.getByRole("button", { name: "projectGroups.createProject" });
      expect(submit).toBeDisabled();
      fireEvent.keyDown(input, { key: "Enter" });
      fireEvent.click(submit);
      expect(fetch).toHaveBeenCalledTimes(1);
      // A second close/reopen must not reset the acknowledgement.
      fireEvent.click(screen.getByRole("button", { name: "common.cancel" }));
      setOpen(false);
      setOpen(true);
      expect(screen.getByRole("alert")).toHaveTextContent("projects.creationConfirmed");
      fireEvent.click(screen.getByRole("button", { name: "projects.confirmAnotherCreation" }));
      expect(fetch).toHaveBeenCalledTimes(1);
      await act(async () => fireEvent.keyDown(
        screen.getByPlaceholderText("projectGroups.projectTitlePlaceholder"), { key: "Enter" },
      ));
      expect(fetch).toHaveBeenCalledTimes(2);
    },
  );
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
    "permits %s after timeout while keeping submission locked on reopen",
    async (method) => {
      vi.mocked(fetch).mockReturnValueOnce(deferred<Response>().promise);
      const { button, cancel, onOpenChange, setOpen } = setup();
      await act(async () => fireEvent.click(button));
      await act(async () => vi.advanceTimersByTime(20_000));
      await dismiss(method, cancel);
      expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
      setOpen(false);
      setOpen(true);
      expect(screen.getByRole("button", { name: "projectGroups.createProject" })).toBeDisabled();
      expect(screen.getByRole("alert")).toHaveTextContent("projects.creationUnconfirmed");
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["Cancel", "Escape", "outside pointer"])(
    "%s aborts validation and preserves all drafts across close and reopen",
    async (method) => {
      const validation = deferred<typeof cwdDrafts>();
      validate.mockReturnValueOnce(validation.promise);
      const { button, cancel, onOpenChange, setOpen } = setup();
      fireEvent.change(screen.getByRole("textbox", { name: "cwd draft" }), {
        target: { value: "/draft/kept" },
      });
      fireEvent.click(button);
      const signal = validate.mock.calls[0][0] as AbortSignal;
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal.aborted).toBe(false);
      await dismiss(method, cancel);
      expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
      expect(signal.aborted).toBe(true);
      setOpen(false);
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      setOpen(true);
      expect(screen.getByPlaceholderText("projectGroups.projectTitlePlaceholder")).toHaveValue("  New project  ");
      expect(screen.getByPlaceholderText("projectGroups.projectDescriptionPlaceholder")).toHaveValue("  Description  ");
      expect(screen.getByRole("textbox", { name: "cwd draft" })).toHaveValue("/draft/kept");
      expect(screen.getByRole("button", { name: "projectGroups.createProject" })).toBeEnabled();
      await act(async () => validation.resolve(cwdDrafts));
      expect(fetch).not.toHaveBeenCalled();
      expect(screen.queryByText("common.genericError")).not.toBeInTheDocument();
    },
  );

  it.each(["Cancel", "Escape", "outside pointer"])(
    "blocks %s during POST and success feedback and permits it after definitive rejection",
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
      await act(async () => validation.resolve(cwdDrafts));
      await dismiss(method, cancel);
      expect(onOpenChange).not.toHaveBeenCalled();

      await act(async () => request.resolve(rejection()));
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
    fireEvent.change(screen.getByRole("textbox", { name: "cwd draft" }), {
      target: { value: "/draft/to-reset" },
    });
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
    expect(screen.getByRole("textbox", { name: "cwd draft" })).toHaveValue("/workspace");
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
      const body = deferred<typeof successData>();
      if (phase === "validation") validate.mockReturnValueOnce(validation.promise);
      if (phase === "request") vi.mocked(fetch).mockReturnValueOnce(request.promise);
      if (phase === "response body") {
        vi.mocked(fetch).mockResolvedValueOnce(pendingBody(body.promise));
      }
      const old = setup();
      await act(async () => fireEvent.click(old.button));
      const signal = validate.mock.calls[0][0] as AbortSignal;
      old.unmount();
      expect(signal.aborted).toBe(true);
      const fresh = setup();
      await act(async () => {
        validation.resolve(cwdDrafts);
        request.resolve(response());
        body.resolve(successData);
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
        vi.mocked(fetch).mockResolvedValueOnce(pendingBody(pending.promise));
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
