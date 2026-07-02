// @vitest-environment jsdom
//
// Component coverage for NodeTooltip (resource-graph hover tooltip, Tech Design
// D3 — title-only contract).
//
// The tooltip no longer renders a status badge or a loading spinner: status now
// lives on the card itself as a pill (painted by mindmap-canvas.tsx), so the
// tooltip is reduced to the one thing the truncated card title can't show —
// the FULL untruncated title.
//
// What this suite verifies:
//   - the FULL title renders verbatim;
//   - the anchor (left/top inline style) comes from the props;
//   - role="tooltip" is set;
//   - pointer-events-none is on the root (so the tooltip never intercepts a
//     canvas click);
//   - NO status / type Badge and NO loading indicator are rendered (the
//     previous revision did both — they must be gone).
//
// next-intl is NOT used by the title-only tooltip, so no translator mock is
// needed.

import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";

import { NodeTooltip } from "../node-tooltip";

describe("NodeTooltip (title-only, Tech Design D3)", () => {
  it("renders the full untruncated title anchored at the given screen position", () => {
    const longTitle =
      "A deliberately very long idea title that the node card would have truncated to fit its 200px width";
    const { getByTestId, getByText } = render(
      <NodeTooltip title={longTitle} x={120} y={80} />,
    );

    // FULL title (not truncated).
    expect(getByText(longTitle)).toBeTruthy();

    const root = getByTestId("node-tooltip") as HTMLElement;
    // Anchored via inline left/top from the screen-anchor props.
    expect(root.style.left).toBe("120px");
    expect(root.style.top).toBe("80px");
    // pointer-events-none so it never intercepts a canvas click.
    expect(root.className).toContain("pointer-events-none");
    // a11y role for assistive tech.
    expect(root.getAttribute("role")).toBe("tooltip");
  });

  it("renders ONLY the title — no status badge and no loading indicator", () => {
    const { queryByTestId, queryByText, container } = render(
      <NodeTooltip title="Just a title" x={0} y={0} />,
    );

    // No loading indicator (the legacy `node-tooltip-loading` test id).
    expect(queryByTestId("node-tooltip-loading")).toBeNull();
    // No translated status / document-type label leaks in. The previous
    // revision rendered keys like `status.inProgress` or `documents.typePrd`;
    // none of those should appear now.
    expect(queryByText(/^status\./)).toBeNull();
    expect(queryByText(/^documents\.type/)).toBeNull();
    expect(queryByText(/^ideaTracker\.badge\./)).toBeNull();
    // The Badge component uses a "badge"-suffix class on its root; assert no
    // such element is present inside the tooltip.
    expect(container.querySelector('[class*="badge" i]')).toBeNull();
  });
});
