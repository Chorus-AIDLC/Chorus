// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import en from "../../../../../../../../messages/en.json";

vi.mock("../actions", () => ({
  getElaborationAction: vi.fn().mockResolvedValue({ success: false, error: "n/a" }),
}));

import { OverviewTimeline } from "../overview-timeline";
import type { ProposalData } from "../proposal-view";

afterEach(cleanup);

const baseIdea = {
  uuid: "idea-1",
  title: "Idea",
  content: null,
  status: "elaborated",
  elaborationStatus: "resolved",
  createdBy: null,
  createdAt: "2026-11-01T00:00:00Z",
  derivedStatus: "in_progress",
  badgeHint: "building",
};
const linkedTask = { uuid: "q1", title: "Quick fix", status: "in_progress", commentCount: 0 };

function activeLabel() {
  const t = en.ideaTracker.panel.timeline;
  for (const label of [t.ideaCreated, t.elaboration, t.proposal, t.tasksProgress]) {
    const span = screen.getByText(label, { selector: "span" });
    if (span.className.includes("text-primary")) return label;
  }
  return null;
}

function renderTimeline(props: {
  idea?: Partial<typeof baseIdea>;
  proposals?: ProposalData[];
  tasks?: (typeof linkedTask)[];
  hasLinkedTasks?: boolean;
}) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <OverviewTimeline
        idea={{ ...baseIdea, ...props.idea }}
        proposals={props.proposals ?? []}
        tasks={props.tasks ?? []}
        hasLinkedTasks={props.hasLinkedTasks}
        onSelectTask={vi.fn()}
      />
    </NextIntlClientProvider>,
  );
}

describe("OverviewTimeline — directly linked Quick Tasks", () => {
  it("an elaborated idea with no proposal but linked tasks is in the execution phase", () => {
    renderTimeline({ tasks: [linkedTask], hasLinkedTasks: true });
    expect(activeLabel()).toBe(en.ideaTracker.panel.timeline.tasksProgress);
    // The active node auto-expands and lists the linked task.
    expect(screen.getByText("Quick fix")).toBeTruthy();
  });

  it("an open idea with linked tasks is also in execution (status-independent)", () => {
    renderTimeline({ idea: { status: "open", elaborationStatus: undefined }, tasks: [linkedTask], hasLinkedTasks: true });
    expect(activeLabel()).toBe(en.ideaTracker.panel.timeline.tasksProgress);
  });

  it("pending elaboration answers take precedence over linked tasks", () => {
    renderTimeline({
      idea: { status: "elaborating", elaborationStatus: "pending_answers" },
      tasks: [linkedTask],
      hasLinkedTasks: true,
    });
    expect(activeLabel()).toBe(en.ideaTracker.panel.timeline.elaboration);
  });

  it("a pending proposal takes precedence over linked tasks", () => {
    renderTimeline({
      proposals: [{ uuid: "p1", status: "pending" } as unknown as ProposalData],
      tasks: [linkedTask],
      hasLinkedTasks: true,
    });
    expect(activeLabel()).toBe(en.ideaTracker.panel.timeline.proposal);
  });

  it("without linked tasks an elaborated idea with no proposal stays in elaboration (unchanged)", () => {
    renderTimeline({});
    expect(activeLabel()).toBe(en.ideaTracker.panel.timeline.elaboration);
  });
});
