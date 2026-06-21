// @vitest-environment jsdom
//
// Structural tests for IdeaLineageTree grouping. Guards the lineage-tab fix:
// distinct top-level trees must be separated by a larger group gap, while rows
// inside a single tree keep the tight 1px hairline. buildForest is DFS-ordered,
// so every depth===0 row after the first starts a new top-level tree.
//
// We assert DOM structure (marker element + ordering), not pixel sizes — jsdom
// has no layout engine; the visual look is covered by the e2e task.

import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import type { IdeaCardItem } from "../idea-card";

// PresenceIndicator needs realtime context; render it as a pass-through.
vi.mock("@/components/ui/presence-indicator", () => ({
  PresenceIndicator: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// IdeaCard → a lightweight marker that surfaces uuid + depth so we can assert
// ordering and the per-row separator without its internals (i18n etc.).
vi.mock("../idea-card", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    IdeaCard: ({ idea, depth }: { idea: IdeaCardItem; depth?: number }) => (
      <div data-testid="idea-card" data-uuid={idea.uuid} data-depth={depth ?? 0}>
        {idea.title}
      </div>
    ),
  };
});

import { IdeaLineageTree } from "../idea-lineage-tree";

function idea(over: Partial<IdeaCardItem> & { uuid: string }): IdeaCardItem {
  return {
    title: `Idea ${over.uuid}`,
    status: "todo",
    derivedStatus: "todo",
    badgeHint: null,
    createdAt: "2026-06-14T00:00:00.000Z",
    parentUuid: null,
    childCount: 0,
    ...over,
  };
}

// Two top-level trees:
//   tree-1 (root "r1") → child "c1"
//   tree-2 (root "r2")  [unrelated]
const TWO_TREES: IdeaCardItem[] = [
  idea({ uuid: "r1", childCount: 1 }),
  idea({ uuid: "c1", parentUuid: "r1" }),
  idea({ uuid: "r2" }),
];

describe("IdeaLineageTree grouping", () => {
  it("inserts a group gap only at the second top-level tree boundary", () => {
    const { container, getAllByTestId } = render(<IdeaLineageTree ideas={TWO_TREES} />);

    // Exactly one group gap — between tree-1's subtree and tree-2's root,
    // NOT between r1 and its child c1.
    const gaps = container.querySelectorAll('[data-testid="lineage-tree-gap"]');
    expect(gaps.length).toBe(1);

    // DFS order is preserved: r1, c1, r2.
    const cards = getAllByTestId("idea-card");
    expect(cards.map((c) => c.getAttribute("data-uuid"))).toEqual(["r1", "c1", "r2"]);

    // The child row is at depth 1 (indented under its parent), the roots at 0.
    const byUuid = Object.fromEntries(cards.map((c) => [c.getAttribute("data-uuid"), c]));
    expect(byUuid["r1"].getAttribute("data-depth")).toBe("0");
    expect(byUuid["c1"].getAttribute("data-depth")).toBe("1");
    expect(byUuid["r2"].getAttribute("data-depth")).toBe("0");
  });

  it("uses the tight hairline (no gap) inside a single tree", () => {
    // One tree: root + two children — no top-level boundary after the first row,
    // so there must be zero group gaps.
    const oneTree: IdeaCardItem[] = [
      idea({ uuid: "root", childCount: 2 }),
      idea({ uuid: "a", parentUuid: "root" }),
      idea({ uuid: "b", parentUuid: "root" }),
    ];
    const { container } = render(<IdeaLineageTree ideas={oneTree} />);
    expect(container.querySelectorAll('[data-testid="lineage-tree-gap"]').length).toBe(0);
    // In-tree separators (hairlines) are present between the 3 rows.
    expect(container.querySelectorAll(".bg-\\[\\#F0EEEA\\]").length).toBeGreaterThan(0);
  });

  it("adds no separators or gaps for a single root", () => {
    const { container } = render(<IdeaLineageTree ideas={[idea({ uuid: "solo" })]} />);
    expect(container.querySelectorAll('[data-testid="lineage-tree-gap"]').length).toBe(0);
    expect(container.querySelectorAll(".bg-\\[\\#F0EEEA\\]").length).toBe(0);
  });

  it("inserts a gap between every pair of unrelated top-level roots", () => {
    const threeRoots: IdeaCardItem[] = [
      idea({ uuid: "x" }),
      idea({ uuid: "y" }),
      idea({ uuid: "z" }),
    ];
    const { container } = render(<IdeaLineageTree ideas={threeRoots} />);
    // Roots after the first each get a gap → 2 gaps for 3 roots.
    expect(container.querySelectorAll('[data-testid="lineage-tree-gap"]').length).toBe(2);
  });
});
