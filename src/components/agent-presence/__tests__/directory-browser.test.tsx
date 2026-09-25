// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

import {
  DirectoryBrowser,
  validateDirectorySelection,
} from "@/components/agent-presence/directory-browser";

const instance = {
  connectionUuid: "connection-1",
  agentInstanceUuid: "instance-1",
  host: "build-host",
  cwd: "/workspace",
  effectiveStatus: "online" as const,
};

function success(result: Record<string, unknown>, uuid = "request-1") {
  return Promise.resolve({
    ok: true,
    json: async () => ({
      success: true,
      data: { request: { uuid, status: "success", result } },
    }),
  });
}

function deferredResponse() {
  let resolve!: (value: Awaited<ReturnType<typeof success>>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Awaited<ReturnType<typeof success>>>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function renderBrowser(instances = [instance], onValidated = vi.fn()) {
  return render(
    <DirectoryBrowser
      agentUuid="agent-1"
      instances={instances}
      onValidated={onValidated}
      confirmLabel="Confirm"
    />,
  );
}

async function loadRoot(fetchMock: ReturnType<typeof vi.fn>, roots = ["/work"]) {
  fetchMock.mockImplementationOnce(() => success({ roots }));
  renderBrowser();
  await waitFor(() => {
    expect((screen.getByRole("combobox", { name: "pathPrefix" }) as HTMLInputElement).value)
      .toBe(`${roots[0]}/`);
  });
}

describe("validateDirectorySelection", () => {
  const selection = {
    agentUuid: "agent-1",
    connectionUuid: "connection-1",
    host: "build-host",
    cwd: "/workspace",
  };
  const pending = () => Promise.resolve({
    ok: true,
    json: async () => ({
      success: true,
      data: { request: { uuid: "pending-1", status: "pending" } },
    }),
  });

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("forwards the same signal to POST and polling and cleans up completed delays", async () => {
    const controller = new AbortController();
    const addListener = vi.spyOn(controller.signal, "addEventListener");
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    const fetchMock = vi.fn()
      .mockImplementationOnce(pending)
      .mockImplementationOnce(() => success({ normalizedPath: "/normalized" }, "validation-1"));
    vi.stubGlobal("fetch", fetchMock);

    const validation = validateDirectorySelection(selection, controller.signal);
    await vi.advanceTimersByTimeAsync(300);
    await expect(validation).resolves.toEqual({
      ...selection, cwd: "/normalized", validationRequestUuid: "validation-1",
    });
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/daemon-directory-requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        operation: "validate",
        agentUuid: selection.agentUuid,
        targetConnectionUuid: selection.connectionUuid,
        cwd: selection.cwd,
      }),
      signal: controller.signal,
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2, "/api/daemon-directory-requests/pending-1", { signal: controller.signal },
    );
    expect(removeListener).toHaveBeenCalledWith("abort", addListener.mock.calls[0][1]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("remains compatible with callers that omit a signal", async () => {
    vi.stubGlobal("fetch", vi.fn(() => success({}, "validation-1")));
    await expect(validateDirectorySelection(selection)).resolves.toEqual({
      ...selection, validationRequestUuid: "validation-1",
    });
  });

  it("rejects an already aborted signal before POST", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    controller.abort("closed");
    await expect(validateDirectorySelection(selection, controller.signal))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels a polling delay immediately and removes its listener and timer", async () => {
    const controller = new AbortController();
    const addListener = vi.spyOn(controller.signal, "addEventListener");
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    const fetchMock = vi.fn(pending);
    vi.stubGlobal("fetch", fetchMock);
    const validation = validateDirectorySelection(selection, controller.signal);
    const rejection = expect(validation).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);

    controller.abort();
    await rejection;
    expect(removeListener).toHaveBeenCalledWith("abort", addListener.mock.calls[0][1]);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["POST", "resolve"], ["POST", "reject"],
    ["poll", "resolve"], ["poll", "reject"],
  ])("rejects a late %s %s as AbortError", async (phase, outcome) => {
    const controller = new AbortController();
    const deferred = deferredResponse();
    const fetchMock = vi.fn();
    if (phase === "poll") fetchMock.mockImplementationOnce(pending);
    fetchMock.mockReturnValueOnce(deferred.promise);
    vi.stubGlobal("fetch", fetchMock);
    const validation = validateDirectorySelection(selection, controller.signal);
    const rejection = expect(validation).rejects.toMatchObject({ name: "AbortError" });
    if (phase === "poll") await vi.advanceTimersByTimeAsync(300);
    controller.abort("closed");

    if (outcome === "resolve") {
      deferred.resolve(await success({ normalizedPath: "/late" }));
    } else {
      deferred.reject(new Error("late network failure"));
    }
    await rejection;
    expect(fetchMock).toHaveBeenCalledTimes(phase === "poll" ? 2 : 1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["resolve", "reject"])("checks cancellation after a late response body %s", async (outcome) => {
    const controller = new AbortController();
    let resolve!: (value: unknown) => void;
    let reject!: (error: Error) => void;
    const body = new Promise((done, fail) => { resolve = done; reject = fail; });
    const json = vi.fn(() => body);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json });
    vi.stubGlobal("fetch", fetchMock);
    const validation = validateDirectorySelection(selection, controller.signal);
    const rejection = expect(validation).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(0);
    expect(json).toHaveBeenCalled();
    controller.abort();
    if (outcome === "resolve") {
      resolve(await (await pending()).json());
    } else {
      reject(new Error("invalid response body"));
    }
    await rejection;
    expect(vi.getTimerCount()).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("DirectoryBrowser", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("can expose selection without rendering a confirm button", async () => {
    const fetchMock = vi.fn();
    const onSelectionChange = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockImplementationOnce(() => success({ roots: ["/work"] }, "roots-1"));
    render(
      <DirectoryBrowser
        agentUuid="agent-1"
        instances={[instance]}
        showConfirm={false}
        onSelectionChange={onSelectionChange}
        onValidated={vi.fn()}
      />,
    );

    await screen.findByRole("combobox", { name: "pathPrefix" });
    fireEvent.click(screen.getByRole("button", { name: /configuredCwd\/workspace/ }));

    expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();
    await waitFor(() => expect(onSelectionChange).toHaveBeenCalledWith({
      agentUuid: "agent-1",
      connectionUuid: "connection-1",
      host: "build-host",
      cwd: "/workspace",
    }));
  });

  it("exposes an edited custom path for project-submit validation", async () => {
    const fetchMock = vi.fn();
    const onSelectionChange = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockImplementationOnce(() => success({ roots: ["/work"] }, "roots-1"));
    render(
      <DirectoryBrowser
        agentUuid="agent-1"
        instances={[instance]}
        showConfirm={false}
        onSelectionChange={onSelectionChange}
        onValidated={vi.fn()}
      />,
    );

    const input = await screen.findByRole("combobox", { name: "pathPrefix" });
    await waitFor(() => expect((input as HTMLInputElement).value).toBe("/work/"));
    expect(onSelectionChange).not.toHaveBeenCalledWith(expect.objectContaining({
      cwd: "/work/",
    }));

    fireEvent.change(input, { target: { value: "/work/does-not-exist" } });

    await waitFor(() => expect(onSelectionChange).toHaveBeenCalledWith({
      agentUuid: "agent-1",
      connectionUuid: "connection-1",
      host: "build-host",
      cwd: "/work/does-not-exist",
    }));
    expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();
  });

  it("lists every daemon.json cwd and validates the exact selected connection", async () => {
    const fetchMock = vi.fn();
    const onValidated = vi.fn();
    const secondInstance = {
      ...instance,
      connectionUuid: "connection-2",
      agentInstanceUuid: "instance-2",
      cwd: "/strands-ai-sdk",
    };
    vi.stubGlobal("fetch", fetchMock);
    fetchMock
      .mockImplementationOnce(() => success({ roots: ["/work"] }, "roots-1"))
      .mockImplementationOnce(() =>
        success({ normalizedPath: "/strands-ai-sdk" }, "validation-1"),
      );
    renderBrowser([instance, secondInstance], onValidated);

    await screen.findByRole("combobox", { name: "pathPrefix" });
    expect(screen.getByRole("button", { name: /configuredCwd\/workspace/ }))
      .toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: /configuredCwd\/strands-ai-sdk/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(onValidated).toHaveBeenCalledWith({
      agentUuid: "agent-1",
      connectionUuid: "connection-2",
      host: "build-host",
      cwd: "/strands-ai-sdk",
      validationRequestUuid: "validation-1",
    }));
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({
      operation: "validate",
      targetConnectionUuid: "connection-2",
      cwd: "/strands-ai-sdk",
    });
  });

  it("prefills one root and debounces the bounded first-page query", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await loadRoot(fetchMock);
    fetchMock.mockImplementationOnce(() =>
      success({ items: [{ name: "repo", path: "/work/repo" }], nextCursor: null }),
    );

    fireEvent.change(screen.getByRole("combobox", { name: "pathPrefix" }), {
      target: { value: "/work/r" },
    });
    await act(() => vi.advanceTimersByTimeAsync(249));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(1));

    await waitFor(() => expect(screen.getByRole("option").textContent).toContain("/work/repo"));
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({
      operation: "list",
      prefix: "/work/r",
    });
  });

  it("defaults to the first of multiple roots and clears candidates when switching", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockImplementationOnce(() => success({ roots: ["/work", "/opt"] }));
    renderBrowser();
    const root = await screen.findByRole("combobox", { name: "browseRoot" });
    expect((root as HTMLSelectElement).value).toBe("/work");
    expect((screen.getByRole("combobox", { name: "pathPrefix" }) as HTMLInputElement).value)
      .toBe("/work/");

    fireEvent.change(root, { target: { value: "/opt" } });
    expect((screen.getByRole("combobox", { name: "pathPrefix" }) as HTMLInputElement).value)
      .toBe("/opt/");
    expect(document.getElementById("directory-candidates")).toBeNull();
  });

  it("uses the root platform separator when prefilling the path", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockImplementationOnce(() => success({ roots: ["C:\\work"] }));
    renderBrowser();

    await waitFor(() => {
      expect((screen.getByRole("combobox", { name: "pathPrefix" }) as HTMLInputElement).value)
        .toBe("C:\\work\\");
    });
  });

  it("falls back to manual path validation when roots are unavailable", async () => {
    const fetchMock = vi.fn();
    const onValidated = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockImplementationOnce(() => Promise.resolve({
      ok: false,
      json: async () => ({ success: false, error: { code: "INTERNAL_ERROR" } }),
    }));
    renderBrowser([instance], onValidated);

    const input = await screen.findByRole("combobox", { name: "pathPrefix" });
    expect(input.getAttribute("aria-autocomplete")).toBe("none");
    expect(screen.queryByRole("alert")).toBeNull();

    fireEvent.change(input, { target: { value: "/legacy/project" } });
    fetchMock.mockImplementationOnce(() =>
      success({ normalizedPath: "/legacy/project" }, "validation-legacy"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => {
      expect(onValidated).toHaveBeenCalledWith(expect.objectContaining({
        cwd: "/legacy/project",
        validationRequestUuid: "validation-legacy",
      }));
    });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({
      operation: "validate",
      cwd: "/legacy/project",
    });
  });

  it("discards stale success and stale error responses", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await loadRoot(fetchMock);
    const stale = deferredResponse();
    fetchMock.mockImplementationOnce(() => stale.promise);
    const input = screen.getByRole("combobox", { name: "pathPrefix" });
    fireEvent.change(input, { target: { value: "/work/a" } });
    await act(() => vi.advanceTimersByTimeAsync(250));

    fetchMock.mockImplementationOnce(() =>
      success({ items: [{ name: "about", path: "/work/about" }] }, "new"),
    );
    fireEvent.change(input, { target: { value: "/work/ab" } });
    await act(() => vi.advanceTimersByTimeAsync(250));
    await waitFor(() => expect(screen.getByRole("option").textContent).toContain("/work/about"));

    stale.resolve(await success({ items: [{ name: "archive", path: "/work/archive" }] }, "old"));
    await act(async () => {});
    expect(screen.getByRole("option").textContent).toContain("/work/about");
    expect(screen.queryByText("/work/archive")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("does not replace current candidates with an obsolete error", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await loadRoot(fetchMock);
    const stale = deferredResponse();
    fetchMock.mockImplementationOnce(() => stale.promise);
    const input = screen.getByRole("combobox", { name: "pathPrefix" });
    fireEvent.change(input, { target: { value: "/work/a" } });
    await act(() => vi.advanceTimersByTimeAsync(250));

    fetchMock.mockImplementationOnce(() =>
      success({ items: [{ name: "about", path: "/work/about" }] }, "new"),
    );
    fireEvent.change(input, { target: { value: "/work/ab" } });
    await act(() => vi.advanceTimersByTimeAsync(250));
    await screen.findByRole("option");

    stale.reject(new Error("TIMEOUT"));
    await act(async () => {});
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("option").textContent).toContain("/work/about");
  });

  it("highlights the first candidate and accepts it with Tab", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await loadRoot(fetchMock);
    fetchMock.mockImplementationOnce(() =>
      success({ items: [
        { name: "repo", path: "/work/repo" },
        { name: "runtime", path: "/work/runtime" },
      ] }),
    );
    const input = screen.getByRole("combobox", { name: "pathPrefix" });
    fireEvent.change(input, { target: { value: "/work/r" } });
    await act(() => vi.advanceTimersByTimeAsync(250));
    const options = await screen.findAllByRole("option");
    expect(options[0].getAttribute("aria-selected")).toBe("true");

    fireEvent.keyDown(input, { key: "Tab" });
    expect((input as HTMLInputElement).value).toBe("/work/repo/");
    expect(screen.getByText("/work/repo")).not.toBeNull();
  });

  it("scrolls the keyboard-highlighted candidate into view", async () => {
    const fetchMock = vi.fn();
    const scrollIntoView = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    await loadRoot(fetchMock);
    fetchMock.mockImplementationOnce(() =>
      success({
        items: Array.from({ length: 12 }, (_, index) => ({
          name: `repo-${index}`,
          path: `/work/repo-${index}`,
        })),
      }),
    );
    const input = screen.getByRole("combobox", { name: "pathPrefix" });
    fireEvent.change(input, { target: { value: "/work/r" } });
    await act(() => vi.advanceTimersByTimeAsync(250));
    await screen.findAllByRole("option");
    scrollIntoView.mockClear();

    for (let index = 0; index < 6; index += 1) {
      fireEvent.keyDown(input, { key: "ArrowDown" });
    }

    await waitFor(() => {
      expect(document.getElementById("directory-candidate-6")?.getAttribute("aria-selected"))
        .toBe("true");
      expect(scrollIntoView).toHaveBeenLastCalledWith({ block: "nearest" });
    });
  });

  it("preserves Tab and ignores completion keys during IME composition", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await loadRoot(fetchMock);
    fetchMock.mockImplementationOnce(() =>
      success({ items: [{ name: "repo", path: "/work/repo" }] }),
    );
    const input = screen.getByRole("combobox", { name: "pathPrefix" });
    fireEvent.change(input, { target: { value: "/work/r" } });
    await act(() => vi.advanceTimersByTimeAsync(250));
    await screen.findByRole("option");

    const ime = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
      isComposing: true,
    });
    input.dispatchEvent(ime);
    expect((input as HTMLInputElement).value).toBe("/work/r");

    fireEvent.keyDown(input, { key: "Escape" });
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    input.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(false);
  });

  it("shows stable typed errors for the current prefix", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await loadRoot(fetchMock);
    fetchMock.mockImplementationOnce(() => Promise.resolve({
      ok: false,
      json: async () => ({ success: false, error: { code: "OUTSIDE_ROOT" } }),
    }));
    fireEvent.change(screen.getByRole("combobox", { name: "pathPrefix" }), {
      target: { value: "/work/x" },
    });
    await act(() => vi.advanceTimersByTimeAsync(250));
    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("errors.OUTSIDE_ROOT");
    });
  });

  it("navigates to a parent but never above the selected root", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await loadRoot(fetchMock);
    const input = screen.getByRole("combobox", { name: "pathPrefix" });
    fireEvent.change(input, { target: { value: "/work/repo/src" } });
    fireEvent.click(screen.getByRole("button", { name: "parent" }));
    expect((input as HTMLInputElement).value).toBe("/work/repo/");
    fireEvent.click(screen.getByRole("button", { name: "parent" }));
    expect((input as HTMLInputElement).value).toBe("/work/");
    fireEvent.click(screen.getByRole("button", { name: "parent" }));
    expect((input as HTMLInputElement).value).toBe("/work/");
  });

  it("cancels and fences validation when the root changes", async () => {
    const fetchMock = vi.fn();
    const onValidated = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockImplementationOnce(() => success({ roots: ["/work", "/opt"] }));
    renderBrowser([instance], onValidated);
    await screen.findByRole("combobox", { name: "browseRoot" });

    fetchMock.mockImplementationOnce(() =>
      success({ items: [{ name: "repo", path: "/work/repo" }] }),
    );
    const input = screen.getByRole("combobox", { name: "pathPrefix" });
    fireEvent.change(input, { target: { value: "/work/r" } });
    await act(() => vi.advanceTimersByTimeAsync(250));
    await waitFor(() => expect(document.getElementById("directory-candidate-0")).not.toBeNull());
    fireEvent.click(document.getElementById("directory-candidate-0")!);

    const validation = deferredResponse();
    fetchMock.mockImplementationOnce(() => validation.promise);
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    const validationSignal = fetchMock.mock.calls.at(-1)?.[1]?.signal as AbortSignal;

    fireEvent.change(screen.getByRole("combobox", { name: "browseRoot" }), {
      target: { value: "/opt" },
    });
    expect(validationSignal.aborted).toBe(true);

    validation.resolve(await success({ normalizedPath: "/work/repo" }, "validation"));
    await act(async () => {});
    expect(onValidated).not.toHaveBeenCalled();
  });
});
