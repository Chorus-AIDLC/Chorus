// @vitest-environment jsdom
//
// Regression guard for the code-review-gateway BLOCKER: the top navigation
// progress bar flashing on router.refresh().
//
// Root cause (pre-fix): the wrapper returned BProgress's extended router as-is.
// BProgress guards same-URL navigations only for push/replace (its
// `createHandler`); back/forward/refresh go through `createNoHrefHandler`, which
// has NO same-URL guard and starts the bar unconditionally. router.refresh() is
// definitionally a same-URL operation fired at ~54 call sites after mutations,
// so the bar flashed on the current page every time — violating the spec's
// "same-URL navigation MUST NOT show the bar".
//
// The fix: the wrapper overrides refresh() to call the underlying
// refresh({ showProgress: false }), which BProgress honors per-call by skipping
// the bar while still refreshing. push/replace/back/forward are left untouched
// (back/forward are real cross-URL navigations that SHOULD show the bar).

import { describe, expect, it, beforeEach, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useRouter } from "../use-progress-router";

// Spies for the underlying BProgress router methods. The wrapper is expected to
// pass them through unchanged except for refresh.
const push = vi.fn();
const replace = vi.fn();
const back = vi.fn();
const forward = vi.fn();
const prefetch = vi.fn();
const refresh = vi.fn();

vi.mock("@bprogress/next/app", () => ({
  // Mirror BProgress's useRouter(options) — returns the extended router.
  useRouter: () => ({ push, replace, back, forward, prefetch, refresh }),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useRouter (progress-router wrapper)", () => {
  it("refresh() delegates to the underlying refresh with showProgress:false (no bar on same-URL)", () => {
    const { result } = renderHook(() => useRouter());
    result.current.refresh();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith({ showProgress: false });
  });

  it("push/replace/back/forward/prefetch pass through unchanged (still drive the bar)", () => {
    const { result } = renderHook(() => useRouter());

    result.current.push("/a");
    result.current.replace("/b");
    result.current.back();
    result.current.forward();
    result.current.prefetch("/c");

    // Same references as the underlying router — not re-wrapped, not suppressed.
    expect(result.current.push).toBe(push);
    expect(result.current.replace).toBe(replace);
    expect(result.current.back).toBe(back);
    expect(result.current.forward).toBe(forward);
    expect(result.current.prefetch).toBe(prefetch);

    expect(push).toHaveBeenCalledWith("/a");
    expect(replace).toHaveBeenCalledWith("/b");
    expect(back).toHaveBeenCalledTimes(1);
    expect(forward).toHaveBeenCalledTimes(1);
    expect(prefetch).toHaveBeenCalledWith("/c");

    // The pass-through methods must NOT receive the showProgress:false flag that
    // is specific to the refresh suppression.
    expect(back).not.toHaveBeenCalledWith({ showProgress: false });
    expect(forward).not.toHaveBeenCalledWith({ showProgress: false });
  });
});
