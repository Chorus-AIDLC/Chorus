// @vitest-environment jsdom
//
// Regression guard for the "URL changes but the panel doesn't switch" bug.
//
// Root cause (pre-fix): usePanelUrl kept `selectedId` in local useState seeded
// once from `initialSelectedId`, and only re-synced on `popstate`. App Router
// soft navigation (router.push / <Link>) changes the URL WITHOUT firing
// popstate, so external `?panel=<id>` links updated the address bar but never
// the panel. The fix makes `useSearchParams()` the source of truth so any URL
// change — soft nav, back/forward, or direct load — drives the selection.

import { describe, expect, it, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { usePanelUrl } from "../use-panel-url";

// Controllable stand-in for the live URL query string that useSearchParams()
// reflects. Each test sets it, then rerender() re-reads it — mirroring how Next
// re-renders consumers of useSearchParams() on navigation.
let mockParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useSearchParams: () => mockParams,
}));

function setUrl(search: string) {
  mockParams = new URLSearchParams(search);
  // Keep window.location.search aligned so the openPanel/closePanel writers,
  // which read window.location.search to preserve unrelated params, see the
  // same state the reader derives from.
  window.history.replaceState(null, "", search ? `/base?${search}` : "/base");
}

beforeEach(() => {
  setUrl("");
});

describe("usePanelUrl", () => {
  it("derives selectedId from the panel search param", () => {
    setUrl("panel=idea-1");
    const { result } = renderHook(() => usePanelUrl("/base"));
    expect(result.current.selectedId).toBe("idea-1");
  });

  it("derives selectedTab from the tab search param", () => {
    setUrl("panel=idea-1&tab=overview");
    const { result } = renderHook(() => usePanelUrl("/base"));
    expect(result.current.selectedTab).toBe("overview");
  });

  it("returns null selectedId when no panel param is present", () => {
    setUrl("");
    const { result } = renderHook(() => usePanelUrl("/base"));
    expect(result.current.selectedId).toBeNull();
  });

  // THE regression: a soft-nav URL change (new searchParams) must update the
  // selection on rerender. The pre-fix hook ignored useSearchParams entirely,
  // so selectedId stayed at its initial value here.
  it("updates selectedId when the search params change (soft navigation)", () => {
    setUrl("panel=idea-1");
    const { result, rerender } = renderHook(() => usePanelUrl("/base"));
    expect(result.current.selectedId).toBe("idea-1");

    setUrl("panel=idea-2");
    rerender();
    expect(result.current.selectedId).toBe("idea-2");
  });

  it("clears the selection when the panel param is removed (soft navigation)", () => {
    setUrl("panel=idea-1");
    const { result, rerender } = renderHook(() => usePanelUrl("/base"));
    expect(result.current.selectedId).toBe("idea-1");

    setUrl("");
    rerender();
    expect(result.current.selectedId).toBeNull();
  });

  it("openPanel writes ?panel= to the URL, preserving unrelated params", () => {
    setUrl("filter=open");
    const { result } = renderHook(() => usePanelUrl("/base"));
    act(() => {
      result.current.openPanel("idea-9");
    });
    const params = new URLSearchParams(window.location.search);
    expect(params.get("panel")).toBe("idea-9");
    expect(params.get("filter")).toBe("open");
  });

  it("openPanel with a tab writes both ?panel= and ?tab=", () => {
    setUrl("");
    const { result } = renderHook(() => usePanelUrl("/base"));
    act(() => {
      result.current.openPanel("idea-9", "overview");
    });
    const params = new URLSearchParams(window.location.search);
    expect(params.get("panel")).toBe("idea-9");
    expect(params.get("tab")).toBe("overview");
  });

  it("closePanel removes panel and tab while preserving unrelated params", () => {
    setUrl("panel=idea-1&tab=overview&filter=open");
    const { result } = renderHook(() => usePanelUrl("/base"));
    act(() => {
      result.current.closePanel();
    });
    const params = new URLSearchParams(window.location.search);
    expect(params.get("panel")).toBeNull();
    expect(params.get("tab")).toBeNull();
    expect(params.get("filter")).toBe("open");
  });

  // Regression: a deep-linked panel (server seeds initialSelectedId from
  // ?panel=) MUST close. If the initialSelectedId fallback leaks past the first
  // paint, removing the panel param resolves back to the seed and the panel
  // re-sticks open — the close button would never work.
  it("does not re-stick a deep-linked panel open after the param is removed", () => {
    setUrl("panel=idea-X");
    const { result, rerender } = renderHook(() => usePanelUrl("/base", "idea-X"));
    expect(result.current.selectedId).toBe("idea-X");

    // User closes the panel → ?panel= removed from the URL.
    setUrl("");
    rerender();
    expect(result.current.selectedId).toBeNull();
  });

  it("clears a deep-linked selection when soft-navigating to a panel-less URL", () => {
    setUrl("panel=idea-X");
    const { result, rerender } = renderHook(() => usePanelUrl("/base", "idea-X"));
    expect(result.current.selectedId).toBe("idea-X");

    // Soft navigation to a URL with other params but no panel.
    setUrl("filter=open");
    rerender();
    expect(result.current.selectedId).toBeNull();
  });
});
