import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  emptyIdeaTaskContext,
  ideaTaskStatuses,
  loadIdeaTaskContexts,
  loadIdeaTaskData,
  type IdeaTaskDb,
} from "@/services/idea-task-context.service";

const COMPANY = "company-1";
const P1 = "project-1";
const P2 = "project-2";

// A transaction-client-shaped stub: only the two delegates the loader needs.
const db = {
  proposal: { findMany: vi.fn() },
  task: { findMany: vi.fn() },
};
const client = db as unknown as IdeaTaskDb;

const at = (n: number) => new Date(Date.UTC(2026, 0, n));

beforeEach(() => {
  vi.resetAllMocks();
  db.proposal.findMany.mockResolvedValue([]);
  db.task.findMany.mockResolvedValue([]);
});

describe("loadIdeaTaskContexts", () => {
  it("issues no queries for an empty idea set", async () => {
    const contexts = await loadIdeaTaskContexts(client, COMPANY, []);
    expect(contexts.size).toBe(0);
    expect(db.proposal.findMany).not.toHaveBeenCalled();
    expect(db.task.findMany).not.toHaveBeenCalled();
  });

  it("is batched: two queries regardless of idea count, tenant + project scoped", async () => {
    const ideas = Array.from({ length: 25 }, (_, i) => ({ uuid: `i${i}`, projectUuid: i % 2 ? P1 : P2 }));
    db.proposal.findMany.mockResolvedValue([
      { uuid: "pa", projectUuid: P1, status: "approved", inputUuids: ["i1"], createdAt: at(1) },
    ]);

    const contexts = await loadIdeaTaskContexts(client, COMPANY, ideas);

    expect(contexts.size).toBe(25);
    expect(db.proposal.findMany).toHaveBeenCalledTimes(1);
    expect(db.task.findMany).toHaveBeenCalledTimes(1);
    expect(db.proposal.findMany).toHaveBeenCalledWith({
      where: { companyUuid: COMPANY, projectUuid: { in: [P2, P1] }, status: { in: ["approved", "pending"] } },
      select: { uuid: true, projectUuid: true, status: true, inputUuids: true, createdAt: true },
      orderBy: [{ createdAt: "desc" }, { uuid: "asc" }],
    });
    expect(db.task.findMany).toHaveBeenCalledWith({
      where: {
        companyUuid: COMPANY,
        OR: [{ proposalUuid: { in: ["pa"] } }, { ideaUuid: { in: ideas.map((i) => i.uuid) } }],
      },
      select: { uuid: true, proposalUuid: true, ideaUuid: true, status: true },
      orderBy: { uuid: "asc" },
    });
  });

  it("omits the proposal clause when no idea has an approved proposal", async () => {
    await loadIdeaTaskContexts(client, COMPANY, [{ uuid: "i1", projectUuid: P1 }]);
    expect(db.task.findMany.mock.calls[0][0].where.OR).toEqual([{ ideaUuid: { in: ["i1"] } }]);
  });

  it("returns pending/approved flags, latest-approved task statuses, linked statuses and counts", async () => {
    db.proposal.findMany.mockResolvedValue([
      { uuid: "old", projectUuid: P1, status: "approved", inputUuids: ["i1"], createdAt: at(1) },
      { uuid: "new", projectUuid: P1, status: "approved", inputUuids: ["i1", "i2"], createdAt: at(5) },
      { uuid: "pend", projectUuid: P1, status: "pending", inputUuids: ["i2"], createdAt: at(6) },
      { uuid: "bad", projectUuid: P1, status: "approved", inputUuids: "nope", createdAt: at(7) },
    ]);
    db.task.findMany.mockResolvedValue([
      { uuid: "t1", proposalUuid: "old", ideaUuid: null, status: "in_progress" },
      { uuid: "t2", proposalUuid: "new", ideaUuid: null, status: "done" },
      { uuid: "t3", proposalUuid: "new", ideaUuid: null, status: "to_verify" },
      { uuid: "q1", proposalUuid: null, ideaUuid: "i3", status: "done" },
      { uuid: "q2", proposalUuid: null, ideaUuid: "i3", status: "closed" },
      { uuid: "q3", proposalUuid: null, ideaUuid: "i1", status: "open" },
    ]);

    const contexts = await loadIdeaTaskContexts(client, COMPANY, [
      { uuid: "i1", projectUuid: P1 },
      { uuid: "i2", projectUuid: P1 },
      { uuid: "i3", projectUuid: P1 },
      { uuid: "i4", projectUuid: P1 },
    ]);

    expect(contexts.get("i1")).toEqual({
      hasPendingProposal: false,
      hasApprovedProposal: true,
      latestApprovedProposalUuid: "new",
      proposalTaskStatuses: ["done", "to_verify"],
      linkedTaskStatuses: ["open"],
      proposalCount: 2,
    });
    expect(contexts.get("i2")).toMatchObject({
      hasPendingProposal: true,
      hasApprovedProposal: true,
      latestApprovedProposalUuid: "new",
      proposalCount: 2,
      linkedTaskStatuses: [],
    });
    expect(contexts.get("i3")).toEqual({
      ...emptyIdeaTaskContext(),
      linkedTaskStatuses: ["done", "closed"],
    });
    expect(contexts.get("i4")).toEqual(emptyIdeaTaskContext());
  });

  it("honors proposal inputs only within the idea's own project", async () => {
    db.proposal.findMany.mockResolvedValue([
      { uuid: "foreign", projectUuid: P2, status: "pending", inputUuids: ["i1"], createdAt: at(2) },
      { uuid: "own", projectUuid: P1, status: "approved", inputUuids: ["i1"], createdAt: at(1) },
    ]);
    const contexts = await loadIdeaTaskContexts(client, COMPANY, [
      { uuid: "i1", projectUuid: P1 },
      { uuid: "i9", projectUuid: P2 },
    ]);
    expect(contexts.get("i1")).toMatchObject({ hasPendingProposal: false, latestApprovedProposalUuid: "own", proposalCount: 1 });
  });

  it("does not double-count a task linked to the idea that also belongs to its latest approved proposal", async () => {
    db.proposal.findMany.mockResolvedValue([
      { uuid: "p", projectUuid: P1, status: "approved", inputUuids: ["i1", "i1"], createdAt: at(1) },
    ]);
    db.task.findMany.mockResolvedValue([{ uuid: "t", proposalUuid: "p", ideaUuid: "i1", status: "done" }]);
    const contexts = await loadIdeaTaskContexts(client, COMPANY, [{ uuid: "i1", projectUuid: P1 }]);
    expect(ideaTaskStatuses(contexts.get("i1"))).toEqual(["done"]);
    expect(contexts.get("i1")!.proposalCount).toBe(1);
  });

  it("loadIdeaTaskData exposes the raw rows for fingerprinting", async () => {
    const proposals = [{ uuid: "p", projectUuid: P1, status: "approved", inputUuids: ["i1"], createdAt: at(1) }];
    const tasks = [{ uuid: "t", proposalUuid: "p", ideaUuid: null, status: "done" }];
    db.proposal.findMany.mockResolvedValue(proposals);
    db.task.findMany.mockResolvedValue(tasks);
    const data = await loadIdeaTaskData(client, COMPANY, [{ uuid: "i1", projectUuid: P1 }]);
    expect(data.proposals).toEqual(proposals);
    expect(data.tasks).toEqual(tasks);
  });
});

describe("ideaTaskStatuses", () => {
  it("is the union of approved-proposal tasks and linked tasks", () => {
    expect(ideaTaskStatuses(undefined)).toEqual([]);
    expect(ideaTaskStatuses({
      ...emptyIdeaTaskContext(),
      hasApprovedProposal: true,
      proposalTaskStatuses: ["done"],
      linkedTaskStatuses: ["open", "to_verify"],
    })).toEqual(["done", "open", "to_verify"]);
    // Proposal tasks only count while the proposal is approved.
    expect(ideaTaskStatuses({
      ...emptyIdeaTaskContext(),
      proposalTaskStatuses: ["done"],
      linkedTaskStatuses: ["open"],
    })).toEqual(["open"]);
  });
});
