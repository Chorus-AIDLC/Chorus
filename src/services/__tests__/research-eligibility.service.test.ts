import { beforeEach, describe, expect, it, vi } from "vitest";
const db = vi.hoisted(() => ({
  idea: { findFirst: vi.fn(), findMany: vi.fn() },
  proposal: { findMany: vi.fn() },
  task: { findMany: vi.fn() },
  activity: { findMany: vi.fn() },
  daemonSessionTurn: { findFirst: vi.fn(), updateMany: vi.fn() },
  $queryRaw: vi.fn(),
  $transaction: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: db }));
import { getResearchEligibility, recheckResearchTurn } from "@/services/research-eligibility.service";

beforeEach(() => {
  vi.resetAllMocks();
  db.idea.findFirst.mockResolvedValue({ uuid: "idea", projectUuid: "project", status: "open" });
  db.idea.findMany.mockResolvedValue([{ uuid: "idea", parentUuid: null, status: "open" }]);
  db.proposal.findMany.mockResolvedValue([]);
  db.task.findMany.mockResolvedValue([]);
  db.activity.findMany.mockResolvedValue([]);
  db.daemonSessionTurn.findFirst.mockResolvedValue(null);
  db.$transaction.mockImplementation((fn) => fn(db));
});

describe("Research eligibility", () => {
  it.each(["open", "elaborating", "elaborated"])("allows %s including pending answers", async (status) => {
    db.idea.findFirst.mockResolvedValue({ uuid: "idea", projectUuid: "project", status, elaborationStatus: "pending" });
    expect(await getResearchEligibility("company", "idea")).toEqual({ eligible: true });
  });
  it.each(["draft", "pending", "approved", "rejected"])("does not gate on proposal status %s", async (status) => {
    db.proposal.findMany.mockResolvedValue([{ uuid: "proposal", status }]);
    db.task.findMany.mockResolvedValue([{ uuid: "task", status: "open" }, { uuid: "other", status: "assigned" }]);
    expect(await getResearchEligibility("company", "idea")).toEqual({ eligible: true });
  });
  it("scopes all proposal queries to tenant/project and includes grandchildren, not siblings", async () => {
    db.idea.findMany.mockResolvedValue([
      { uuid: "grandchild", parentUuid: "child" }, { uuid: "child", parentUuid: "idea" },
      { uuid: "sibling", parentUuid: null }, { uuid: "idea", parentUuid: null },
    ]);
    await getResearchEligibility("company", "idea");
    expect(db.proposal.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: {
      companyUuid: "company", projectUuid: "project", inputType: "idea",
      OR: ["idea", "child", "grandchild"].map((id) => ({ inputUuids: { array_contains: [id] } })),
    } }));
  });
  it.each(["in_progress", "to_verify", "done"])("rejects %s in any older proposal", async (status) => {
    db.proposal.findMany.mockResolvedValue([{ uuid: "old" }, { uuid: "new" }]);
    db.task.findMany.mockResolvedValue([{ uuid: "old-task", status }, { uuid: "new-task", status: "open" }]);
    expect(await getResearchEligibility("company", "idea")).toEqual({ eligible: false, reason: "development_started" });
    expect(db.task.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: {
      companyUuid: "company", proposalUuid: { in: ["old", "new"] },
    } }));
  });
  it.each([
    ["status_changed", { status: "in_progress" }],
    ["force_status_change", { from: "to_verify", to: "open" }],
    ["comment_added", { statusUpdated: "in_progress" }],
    ["updated", { newStatus: "done" }],
    ["execution_started", null],
    ["submitted", null],
    ["verified", null],
  ])("retains execution history %s after reopening/closing", async (action, value) => {
    db.proposal.findMany.mockResolvedValue([{ uuid: "old" }]);
    db.task.findMany.mockResolvedValue([{ uuid: "task", status: "closed" }]);
    db.activity.findMany.mockResolvedValue([{ targetType: "task", action, value }]);
    expect(await getResearchEligibility("company", "idea")).toEqual({ eligible: false, reason: "development_started" });
  });
  it("does not infer execution from assigned/closed or yolo planning", async () => {
    db.proposal.findMany.mockResolvedValue([{ uuid: "proposal" }]);
    db.task.findMany.mockResolvedValue([{ uuid: "task", status: "closed" }]);
    db.activity.findMany.mockResolvedValue([{ targetType: "task", action: "status_changed", value: { from: "assigned", to: "closed" } }]);
    expect(await getResearchEligibility("company", "idea")).toEqual({ eligible: true });
    expect(db.activity.findMany.mock.calls[0][0].where.OR[0].action).toBe("start_development");
  });
  it.each(["activity", "turn"])("rejects development accepted via %s before task changes", async (source) => {
    if (source === "activity") db.activity.findMany.mockResolvedValue([{ targetType: "idea", action: "start_development" }]);
    else db.daemonSessionTurn.findFirst.mockResolvedValueOnce({ uuid: "development" });
    expect(await getResearchEligibility("company", "idea")).toEqual({ eligible: false, reason: "development_started" });
  });
  it.each(["pending", "running"])("rejects duplicate %s research across agents", async () => {
    db.daemonSessionTurn.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ uuid: "research" });
    expect(await getResearchEligibility("company", "idea")).toEqual({ eligible: false, reason: "already_running" });
    const where = db.daemonSessionTurn.findFirst.mock.calls[1][0].where;
    expect(where.status.in).toEqual(["pending", "running"]);
    expect(where.session).toEqual({ companyUuid: "company", directIdeaUuid: "idea" });
  });
  it("does not disclose another tenant's idea", async () => {
    db.idea.findFirst.mockResolvedValue(null);
    expect(await getResearchEligibility("foreign", "idea")).toEqual({ eligible: false, reason: "idea_not_found" });
    expect(db.proposal.findMany).not.toHaveBeenCalled();
  });
  it("rechecks and retires pending research under the project lock after development", async () => {
    db.activity.findMany.mockResolvedValue([{ targetType: "idea", action: "start_development" }]);
    expect(await recheckResearchTurn("company", "idea", "turn")).toBe(false);
    expect(db.$queryRaw).toHaveBeenCalledOnce();
    expect(db.daemonSessionTurn.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "interrupted", interruptedReason: "research_stage_changed" }),
    }));
  });
  it("allows consumption of its own pending research", async () => {
    expect(await recheckResearchTurn("company", "idea", "turn")).toBe(true);
    expect(db.daemonSessionTurn.findFirst).toHaveBeenCalledOnce();
    expect(db.daemonSessionTurn.updateMany).not.toHaveBeenCalled();
  });
});
