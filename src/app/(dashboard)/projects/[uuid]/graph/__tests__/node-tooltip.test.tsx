// @vitest-environment jsdom
//
// Component coverage for NodeTooltip (resource-graph hover tooltip, design
// D1/D4). Verifies that the DOM overlay:
//   - renders the entity's FULL (untruncated) title;
//   - renders the correct single badge per entity type — lifecycle STATUS for
//     idea/proposal/task, document TYPE for a document — reusing the existing
//     status.*/documents.type* i18n keys;
//   - shows a loading indicator (not a badge) while the detail fetch is in
//     flight, with the title still visible;
//   - carries pointer-events-none on its root so it never blocks a canvas click;
//   - renders nothing meaningful (no badge) when there is no resolved detail.
//
// The "no hover" case (hoverId → null) is owned by the canvas, which simply does
// not mount this component; here we cover the data-mapping + loading contract.
//
// next-intl is mocked with an echo translator so a label asserts as its key
// (e.g. t("status.inProgress") → "status.inProgress"), exactly like the outline
// suite — keeping the test independent of the actual translations.

import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

import { NodeTooltip } from "../node-tooltip";

describe("NodeTooltip", () => {
  it("renders the full untruncated title and an idea status badge", () => {
    const longTitle =
      "A deliberately very long idea title that the node card would have truncated to fit its 200px width";
    const { getByTestId, getByText, queryByTestId } = render(
      <NodeTooltip
        title={longTitle}
        type="idea"
        detail={{ uuid: "idea-1", status: "elaborating" }}
        loading={false}
        x={120}
        y={80}
      />,
    );

    // FULL title (not truncated).
    expect(getByText(longTitle)).toBeTruthy();
    // Idea lifecycle status → the existing status.* key.
    expect(getByText("status.elaborating")).toBeTruthy();
    // No loading indicator once resolved.
    expect(queryByTestId("node-tooltip-loading")).toBeNull();

    // Anchored via inline left/top from the screen-anchor props.
    const root = getByTestId("node-tooltip");
    expect((root as HTMLElement).style.left).toBe("120px");
    expect((root as HTMLElement).style.top).toBe("80px");
    // pointer-events-none so it never intercepts a canvas click.
    expect(root.className).toContain("pointer-events-none");
  });

  it("renders a task lifecycle status badge (snake_case enum → camelCase key)", () => {
    const { getByText } = render(
      <NodeTooltip
        title="Task A"
        type="task"
        detail={{ uuid: "task-1", status: "in_progress" }}
        loading={false}
        x={0}
        y={0}
      />,
    );
    // task in_progress maps to the existing status.inProgress key.
    expect(getByText("status.inProgress")).toBeTruthy();
  });

  it("renders a proposal status badge including the pending → pendingReview key", () => {
    const { getByText } = render(
      <NodeTooltip
        title="Proposal one"
        type="proposal"
        detail={{ uuid: "prop-1", status: "pending" }}
        loading={false}
        x={0}
        y={0}
      />,
    );
    expect(getByText("status.pendingReview")).toBeTruthy();
  });

  it("renders a document TYPE badge (not a status) for a document node", () => {
    const { getByText } = render(
      <NodeTooltip
        title="Tech Design doc"
        type="document"
        detail={{ uuid: "doc-1", docType: "tech_design" }}
        loading={false}
        x={0}
        y={0}
      />,
    );
    // document → its type, via the existing documents.type* key.
    expect(getByText("documents.typeTechDesign")).toBeTruthy();
  });

  it("shows the title + a loading indicator (no badge) while detail is loading", () => {
    const { getByText, getByTestId, queryByText } = render(
      <NodeTooltip
        title="Loading idea"
        type="idea"
        detail={null}
        loading={true}
        x={0}
        y={0}
      />,
    );
    // Title (already known from the node payload) stays visible.
    expect(getByText("Loading idea")).toBeTruthy();
    // Loading indicator shown in place of the badge.
    expect(getByTestId("node-tooltip-loading")).toBeTruthy();
    expect(getByText("graph.tooltip.loading")).toBeTruthy();
    // No status/type badge yet.
    expect(queryByText(/^status\./)).toBeNull();
  });

  it("renders no badge and no loading indicator when detail is unresolved and not loading", () => {
    const { getByText, queryByText, queryByTestId } = render(
      <NodeTooltip
        title="No detail yet"
        type="task"
        detail={null}
        loading={false}
        x={0}
        y={0}
      />,
    );
    // Title still rendered; but no badge could be derived from a null detail,
    // and we are no longer loading — so neither a badge nor the loading label
    // shows (the slot stays empty rather than implying perpetual loading).
    expect(getByText("No detail yet")).toBeTruthy();
    expect(queryByText(/^status\./)).toBeNull();
    expect(queryByTestId("node-tooltip-loading")).toBeNull();
    expect(queryByText("graph.tooltip.loading")).toBeNull();
  });
});
