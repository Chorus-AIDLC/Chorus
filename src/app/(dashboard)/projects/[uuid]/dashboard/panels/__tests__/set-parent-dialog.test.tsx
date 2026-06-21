// @vitest-environment jsdom
//
// Structural tests for the SetParentDialog candidate picker. These guard the
// two regressions fixed in the lineage front-end task:
//
//   1. The candidate list must NOT nest a Radix ScrollArea inside CommandList
//      (CommandList is already the scroll container). A nested ScrollArea with
//      only a max-height never scrolls and the overflow-hidden CommandGroup
//      clips candidates past the cap — making most parents unreachable.
//
//   2. The candidate row must let its title truncate: min-w-0 on the row so the
//      `truncate` title span can shrink, and the cycle badge stays shrink-0.
//
// jsdom has no layout engine, so we assert DOM structure / classes only — the
// "actually scrolls / doesn't overflow" behaviour is covered by the e2e task.

import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const { getProjectIdeasForPickerActionMock, setIdeaParentActionMock } = vi.hoisted(() => ({
  getProjectIdeasForPickerActionMock: vi.fn(),
  setIdeaParentActionMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("../actions", () => ({
  getProjectIdeasForPickerAction: (...args: unknown[]) => getProjectIdeasForPickerActionMock(...args),
  setIdeaParentAction: (...args: unknown[]) => setIdeaParentActionMock(...args),
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
  // Memoize per-namespace so t() keeps a stable reference across renders.
  // Otherwise loadCandidates' useCallback (dep: t) invalidates every render and
  // its useEffect re-fires in a loop, so candidates never settle.
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

// cmdk + Radix need these jsdom shims.
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

import { SetParentDialog } from "../set-parent-dialog";

const IDEA_UUID = "00000000-0000-4000-8000-000000000001";
const CAND_A = "00000000-0000-4000-8000-0000000000aa";
const CAND_B = "00000000-0000-4000-8000-0000000000bb";

const LONG_TITLE =
  "[子3·UI 收尾] 把 daemon UI 重设计成『聊天式』左侧会话列表 / 右侧 transcript，每个 chat = 一条 task-execution 记录，行内打断+发送，agent 放在小下拉里 — 这是一个非常非常长的标题用来触发 truncate";

beforeEach(() => {
  vi.clearAllMocks();
  getProjectIdeasForPickerActionMock.mockResolvedValue({
    success: true,
    data: [
      { uuid: CAND_A, title: LONG_TITLE },
      { uuid: CAND_B, title: "A short sibling idea" },
    ],
    hasMore: false,
  });
  setIdeaParentActionMock.mockResolvedValue({ success: true });
});

function renderDialog(overrides: Partial<React.ComponentProps<typeof SetParentDialog>> = {}) {
  return render(
    <SetParentDialog
      open
      onOpenChange={vi.fn()}
      ideaUuid={IDEA_UUID}
      ideaTitle="Current idea"
      projectUuid="00000000-0000-4000-8000-0000000000ff"
      currentParentUuid={null}
      descendantUuids={[]}
      onChanged={vi.fn()}
      {...overrides}
    />,
  );
}

describe("SetParentDialog candidate picker", () => {
  it("renders candidate rows once the picker action resolves", async () => {
    renderDialog();
    await waitFor(() => {
      expect(screen.getByText(LONG_TITLE)).toBeTruthy();
    });
    expect(screen.getByText("A short sibling idea")).toBeTruthy();
  });

  it("does NOT nest a Radix scroll-area inside the picker (CommandList owns scrolling)", async () => {
    renderDialog();
    await waitFor(() => {
      expect(screen.getByText(LONG_TITLE)).toBeTruthy();
    });
    // Dialog content is portaled to document.body, so query the document.
    // The shared CommandList carries the single scroll container.
    expect(document.body.querySelector('[data-slot="command-list"]')).toBeTruthy();
    // No Radix ScrollArea wrapper must remain around the candidate rows.
    expect(document.body.querySelector('[data-slot="scroll-area"]')).toBeNull();
  });

  it("gives the candidate row min-w-0 and the title a truncate class", async () => {
    renderDialog();
    await waitFor(() => {
      expect(screen.getByText(LONG_TITLE)).toBeTruthy();
    });
    const titleSpan = screen.getByText(LONG_TITLE);
    // The title truncates...
    expect(titleSpan.className).toContain("truncate");
    expect(titleSpan.className).toContain("min-w-0");
    // ...and its row (the cmdk command-item) can shrink below content width.
    const row = titleSpan.closest('[data-slot="command-item"]') as HTMLElement;
    expect(row).toBeTruthy();
    expect(row.className).toContain("min-w-0");
  });

  it("constrains the grid-item wrapper with min-w-0 (prevents dialog overflow)", async () => {
    // DialogContent is display:grid; grid items default to min-width:auto and
    // refuse to shrink below content width. Without min-w-0 on this wrapper the
    // long-title rows stretch it (and the whole dialog) past sm:max-w-lg, which
    // defeats both the row truncate and CommandList's overflow-x-hidden. This is
    // the second missing-min-w-0 link the e2e caught; guard it here too.
    renderDialog();
    await waitFor(() => {
      expect(screen.getByText(LONG_TITLE)).toBeTruthy();
    });
    const list = document.body.querySelector('[data-slot="command-list"]') as HTMLElement;
    // Walk up from the list to DialogContent; the direct grid-item child wrapper
    // (the one holding the Command) must carry min-w-0.
    const dialogContent = document.body.querySelector('[data-slot="dialog-content"]') as HTMLElement;
    let el: HTMLElement | null = list;
    let gridItem: HTMLElement | null = null;
    while (el && el.parentElement && el.parentElement !== dialogContent) {
      el = el.parentElement;
    }
    gridItem = el; // direct child of DialogContent
    expect(gridItem).toBeTruthy();
    expect(gridItem!.className).toContain("min-w-0");
  });

  it("keeps the cycle badge shrink-0 on a blocked (descendant) candidate", async () => {
    // CAND_A is a descendant → blocked → renders the "would cycle" badge.
    renderDialog({ descendantUuids: [CAND_A] });
    await waitFor(() => {
      expect(screen.getByText(LONG_TITLE)).toBeTruthy();
    });
    const badge = screen.getByText("Descendant · would cycle");
    expect(badge.className).toContain("shrink-0");
  });
});
