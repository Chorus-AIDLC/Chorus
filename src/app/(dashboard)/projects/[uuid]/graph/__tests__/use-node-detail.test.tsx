// @vitest-environment jsdom
//
// Unit coverage for useNodeDetail (fetch-on-hover node-detail hook, design D3).
// Three behaviours under test:
//   1. Debounce — rapidly changing hoverId across several ids then settling
//      fires exactly ONE fetch, for the settled id (no request per id swept).
//   2. Cache — hovering the same uuid a second time does not refetch.
//   3. Abort / stale-safety — a stale earlier response can't overwrite the
//      newer hovered id's detail.
//
// Fake timers drive the ~200ms debounce; fetch is stubbed. The hook is
// framework-light (no canvas/DOM), so renderHook + rerender is enough.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useNodeDetail } from "../use-node-detail";

// Build a { success, data } envelope Response-like object.
function ok(data: Record<string, unknown>) {
  return {
    ok: true,
    json: async () => ({ success: true, data }),
  } as unknown as Response;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("useNodeDetail", () => {
  it("debounces a fast hover sweep into a single fetch for the settled id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok({ status: "open" }));
    vi.stubGlobal("fetch", fetchMock);

    const { result, rerender } = renderHook(
      ({ id }: { id: string | null }) => useNodeDetail(id, "task"),
      { initialProps: { id: "a" as string | null } },
    );

    // Sweep across several ids faster than the debounce window — each change
    // cancels the prior pending timer, so no fetch fires for ids passed over.
    rerender({ id: "b" });
    rerender({ id: "c" });
    rerender({ id: "d" });
    expect(fetchMock).not.toHaveBeenCalled();

    // Settle on "d" and let the debounce elapse.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/tasks/d",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    expect(result.current.detail).toEqual({ uuid: "d", status: "open" });
    expect(result.current.loading).toBe(false);
  });

  it("does not refetch a uuid that is already cached", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok({ status: "done" }));
    vi.stubGlobal("fetch", fetchMock);

    const { result, rerender } = renderHook(
      ({ id }: { id: string | null }) => useNodeDetail(id, "task"),
      { initialProps: { id: "x" as string | null } },
    );

    // First hover of "x" → one fetch, result cached.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(result.current.detail).toEqual({ uuid: "x", status: "done" });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Hover away, then back to "x" → cache hit, no second fetch, no loading.
    rerender({ id: null });
    rerender({ id: "x" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.loading).toBe(false);
    expect(result.current.detail).toEqual({ uuid: "x", status: "done" });
  });

  it("does not let a stale earlier response overwrite the newer hovered id", async () => {
    // Hand back deferred promises keyed by url so the test controls which
    // response resolves first. The first request (for the stale id) is made to
    // resolve LAST, after we've already hovered & resolved a newer id.
    const deferred = new Map<
      string,
      { resolve: (r: Response) => void; aborted: () => boolean }
    >();
    const fetchMock = vi.fn(
      (url: string, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((resolve) => {
          deferred.set(url, {
            resolve,
            aborted: () => init?.signal?.aborted ?? false,
          });
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { result, rerender } = renderHook(
      ({ id }: { id: string | null }) => useNodeDetail(id, "task"),
      { initialProps: { id: "stale" as string | null } },
    );

    // Fire the fetch for "stale" (debounce elapses) but DON'T resolve it yet.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/tasks/stale", expect.anything());

    // Move to a newer id "fresh"; this aborts the "stale" request and starts a
    // new fetch once its debounce elapses.
    rerender({ id: "fresh" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/tasks/fresh", expect.anything());

    // The newer ("fresh") response resolves first.
    await act(async () => {
      deferred.get("/api/tasks/fresh")!.resolve(ok({ status: "in_progress" }));
    });
    expect(result.current.detail).toEqual({
      uuid: "fresh",
      status: "in_progress",
    });

    // Now the stale request's response arrives LATE. Its signal was aborted on
    // the hover change, so the hook must ignore it and keep "fresh".
    const staleEntry = deferred.get("/api/tasks/stale")!;
    expect(staleEntry.aborted()).toBe(true);
    await act(async () => {
      staleEntry.resolve(ok({ status: "open" }));
    });

    expect(result.current.detail).toEqual({
      uuid: "fresh",
      status: "in_progress",
    });
  });

  it("maps a document node to docType rather than status", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok({ type: "prd" }));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useNodeDetail("doc1", "document"));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(result.current.detail).toEqual({ uuid: "doc1", docType: "prd" });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/documents/doc1",
      expect.anything(),
    );
  });
});
