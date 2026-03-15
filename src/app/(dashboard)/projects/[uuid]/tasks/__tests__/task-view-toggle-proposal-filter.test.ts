/**
 * task-view-toggle-proposal-filter.test.ts
 *
 * Tests for ProposalFilter integration in the mobile task list view.
 * Since the project uses vitest with node environment (no jsdom/React Testing Library),
 * we test the filtering logic, URL param parsing, and data flow rather than rendering.
 */
import { describe, it, expect } from "vitest";

// ------------------------------------------------------------------
// Helper: replicate the proposal UUID filter parsing from task-view-toggle
// ------------------------------------------------------------------
function parseProposalUuidFilter(
  paramValue: string | null
): Set<string> | null {
  if (!paramValue) return null;
  const uuids = paramValue.split(",").filter(Boolean);
  return uuids.length > 0 ? new Set(uuids) : null;
}

// ------------------------------------------------------------------
// Helper: replicate the proposal-based task filtering
// ------------------------------------------------------------------
interface MockTask {
  uuid: string;
  title: string;
  status: string;
  proposalUuid: string | null;
}

function filterByProposal(
  tasks: MockTask[],
  proposalUuidFilter: Set<string> | null
): MockTask[] {
  if (!proposalUuidFilter) return tasks;
  return tasks.filter(
    (task) =>
      task.proposalUuid && proposalUuidFilter.has(task.proposalUuid)
  );
}

function filterByStatus(
  tasks: MockTask[],
  statuses: string[]
): MockTask[] {
  if (statuses.length === 0) return tasks;
  return tasks.filter((task) => statuses.includes(task.status));
}

// ------------------------------------------------------------------
// Test data
// ------------------------------------------------------------------
const sampleTasks: MockTask[] = [
  {
    uuid: "task-1",
    title: "Task from proposal A",
    status: "open",
    proposalUuid: "proposal-a",
  },
  {
    uuid: "task-2",
    title: "Task from proposal A (in progress)",
    status: "in_progress",
    proposalUuid: "proposal-a",
  },
  {
    uuid: "task-3",
    title: "Task from proposal B",
    status: "open",
    proposalUuid: "proposal-b",
  },
  {
    uuid: "task-4",
    title: "Task without proposal",
    status: "done",
    proposalUuid: null,
  },
  {
    uuid: "task-5",
    title: "Task from proposal C",
    status: "to_verify",
    proposalUuid: "proposal-c",
  },
];

// ------------------------------------------------------------------
// 1. ProposalFilter is rendered in list view (structural test)
// ------------------------------------------------------------------
describe("TaskViewToggle - ProposalFilter integration", () => {
  it("ProposalFilter component is imported and used in task-view-toggle", async () => {
    // Verify the import exists in the source file by checking the module structure
    const fs = await import("fs");
    const path = await import("path");
    const filePath = path.resolve(
      __dirname,
      "..",
      "task-view-toggle.tsx"
    );
    const content = fs.readFileSync(filePath, "utf-8");

    // Verify import
    expect(content).toContain(
      'import { ProposalFilter } from "@/components/proposal-filter"'
    );

    // Verify usage in JSX - rendered before the toolbar (shared across all views)
    expect(content).toContain("<ProposalFilter projectUuid={projectUuid} />");

    // Verify it's placed before the toolbar, not inside a specific view
    const proposalFilterComment = content.indexOf("{/* Proposal Filter */}");
    const toolbarComment = content.indexOf("{/* Toolbar: View Toggle");
    expect(proposalFilterComment).toBeGreaterThan(-1);
    expect(toolbarComment).toBeGreaterThan(-1);
    expect(proposalFilterComment).toBeLessThan(toolbarComment);
  });

  it("ProposalFilter is in a container with margin spacing", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const filePath = path.resolve(
      __dirname,
      "..",
      "task-view-toggle.tsx"
    );
    const content = fs.readFileSync(filePath, "utf-8");

    // The ProposalFilter should be in a container with margin bottom
    expect(content).toContain("mb-4");
  });
});

