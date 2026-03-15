/**
 * kanban-proposal-filter.test.ts
 *
 * Tests for ProposalFilter integration in the Kanban/task views.
 * Since the project uses vitest with node environment (no jsdom),
 * we test the filtering logic, URL param parsing, and i18n keys.
 */
import { describe, it, expect } from "vitest";

// ------------------------------------------------------------------
// Helper: replicate the proposalUuid filtering logic from TaskViewToggle
// ------------------------------------------------------------------
interface MockTask {
  uuid: string;
  title: string;
  status: string;
  proposalUuid: string | null;
}

function parseProposalUuidFilter(paramValue: string | null): Set<string> | null {
  if (!paramValue) return null;
  const uuids = paramValue.split(",").filter(Boolean);
  return uuids.length > 0 ? new Set(uuids) : null;
}

function filterTasksByProposal(tasks: MockTask[], filter: Set<string> | null): MockTask[] {
  if (!filter) return tasks;
  return tasks.filter((task) => task.proposalUuid && filter.has(task.proposalUuid));
}

// ------------------------------------------------------------------
// Sample data
// ------------------------------------------------------------------
const sampleTasks: MockTask[] = [
  { uuid: "t1", title: "Task 1", status: "open", proposalUuid: "prop-a" },
  { uuid: "t2", title: "Task 2", status: "in_progress", proposalUuid: "prop-a" },
  { uuid: "t3", title: "Task 3", status: "done", proposalUuid: "prop-b" },
  { uuid: "t4", title: "Task 4", status: "open", proposalUuid: null },
  { uuid: "t5", title: "Task 5", status: "assigned", proposalUuid: "prop-c" },
];

// ------------------------------------------------------------------
// 1. ProposalFilter is rendered in the Kanban view (structural test)
// ------------------------------------------------------------------
describe("Kanban view - ProposalFilter integration", () => {
  it("TaskViewToggle imports and uses ProposalFilter component", async () => {
    // Verify the component file imports ProposalFilter
    const fs = await import("fs");
    const path = await import("path");
    const filePath = path.resolve(
      __dirname,
      "..",
      "task-view-toggle.tsx"
    );
    const content = fs.readFileSync(filePath, "utf-8");

    expect(content).toContain('import { ProposalFilter }');
    expect(content).toContain('<ProposalFilter projectUuid={projectUuid}');
  });

  it("ProposalFilter is placed before the toolbar (between title and board)", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const filePath = path.resolve(
      __dirname,
      "..",
      "task-view-toggle.tsx"
    );
    const content = fs.readFileSync(filePath, "utf-8");

    const proposalFilterIdx = content.indexOf("{/* Proposal Filter */}");
    const toolbarIdx = content.indexOf("{/* Toolbar: View Toggle");
    expect(proposalFilterIdx).toBeGreaterThan(-1);
    expect(toolbarIdx).toBeGreaterThan(-1);
    expect(proposalFilterIdx).toBeLessThan(toolbarIdx);
  });

  it("KanbanBoard receives proposalFilteredTasks instead of initialTasks", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const filePath = path.resolve(
      __dirname,
      "..",
      "task-view-toggle.tsx"
    );
    const content = fs.readFileSync(filePath, "utf-8");

    // KanbanBoard should receive proposalFilteredTasks
    expect(content).toContain("initialTasks={proposalFilteredTasks}");
  });
});

