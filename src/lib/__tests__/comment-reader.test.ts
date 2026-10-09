import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMMENT_READ_TIMEOUT_MS, getCommentPage } from "../comment-reader";

const failure = { success: false, error: "Failed to load comments" };
const comment = {
  uuid: "comment-1",
  targetType: "idea",
  targetUuid: "idea-1",
  content: "Hello",
  createdAt: "2026-10-09T10:00:00.000Z",
  updatedAt: "2026-10-09T10:00:00.000Z",
  author: {
    type: "agent",
    uuid: "agent-1",
    name: "Agent",
    owner: { uuid: "user-1", name: "Owner" },
  },
};
const page = {
  comments: [comment],
  total: 2,
  nextCursor: "comment-1",
  hasMore: true,
};

function response(body: unknown = { success: true, data: page }) {
  return { ok: true, json: vi.fn().mockResolvedValue(body) };
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("getCommentPage", () => {
  it.each(["idea", "proposal", "task", "document"] as const)(
    "reads %s pages independently with encoded parameters and attribution",
    async (targetType) => {
      fetchMock.mockResolvedValue(response() as unknown as Response);
      const result = await getCommentPage(targetType, "target &/?#中文", {
        cursor: "cursor +&/?#中文",
        limit: 25,
      });

      expect(result).toEqual({ success: true, ...page });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      const parsed = new URL(String(url), "https://chorus.test");
      expect(parsed.pathname).toBe("/api/comments");
      expect(Object.fromEntries(parsed.searchParams)).toEqual({
        targetType,
        targetUuid: "target &/?#中文",
        cursor: "cursor +&/?#中文",
        limit: "25",
      });
      expect(init).toEqual({
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
        signal: expect.any(AbortSignal),
      });
    },
  );

  it.each([undefined, null])("defaults to 10 and omits cursor %s", async (cursor) => {
    const emptyPage = { comments: [], total: 0, nextCursor: null, hasMore: false };
    fetchMock.mockResolvedValue(
      response({ success: true, data: emptyPage }) as unknown as Response,
    );
    expect(await getCommentPage("idea", "idea-1", { cursor })).toEqual({
      success: true,
      ...emptyPage,
    });
    expect(fetchMock.mock.calls[0][0]).toBe(
      "/api/comments?targetType=idea&targetUuid=idea-1&limit=10",
    );
  });

  it("accepts user attribution without an owner", async () => {
    const userPage = {
      ...page,
      comments: [{ ...comment, author: { type: "user", uuid: "user-1", name: "User" } }],
    };
    fetchMock.mockResolvedValue(response({ success: true, data: userPage }) as unknown as Response);
    expect(await getCommentPage("idea", "idea-1")).toEqual({ success: true, ...userPage });
  });

  it.each([401, 403, 404, 500])("handles HTTP %s without reading or exposing its body", async (status) => {
    const json = vi.fn();
    fetchMock.mockResolvedValue({ ok: false, status, json } as unknown as Response);
    expect(await getCommentPage("idea", "idea-1")).toEqual(failure);
    expect(json).not.toHaveBeenCalled();
  });

  it.each(["network", "json", "synchronous fetch"])("contains %s errors without logging", async (stage) => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnLog = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = new Error("sensitive transport details");
    if (stage === "network") fetchMock.mockRejectedValue(error);
    if (stage === "json") {
      fetchMock.mockResolvedValue({ ok: true, json: vi.fn().mockRejectedValue(error) } as unknown as Response);
    }
    if (stage === "synchronous fetch") fetchMock.mockImplementation(() => { throw error; });
    expect(await getCommentPage("idea", "idea-1")).toEqual(failure);
    expect(errorLog).not.toHaveBeenCalled();
    expect(warnLog).not.toHaveBeenCalled();
  });

  it.each([
    null,
    [],
    {},
    { success: false, error: "sensitive server details" },
    { success: "true", data: page },
    { success: true, data: null },
    ...[
      { comments: null },
      { comments: [null] },
      { comments: [{}] },
      { total: "2" },
      { total: -1 },
      { total: 1.5 },
      { total: Infinity },
      { nextCursor: undefined },
      { nextCursor: 123 },
      { nextCursor: "" },
      { nextCursor: null },
      { hasMore: "true" },
      { comments: [] },
    ].map((patch) => ({ success: true, data: { ...page, ...patch } })),
    ...[
      { uuid: null },
      { uuid: "" },
      { targetType: "unknown" },
      { targetUuid: null },
      { content: {} },
      { createdAt: "invalid date" },
      { updatedAt: null },
      { author: null },
      { author: { ...comment.author, type: "unknown" } },
      { author: { ...comment.author, uuid: null } },
      { author: { ...comment.author, name: {} } },
      { author: { ...comment.author, owner: null } },
      { author: { ...comment.author, owner: {} } },
      { author: { ...comment.author, owner: { uuid: "user-1", name: [] } } },
    ].map((patch) => ({ success: true, data: { ...page, comments: [{ ...comment, ...patch }] } })),
  ])("rejects malformed response %#", async (body) => {
    fetchMock.mockResolvedValue(response(body) as unknown as Response);
    expect(await getCommentPage("idea", "idea-1")).toEqual(failure);
  });

  it.each(["fetch", "body"])("bounds noncooperative pending %s with the same 15-second deadline", async (stage) => {
    const pending = deferred<Response>();
    const body = deferred<unknown>();
    fetchMock.mockReturnValue(pending.promise);
    const result = getCommentPage("idea", "idea-1");
    const settled = vi.fn();
    void result.then(settled);
    expect(COMMENT_READ_TIMEOUT_MS).toBe(15000);
    await vi.advanceTimersByTimeAsync(10000);
    if (stage === "body") {
      pending.resolve({ ok: true, json: () => body.promise } as Response);
    }
    await vi.advanceTimersByTimeAsync(4999);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toEqual(failure);
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it("does not fetch or install resources for a preaborted signal", async () => {
    const external = new AbortController();
    external.abort();
    const add = vi.spyOn(external.signal, "addEventListener");
    expect(await getCommentPage("idea", "idea-1", { signal: external.signal })).toEqual(failure);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
  });

  it.each(["fetch", "body"])("settles external abort during noncooperative %s", async (stage) => {
    const external = new AbortController();
    const pending = deferred<Response>();
    const body = deferred<unknown>();
    const json = vi.fn(() => body.promise);
    fetchMock.mockReturnValue(stage === "fetch" ? pending.promise : Promise.resolve({ ok: true, json } as unknown as Response));
    const result = getCommentPage("idea", "idea-1", { signal: external.signal });
    await vi.advanceTimersByTimeAsync(0);
    if (stage === "body") expect(json).toHaveBeenCalledOnce();
    external.abort("private cancellation reason");
    expect(await result).toEqual(failure);
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it.each(["success", "failure", "timeout", "abort"])("cleans up timer and external listener after %s", async (outcome) => {
    const external = new AbortController();
    const add = vi.spyOn(external.signal, "addEventListener");
    const remove = vi.spyOn(external.signal, "removeEventListener");
    if (outcome === "success") fetchMock.mockResolvedValue(response() as unknown as Response);
    else if (outcome === "failure") fetchMock.mockRejectedValue(new Error("network"));
    else fetchMock.mockReturnValue(new Promise(() => {}));
    const result = getCommentPage("idea", "idea-1", { signal: external.signal });
    if (outcome === "timeout") await vi.advanceTimersByTimeAsync(COMMENT_READ_TIMEOUT_MS);
    if (outcome === "abort") external.abort();
    await result;
    expect(remove).toHaveBeenCalledExactlyOnceWith("abort", add.mock.calls[0][1]);
    expect(vi.getTimerCount()).toBe(0);
    if (outcome === "success" || outcome === "failure") {
      external.abort();
      await vi.advanceTimersByTimeAsync(COMMENT_READ_TIMEOUT_MS);
      expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(false);
    }
  });

  it.each([
    ["fetch", "resolve"], ["fetch", "reject"],
    ["body", "resolve"], ["body", "reject"],
  ])("ignores late %s %s after timeout and permits independent retry", async (stage, outcome) => {
    const pending = deferred<Response>();
    const body = deferred<unknown>();
    const json = vi.fn(() => body.promise);
    fetchMock.mockReturnValueOnce(stage === "fetch" ? pending.promise : Promise.resolve({ ok: true, json } as unknown as Response));
    const result = getCommentPage("idea", "idea-1");
    await vi.advanceTimersByTimeAsync(COMMENT_READ_TIMEOUT_MS);
    expect(await result).toEqual(failure);
    fetchMock.mockResolvedValueOnce(response() as unknown as Response);
    expect(await getCommentPage("task", "task-2")).toEqual({ success: true, ...page });
    if (outcome === "reject") {
      (stage === "fetch" ? pending : body).reject(new Error("late private error"));
    } else if (stage === "fetch") {
      pending.resolve({ ok: true, json } as unknown as Response);
    } else {
      body.resolve({ success: true, data: page });
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(await result).toEqual(failure);
    if (stage === "fetch") expect(json).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls[0][1]?.signal).not.toBe(fetchMock.mock.calls[1][1]?.signal);
  });

  it("does not serialize simultaneous reads or share cancellation", async () => {
    const external = new AbortController();
    fetchMock.mockReturnValueOnce(new Promise(() => {}));
    fetchMock.mockResolvedValueOnce(response() as unknown as Response);
    const first = getCommentPage("idea", "idea-1", { signal: external.signal });
    expect(await getCommentPage("document", "document-1")).toEqual({ success: true, ...page });
    external.abort();
    expect(await first).toEqual(failure);
    expect(fetchMock.mock.calls[1][1]?.signal?.aborted).toBe(false);
  });
});