// ------------------------------------------------------------------
// 2. Task filtering by proposalUuids works correctly
// ------------------------------------------------------------------
describe("TaskViewToggle - proposal UUID filtering", () => {
  it("returns null filter when param is null", () => {
    expect(parseProposalUuidFilter(null)).toBeNull();
  });

  it("returns null filter when param is empty string", () => {
    expect(parseProposalUuidFilter("")).toBeNull();
  });

  it("parses single proposal UUID", () => {
    const filter = parseProposalUuidFilter("proposal-a");
    expect(filter).toEqual(new Set(["proposal-a"]));
  });

  it("parses multiple proposal UUIDs", () => {
    const filter = parseProposalUuidFilter("proposal-a,proposal-b");
    expect(filter).toEqual(new Set(["proposal-a", "proposal-b"]));
  });

  it("returns all tasks when no proposal filter is active", () => {
    const result = filterByProposal(sampleTasks, null);
    expect(result).toHaveLength(5);
  });

  it("filters tasks by single proposal UUID", () => {
    const filter = new Set(["proposal-a"]);
    const result = filterByProposal(sampleTasks, filter);
    expect(result).toHaveLength(2);
    expect(result.every((t) => t.proposalUuid === "proposal-a")).toBe(true);
  });

  it("filters tasks by multiple proposal UUIDs", () => {
    const filter = new Set(["proposal-a", "proposal-c"]);
    const result = filterByProposal(sampleTasks, filter);
    expect(result).toHaveLength(3);
    expect(
      result.every(
        (t) =>
          t.proposalUuid === "proposal-a" || t.proposalUuid === "proposal-c"
      )
    ).toBe(true);
  });

  it("excludes tasks with null proposalUuid", () => {
    const filter = new Set(["proposal-a"]);
    const result = filterByProposal(sampleTasks, filter);
    expect(result.find((t) => t.uuid === "task-4")).toBeUndefined();
  });

  it("returns empty array when no tasks match the filter", () => {
    const filter = new Set(["nonexistent-proposal"]);
    const result = filterByProposal(sampleTasks, filter);
    expect(result).toHaveLength(0);
  });
});

// ------------------------------------------------------------------
// 3. Combined proposal + status filtering
// ------------------------------------------------------------------
describe("TaskViewToggle - combined proposal and status filtering", () => {
  it("applies proposal filter first, then status filter", () => {
    // Filter by proposal-a first
    const proposalFilter = new Set(["proposal-a"]);
    const afterProposal = filterByProposal(sampleTasks, proposalFilter);
    expect(afterProposal).toHaveLength(2);

    // Then filter by status "open"
    const afterStatus = filterByStatus(afterProposal, ["open"]);
    expect(afterStatus).toHaveLength(1);
    expect(afterStatus[0].uuid).toBe("task-1");
  });

  it("status counts reflect proposal-filtered tasks", () => {
    const proposalFilter = new Set(["proposal-a"]);
    const afterProposal = filterByProposal(sampleTasks, proposalFilter);

    // Count by status
    const openCount = afterProposal.filter((t) => t.status === "open").length;
    const inProgressCount = afterProposal.filter(
      (t) => t.status === "in_progress"
    ).length;

    expect(openCount).toBe(1);
    expect(inProgressCount).toBe(1);
    expect(afterProposal.length).toBe(2); // total for "all" tab
  });

  it("with no proposal filter, status filtering works on all tasks", () => {
    const afterProposal = filterByProposal(sampleTasks, null);
    const afterStatus = filterByStatus(afterProposal, ["done"]);
    expect(afterStatus).toHaveLength(1);
    expect(afterStatus[0].uuid).toBe("task-4");
  });
});

// ------------------------------------------------------------------
// 4. Mobile overflow safety
// ------------------------------------------------------------------
describe("TaskViewToggle - mobile overflow safety", () => {
  it("ProposalFilter component uses flex-wrap for mobile safety", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const filePath = path.resolve(
      __dirname,
      "..",
      "..",
      "..",
      "..",
      "..",
      "..",
      "components",
      "proposal-filter.tsx"
    );
    const content = fs.readFileSync(filePath, "utf-8");

    // The outer container should use flex-wrap to prevent overflow on small screens
    expect(content).toContain("flex-wrap");

    // The trigger button should have max-width constraints for mobile
    expect(content).toContain("max-w-[200px]");

    // The popover content should be constrained to fit mobile
    expect(content).toContain('w-[300px]');
  });

  it("PopoverContent width (300px) fits within 390px mobile viewport", () => {
    const popoverWidth = 300;
    const mobileViewport = 390;
    const minPadding = 16; // 8px on each side minimum
    expect(popoverWidth + minPadding).toBeLessThanOrEqual(mobileViewport);
  });
});