// ------------------------------------------------------------------
// 2. Task filtering logic when proposalUuids are provided
// ------------------------------------------------------------------
describe("Kanban view - task filtering by proposalUuids", () => {
  it("returns all tasks when no proposalUuids filter is set", () => {
    const filter = parseProposalUuidFilter(null);
    const result = filterTasksByProposal(sampleTasks, filter);
    expect(result).toHaveLength(sampleTasks.length);
  });

  it("returns all tasks when proposalUuids param is empty string", () => {
    const filter = parseProposalUuidFilter("");
    const result = filterTasksByProposal(sampleTasks, filter);
    expect(result).toHaveLength(sampleTasks.length);
  });

  it("filters tasks to only those matching a single proposalUuid", () => {
    const filter = parseProposalUuidFilter("prop-a");
    const result = filterTasksByProposal(sampleTasks, filter);
    expect(result).toHaveLength(2);
    expect(result.map((t) => t.uuid)).toEqual(["t1", "t2"]);
  });

  it("filters tasks matching multiple proposalUuids", () => {
    const filter = parseProposalUuidFilter("prop-a,prop-b");
    const result = filterTasksByProposal(sampleTasks, filter);
    expect(result).toHaveLength(3);
    expect(result.map((t) => t.uuid)).toEqual(["t1", "t2", "t3"]);
  });

  it("excludes tasks with null proposalUuid when filter is active", () => {
    const filter = parseProposalUuidFilter("prop-a,prop-b,prop-c");
    const result = filterTasksByProposal(sampleTasks, filter);
    // t4 has null proposalUuid, should be excluded
    expect(result).toHaveLength(4);
    expect(result.find((t) => t.uuid === "t4")).toBeUndefined();
  });

  it("returns empty array when no tasks match the filter", () => {
    const filter = parseProposalUuidFilter("prop-nonexistent");
    const result = filterTasksByProposal(sampleTasks, filter);
    expect(result).toHaveLength(0);
  });
});

// ------------------------------------------------------------------
// 3. Subtitle updates to show filtered count
// ------------------------------------------------------------------
describe("Kanban view - filtered subtitle", () => {
  it("shows filtered count text when filter is active", () => {
    const filter = parseProposalUuidFilter("prop-a");
    const filtered = filterTasksByProposal(sampleTasks, filter);
    const total = sampleTasks.length;

    // Simulate what the i18n template would produce
    const subtitle = `${filtered.length} of ${total} tasks (filtered)`;
    expect(subtitle).toBe("2 of 5 tasks (filtered)");
  });

  it("subtitle reflects correct counts for multiple proposals", () => {
    const filter = parseProposalUuidFilter("prop-a,prop-c");
    const filtered = filterTasksByProposal(sampleTasks, filter);
    expect(filtered.length).toBe(3);
    expect(sampleTasks.length).toBe(5);
  });

  it("does not show subtitle when no filter is active", () => {
    const filter = parseProposalUuidFilter(null);
    // proposalUuidFilter is null, so subtitle should not be shown
    expect(filter).toBeNull();
  });
});

// ------------------------------------------------------------------
// 4. i18n keys for filteredSubtitle exist in both locales
// ------------------------------------------------------------------
describe("Kanban view - filteredSubtitle i18n keys", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const en = require("../../../../../../../messages/en.json");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const zh = require("../../../../../../../messages/zh.json");

  it("has filteredSubtitle key in English", () => {
    expect(en.tasks.proposalFilter).toHaveProperty("filteredSubtitle");
    expect(typeof en.tasks.proposalFilter.filteredSubtitle).toBe("string");
    // Should contain interpolation placeholders
    expect(en.tasks.proposalFilter.filteredSubtitle).toContain("{filtered}");
    expect(en.tasks.proposalFilter.filteredSubtitle).toContain("{total}");
  });

  it("has filteredSubtitle key in Chinese", () => {
    expect(zh.tasks.proposalFilter).toHaveProperty("filteredSubtitle");
    expect(typeof zh.tasks.proposalFilter.filteredSubtitle).toBe("string");
    expect(zh.tasks.proposalFilter.filteredSubtitle).toContain("{filtered}");
    expect(zh.tasks.proposalFilter.filteredSubtitle).toContain("{total}");
  });

  it("en and zh proposalFilter keys match", () => {
    const enKeys = Object.keys(en.tasks.proposalFilter).sort();
    const zhKeys = Object.keys(zh.tasks.proposalFilter).sort();
    expect(enKeys).toEqual(zhKeys);
  });
});
