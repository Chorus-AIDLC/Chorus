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
  it("renders one white block per top-level tree (gaps reveal the page bg)", () => {
    const { container, getAllByTestId } = render(<IdeaLineageTree ideas={TWO_TREES} />);

    // Two top-level trees → exactly two white-block groups.
    const groups = container.querySelectorAll('[data-testid="lineage-tree-group"]');
    expect(groups.length).toBe(2);
    // Each group is a white rounded block; the outer wrapper uses space-y so the
    // page background shows through the gaps (no single white container).
    groups.forEach((g) => {
      expect(g.className).toContain("bg-white");
      expect(g.className).toContain("rounded-lg");
    });
    expect((groups[0].parentElement as HTMLElement).className).toContain("space-y-2.5");

    // Tree-1's block holds both r1 and its child c1; tree-2's block holds r2 only.
    expect(groups[0].querySelectorAll('[data-testid="idea-card"]').length).toBe(2);
    expect(groups[1].querySelectorAll('[data-testid="idea-card"]').length).toBe(1);

    // DFS order is preserved across blocks: r1, c1, r2.
    const cards = getAllByTestId("idea-card");
    expect(cards.map((c) => c.getAttribute("data-uuid"))).toEqual(["r1", "c1", "r2"]);

    // The child row is at depth 1 (indented under its parent), the roots at 0.
    const byUuid = Object.fromEntries(cards.map((c) => [c.getAttribute("data-uuid"), c]));
    expect(byUuid["r1"].getAttribute("data-depth")).toBe("0");
    expect(byUuid["c1"].getAttribute("data-depth")).toBe("1");
    expect(byUuid["r2"].getAttribute("data-depth")).toBe("0");
  });

  it("keeps a single tree in one block with tight hairlines between its rows", () => {
    // One tree: root + two children — a single white block, no extra blocks.
    const oneTree: IdeaCardItem[] = [
      idea({ uuid: "root", childCount: 2 }),
      idea({ uuid: "a", parentUuid: "root" }),
      idea({ uuid: "b", parentUuid: "root" }),
    ];
    const { container } = render(<IdeaLineageTree ideas={oneTree} />);
    expect(container.querySelectorAll('[data-testid="lineage-tree-group"]').length).toBe(1);
    // In-tree separators (hairlines) are present between the 3 rows.
    expect(container.querySelectorAll(".bg-\\[\\#F0EEEA\\]").length).toBeGreaterThan(0);
  });

  it("renders a single block with no hairline for a lone root", () => {
    const { container } = render(<IdeaLineageTree ideas={[idea({ uuid: "solo" })]} />);
    expect(container.querySelectorAll('[data-testid="lineage-tree-group"]').length).toBe(1);
    expect(container.querySelectorAll(".bg-\\[\\#F0EEEA\\]").length).toBe(0);
  });

  it("renders one block per unrelated top-level root", () => {
    const threeRoots: IdeaCardItem[] = [
      idea({ uuid: "x" }),
      idea({ uuid: "y" }),
      idea({ uuid: "z" }),
    ];
    const { container } = render(<IdeaLineageTree ideas={threeRoots} />);
    // 3 unrelated roots → 3 separate white blocks.
    expect(container.querySelectorAll('[data-testid="lineage-tree-group"]').length).toBe(3);
    // No in-tree hairlines (each block has a single row).
    expect(container.querySelectorAll(".bg-\\[\\#F0EEEA\\]").length).toBe(0);
  });
});
