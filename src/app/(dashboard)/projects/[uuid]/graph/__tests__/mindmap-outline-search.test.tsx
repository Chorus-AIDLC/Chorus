// @vitest-environment jsdom
//
// Mobile outline search visuals (proposal task 4): match highlight / non-match
// dim, the current-match accent (distinct from the `selected` border), and
// scroll-into-view for the current match. Tests MindMapOutline DIRECTLY (like
// the per-row status-Badge suite in resource-graph-outline.test.tsx) so the
// shared search props can be driven precisely.

import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";

// usePresence: empty so no presence outline colors the rows under test.
vi.mock("@/hooks/use-presence", () => ({
  usePresence: () => ({ getPresence: () => [] }),
}));
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

import { MindMapOutline } from "../mindmap-outline";
import type { ForceNode, ForceLink } from "../mindmap-canvas";

// Four flat-root nodes (no edges) → one row each, in input order.
function buildNodes(): ForceNode[] {
  return [
    { id: "idea-1", type: "idea", title: "Alpha idea", status: "building" },
    { id: "task-1", type: "task", title: "Find me one", status: "open" },
    { id: "task-2", type: "task", title: "Find me two", status: "open" },
    { id: "doc-1", type: "document", title: "Unrelated", status: "prd" },
  ];
}
const NO_LINKS: ForceLink[] = [];

// jsdom has no scrollIntoView — record calls per element so the test can assert
// WHICH row was scrolled.
const scrollCalls: { el: Element; arg: unknown }[] = [];
beforeEach(() => {
  scrollCalls.length = 0;
  (Element.prototype as unknown as { scrollIntoView: (a?: unknown) => void }).scrollIntoView =
    function (this: Element, arg?: unknown) {
      scrollCalls.push({ el: this, arg });
    };
});

// Helper: get the <li> row whose text contains `title`.
function rowFor(container: HTMLElement, title: string): HTMLLIElement {
  const rows = Array.from(container.querySelectorAll("li"));
  const row = rows.find((li) => li.textContent?.includes(title));
  if (!row) throw new Error(`row not found: ${title}`);
  return row as HTMLLIElement;
}

describe("MindMapOutline — search highlight / dim", () => {
  it("dims non-matching rows and keeps matches at full opacity (non-empty set)", () => {
    const { container } = render(
      <MindMapOutline
        nodes={buildNodes()}
        links={NO_LINKS}
        selectedId={null}
        onNodeClick={vi.fn()}
        matchIds={new Set(["task-1", "task-2"])}
        currentMatchId={null}
      />,
    );
    // Matches: not dimmed.
    expect(rowFor(container, "Find me one").className).not.toMatch(/opacity-40/);
    expect(rowFor(container, "Find me two").getAttribute("data-dimmed")).toBeNull();
    // Non-matches: dimmed.
    expect(rowFor(container, "Alpha idea").className).toMatch(/opacity-40/);
    expect(rowFor(container, "Unrelated").getAttribute("data-dimmed")).toBe("true");
  });

  it("dims NOTHING when the match set is empty (Q2=a — no whole-tree dim)", () => {
    const { container } = render(
      <MindMapOutline
        nodes={buildNodes()}
        links={NO_LINKS}
        selectedId={null}
        onNodeClick={vi.fn()}
        matchIds={new Set()}
        currentMatchId={null}
      />,
    );
    for (const li of Array.from(container.querySelectorAll("li"))) {
      expect(li.className).not.toMatch(/opacity-40/);
      expect(li.getAttribute("data-dimmed")).toBeNull();
    }
  });

  it("dims NOTHING when not searching (matchIds null / absent)", () => {
    const { container } = render(
      <MindMapOutline
        nodes={buildNodes()}
        links={NO_LINKS}
        selectedId={null}
        onNodeClick={vi.fn()}
      />,
    );
    for (const li of Array.from(container.querySelectorAll("li"))) {
      expect(li.className).not.toMatch(/opacity-40/);
    }
  });

  it("gives the current match a distinct ring accent, separate from the selected border", () => {
    const { container } = render(
      <MindMapOutline
        nodes={buildNodes()}
        links={NO_LINKS}
        // doc-1 is the SELECTED node; task-1 is the CURRENT MATCH — they must be
        // visually distinct treatments on different rows.
        selectedId={"doc-1"}
        onNodeClick={vi.fn()}
        matchIds={new Set(["task-1", "task-2"])}
        currentMatchId={"task-1"}
      />,
    );
    const current = rowFor(container, "Find me one");
    // Current match: pink box-shadow ring on the <li>, and data-match flag.
    expect(current.getAttribute("data-match")).toBe("current");
    expect(current.style.boxShadow).toContain("#EC4899");

    // A plain (non-current) match has no ring.
    const plainMatch = rowFor(container, "Find me two");
    expect(plainMatch.getAttribute("data-match")).toBeNull();
    expect(plainMatch.style.boxShadow).toBe("");

    // The selected row uses the type-color BORDER (border-2) on its inner card,
    // NOT the current-match ring — distinct channel, distinct row.
    const selected = rowFor(container, "Unrelated");
    expect(selected.style.boxShadow).toBe("");
    expect(selected.querySelector(".border-2")).not.toBeNull();
  });
});

describe("MindMapOutline — scroll-into-view for the current match", () => {
  it("scrolls the current match into view (block:center) on mount", () => {
    const { container } = render(
      <MindMapOutline
        nodes={buildNodes()}
        links={NO_LINKS}
        selectedId={null}
        onNodeClick={vi.fn()}
        matchIds={new Set(["task-1", "task-2"])}
        currentMatchId={"task-2"}
      />,
    );
    expect(scrollCalls).toHaveLength(1);
    expect(scrollCalls[0].arg).toEqual({ block: "center" });
    // The scrolled element is the current match's row.
    expect(scrollCalls[0].el).toBe(rowFor(container, "Find me two"));
  });

  it("re-scrolls to the NEW current match when currentMatchId changes (prev/next step)", () => {
    const props = {
      nodes: buildNodes(),
      links: NO_LINKS,
      selectedId: null,
      onNodeClick: vi.fn(),
      matchIds: new Set(["task-1", "task-2"]),
    };
    const { container, rerender } = render(
      <MindMapOutline {...props} currentMatchId={"task-1"} />,
    );
    expect(scrollCalls).toHaveLength(1);
    expect(scrollCalls[0].el).toBe(rowFor(container, "Find me one"));

    // Step next → task-2 becomes current; the effect re-fires for the new id.
    rerender(<MindMapOutline {...props} currentMatchId={"task-2"} />);
    expect(scrollCalls).toHaveLength(2);
    expect(scrollCalls[1].el).toBe(rowFor(container, "Find me two"));
  });

  it("does not scroll when there is no current match (not searching)", () => {
    render(
      <MindMapOutline
        nodes={buildNodes()}
        links={NO_LINKS}
        selectedId={null}
        onNodeClick={vi.fn()}
        currentMatchId={null}
      />,
    );
    expect(scrollCalls).toHaveLength(0);
  });
});
