// @vitest-environment jsdom
//
// UI tests for ReportsList — covers the user-visible contract from the
// idea-completion-report spec: hidden when zero reports, renders rows in
// createdAt-desc order with a Report badge when reports exist, click-row
// calls onDocClick with the {title, type:"report", content} shape that
// IdeaDetailPanel wires to the existing DocumentPanel.

import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { getReportsForIdeaActionMock } = vi.hoisted(() => ({
  getReportsForIdeaActionMock: vi.fn(),
}));

vi.mock("../actions", () => ({
  getReportsForIdeaAction: (...args: unknown[]) =>
    getReportsForIdeaActionMock(...args),
}));

// Realtime context fires fetches via useRealtimeEntityTypeEvent. The hook
// itself just registers a subscriber — we no-op it for these tests so the
// initial fetch is the only one we observe.
vi.mock("@/contexts/realtime-context", () => ({
  useRealtimeEntityTypeEvent: () => undefined,
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

import { ReportsList } from "../reports-list";
import type { ProposalData } from "../proposal-view";

const PROJECT_UUID = "00000000-0000-4000-8000-00000000aaaa";
const IDEA_UUID = "00000000-0000-4000-8000-000000000111";

const APPROVED_PROPOSAL: ProposalData = {
  uuid: "00000000-0000-4000-8000-00000000bbbb",
  title: "Approved Proposal",
  description: null,
  status: "approved",
  documentDrafts: null,
  taskDrafts: null,
  createdAt: "2026-05-01T00:00:00Z",
};

const PENDING_PROPOSAL: ProposalData = {
  uuid: "00000000-0000-4000-8000-00000000cccc",
  title: "Pending Proposal",
  description: null,
  status: "pending",
  documentDrafts: null,
  taskDrafts: null,
  createdAt: "2026-05-01T00:00:00Z",
};

function makeReport(opts: {
  uuid: string;
  title: string;
  createdAt: string;
  content?: string;
  proposalUuid?: string;
}) {
  return {
    uuid: opts.uuid,
    type: "report",
    title: opts.title,
    content: opts.content ?? "# body",
    version: 1,
    proposalUuid: opts.proposalUuid ?? APPROVED_PROPOSAL.uuid,
    createdBy: null,
    createdAt: opts.createdAt,
    updatedAt: opts.createdAt,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ReportsList", () => {
  it("renders nothing when no proposals are approved (skips the fetch entirely)", async () => {
    const onDocClick = vi.fn();
    const { container } = render(
      <ReportsList
        projectUuid={PROJECT_UUID}
        ideaUuid={IDEA_UUID}
        proposals={[PENDING_PROPOSAL]}
        onDocClick={onDocClick}
      />,
    );
    // Wait a tick to be sure nothing rendered after effects ran.
    await waitFor(() => {
      expect(getReportsForIdeaActionMock).not.toHaveBeenCalled();
    });
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when approved proposals exist but the action returns zero reports", async () => {
    getReportsForIdeaActionMock.mockResolvedValue({ success: true, data: [] });
    const onDocClick = vi.fn();
    const { container } = render(
      <ReportsList
        projectUuid={PROJECT_UUID}
        ideaUuid={IDEA_UUID}
        proposals={[APPROVED_PROPOSAL]}
        onDocClick={onDocClick}
      />,
    );
    await waitFor(() => {
      expect(getReportsForIdeaActionMock).toHaveBeenCalledWith(
        PROJECT_UUID,
        IDEA_UUID,
      );
    });
    // No header, no empty-state copy. The container ends up with no children
    // once the loading state clears.
    await waitFor(() => {
      expect(container.firstChild).toBeNull();
    });
  });

  it("renders rows in createdAt-desc order with the localized Report badge", async () => {
    getReportsForIdeaActionMock.mockResolvedValue({
      success: true,
      data: [
        // Server returns out-of-order — the component must resort.
        makeReport({
          uuid: "r-old",
          title: "Older Report",
          createdAt: "2026-05-10T00:00:00Z",
        }),
        makeReport({
          uuid: "r-new",
          title: "Newer Report",
          createdAt: "2026-05-20T00:00:00Z",
        }),
      ],
    });

    render(
      <ReportsList
        projectUuid={PROJECT_UUID}
        ideaUuid={IDEA_UUID}
        proposals={[APPROVED_PROPOSAL]}
        onDocClick={vi.fn()}
      />,
    );

    // Section header + count
    await waitFor(() => {
      expect(screen.getByText("REPORTS")).toBeTruthy();
    });
    expect(screen.getByText("2")).toBeTruthy();
    // Subtitle mentions all approved proposals
    expect(screen.getByText(/across all approved proposals/)).toBeTruthy();

    // At least one Report badge is localized
    const badges = screen.getAllByText("Report");
    expect(badges.length).toBe(2);

    // Order: newest first
    const titles = screen.getAllByRole("button").map((b) => b.textContent || "");
    const newerIdx = titles.findIndex((t) => t.includes("Newer Report"));
    const olderIdx = titles.findIndex((t) => t.includes("Older Report"));
    expect(newerIdx).toBeGreaterThanOrEqual(0);
    expect(olderIdx).toBeGreaterThanOrEqual(0);
    expect(newerIdx).toBeLessThan(olderIdx);
  });

  it("aggregates reports across multiple approved proposals (1 + 2 = 3 rows)", async () => {
    // Spec scenario: an Idea with two approved Proposals (A and B). Proposal A
    // has 1 report; Proposal B has 2. The list must show all 3 rows in one
    // section, count = 3, sorted by createdAt desc regardless of proposal.
    const SECOND_APPROVED_PROPOSAL: ProposalData = {
      uuid: "00000000-0000-4000-8000-00000000dddd",
      title: "Second Approved Proposal",
      description: null,
      status: "approved",
      documentDrafts: null,
      taskDrafts: null,
      createdAt: "2026-05-02T00:00:00Z",
    };

    getReportsForIdeaActionMock.mockResolvedValue({
      success: true,
      data: [
        // Proposal A → 1 report (oldest)
        makeReport({
          uuid: "r-A1",
          title: "Proposal A — completion report",
          createdAt: "2026-05-10T00:00:00Z",
          proposalUuid: APPROVED_PROPOSAL.uuid,
        }),
        // Proposal B → 2 reports (one middle, one newest)
        makeReport({
          uuid: "r-B1",
          title: "Proposal B — first cut",
          createdAt: "2026-05-15T00:00:00Z",
          proposalUuid: SECOND_APPROVED_PROPOSAL.uuid,
        }),
        makeReport({
          uuid: "r-B2",
          title: "Proposal B — final report",
          createdAt: "2026-05-22T00:00:00Z",
          proposalUuid: SECOND_APPROVED_PROPOSAL.uuid,
        }),
      ],
    });

    render(
      <ReportsList
        projectUuid={PROJECT_UUID}
        ideaUuid={IDEA_UUID}
        proposals={[APPROVED_PROPOSAL, SECOND_APPROVED_PROPOSAL]}
        onDocClick={vi.fn()}
      />,
    );

    // Section header renders, count is the sum across proposals (1 + 2 = 3).
    await waitFor(() => {
      expect(screen.getByText("REPORTS")).toBeTruthy();
    });
    expect(screen.getByText("3")).toBeTruthy();
    // Subtitle reads "across all approved proposals" — single section, plural.
    expect(screen.getByText(/across all approved proposals/)).toBeTruthy();

    // All three Report badges render — confirms rows from BOTH proposals are
    // surfaced together (no per-proposal grouping/limit).
    expect(screen.getAllByText("Report").length).toBe(3);

    // Order: newest (r-B2) → middle (r-B1) → oldest (r-A1). Confirms the
    // global createdAt-desc sort survives the cross-proposal aggregation.
    const titles = screen.getAllByRole("button").map((b) => b.textContent || "");
    const idxA1 = titles.findIndex((t) => t.includes("Proposal A — completion report"));
    const idxB1 = titles.findIndex((t) => t.includes("Proposal B — first cut"));
    const idxB2 = titles.findIndex((t) => t.includes("Proposal B — final report"));
    expect(idxA1).toBeGreaterThanOrEqual(0);
    expect(idxB1).toBeGreaterThanOrEqual(0);
    expect(idxB2).toBeGreaterThanOrEqual(0);
    expect(idxB2).toBeLessThan(idxB1);
    expect(idxB1).toBeLessThan(idxA1);

    // Server action is called once with the Idea-level pair — single round-trip
    // for the aggregated list, regardless of how many approved proposals.
    expect(getReportsForIdeaActionMock).toHaveBeenCalledTimes(1);
    expect(getReportsForIdeaActionMock).toHaveBeenCalledWith(
      PROJECT_UUID,
      IDEA_UUID,
    );
  });

  it("clicking a report row calls onDocClick with {title, type:'report', content}", async () => {
    const user = userEvent.setup();
    getReportsForIdeaActionMock.mockResolvedValue({
      success: true,
      data: [
        makeReport({
          uuid: "r-1",
          title: "Idea X — completion report",
          createdAt: "2026-05-20T00:00:00Z",
          content: "# Idea X\n\nDelivered.",
        }),
      ],
    });
    const onDocClick = vi.fn();

    render(
      <ReportsList
        projectUuid={PROJECT_UUID}
        ideaUuid={IDEA_UUID}
        proposals={[APPROVED_PROPOSAL]}
        onDocClick={onDocClick}
      />,
    );

    const row = await screen.findByRole("button", {
      name: /Idea X — completion report/,
    });
    await user.click(row);

    expect(onDocClick).toHaveBeenCalledWith({
      title: "Idea X — completion report",
      type: "report",
      content: "# Idea X\n\nDelivered.",
    });
  });
});
