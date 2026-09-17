/**
 * Concurrent draft updates on one proposal must not lose each other (#555).
 *
 * `documentDrafts` / `taskDrafts` are whole JSON columns. Each mutator reads
 * the list, changes one element and writes the whole list back; two in-flight
 * calls that read the same snapshot let the last write win. The mutators now
 * run inside a transaction that locks the proposal row first, so the second
 * caller reads the first caller's result.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockPrisma, state, calls, mockEventBus } = vi.hoisted(() => {
  const state: { proposal: Record<string, unknown> | null } = { proposal: null };
  const calls: string[] = [];
  // A transaction runner that serializes like a row lock would: the next
  // callback starts only after the previous transaction finished.
  let chain: Promise<unknown> = Promise.resolve();
  const mockPrisma = {
    proposal: {
      findFirst: vi.fn(async () => {
        calls.push("findFirst");
        return state.proposal ? structuredClone(state.proposal) : null;
      }),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        calls.push("update");
        state.proposal = { ...state.proposal, ...data };
        return { ...state.proposal, project: { uuid: "project-1", name: "Project" } };
      }),
    },
    $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push(`lock:${strings.join("?")}:${values.join(",")}`);
      return [];
    }),
    $transaction: vi.fn((fn: (tx: unknown) => Promise<unknown>) => {
      const run = chain.then(() => {
        calls.push("tx:begin");
        return fn(mockPrisma).finally(() => calls.push("tx:end"));
      });
      chain = run.catch(() => undefined);
      return run;
    }),
  };
  const mockEventBus = { emitChange: vi.fn() };
  return { mockPrisma, state, calls, mockEventBus };
});

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/event-bus", () => ({ eventBus: mockEventBus }));
vi.mock("@/generated/prisma/client", () => ({
  Prisma: { JsonNull: Symbol("JsonNull") },
}));
vi.mock("@/lib/uuid-resolver", () => ({
  formatCreatedBy: vi.fn().mockResolvedValue(null),
  formatReview: vi.fn().mockResolvedValue(null),
  resolveAssigneeAgentUuid: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/services/document.service", () => ({ createDocumentFromProposal: vi.fn() }));
vi.mock("@/services/task.service", () => ({ createTasksFromProposal: vi.fn() }));

import {
  addTaskDraft,
  removeDocumentDraft,
  updateDocumentDraft,
  updateTaskDraft,
} from "@/services/proposal.service";

const baseProposal = () => ({
  uuid: "proposal-1",
  companyUuid: "company-1",
  projectUuid: "project-1",
  status: "draft",
  title: "Draft",
  documentDrafts: [
    { uuid: "doc-a", type: "spec", title: "A", content: "a" },
    { uuid: "doc-b", type: "spec", title: "B", content: "b" },
  ],
  taskDrafts: [
    { uuid: "task-a", title: "Task A", description: "", storyPoints: 1, priority: "medium", acceptanceCriteriaItems: [{ description: "done" }] },
    { uuid: "task-b", title: "Task B", description: "", storyPoints: 1, priority: "medium", acceptanceCriteriaItems: [{ description: "done" }] },
  ],
  createdAt: new Date(),
  updatedAt: new Date(),
});

describe("proposal draft mutators under concurrency (#555)", () => {
  beforeEach(() => {
    state.proposal = baseProposal();
    calls.length = 0;
    vi.clearAllMocks();
  });

  it("locks the proposal row before reading the drafts", async () => {
    await updateDocumentDraft("proposal-1", "company-1", "doc-a", { title: "A2" });

    const lock = calls.find((c) => c.startsWith("lock:"));
    expect(lock).toBeDefined();
    expect(lock).toContain("FOR UPDATE");
    expect(lock).toContain("proposal-1");
    expect(calls.indexOf("tx:begin")).toBeLessThan(calls.indexOf(lock!));
    expect(calls.indexOf(lock!)).toBeLessThan(calls.indexOf("findFirst"));
    expect(calls.indexOf("update")).toBeLessThan(calls.indexOf("tx:end"));
  });

  it("keeps both of two concurrent sibling document-draft updates", async () => {
    await Promise.all([
      updateDocumentDraft("proposal-1", "company-1", "doc-a", { title: "A updated" }),
      updateDocumentDraft("proposal-1", "company-1", "doc-b", { title: "B updated" }),
    ]);

    const drafts = state.proposal!.documentDrafts as Array<{ uuid: string; title: string }>;
    expect(drafts.map((d) => d.title)).toEqual(["A updated", "B updated"]);
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(2);
  });

  it("keeps a concurrent add and update on the same task-draft list", async () => {
    await Promise.all([
      updateTaskDraft("proposal-1", "company-1", "task-a", { title: "Task A updated" }),
      addTaskDraft("proposal-1", "company-1", {
        title: "Task C",
        acceptanceCriteriaItems: [{ description: "done" }],
      }),
    ]);

    const tasks = state.proposal!.taskDrafts as Array<{ uuid: string; title: string }>;
    expect(tasks.map((t) => t.title)).toEqual(["Task A updated", "Task B", "Task C"]);
  });

  it("keeps a concurrent update and removal on the same document-draft list", async () => {
    await Promise.all([
      updateDocumentDraft("proposal-1", "company-1", "doc-a", { title: "A updated" }),
      removeDocumentDraft("proposal-1", "company-1", "doc-b"),
    ]);

    const drafts = state.proposal!.documentDrafts as Array<{ uuid: string; title: string }>;
    expect(drafts).toEqual([
      expect.objectContaining({ uuid: "doc-a", title: "A updated" }),
    ]);
  });

  it("still reports a proposal that is not in draft status", async () => {
    state.proposal = null;
    await expect(
      updateTaskDraft("proposal-1", "company-1", "task-a", { title: "x" }),
    ).rejects.toThrow("Proposal not found or not in draft status");
    expect(mockPrisma.proposal.update).not.toHaveBeenCalled();
  });
});
