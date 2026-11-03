import { beforeEach, describe, expect, it, vi } from "vitest";
import { formatSessionAnchor, parseSessionAnchor } from "@/lib/session-anchor";

const mocks = vi.hoisted(() => ({
  task: vi.fn(), idea: vi.fn(), instance: vi.fn(), lineage: vi.fn(), warn: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: {
  task: { findFirst: mocks.task }, idea: { findFirst: mocks.idea }, agentInstance: { findFirst: mocks.instance },
} }));
vi.mock("@/lib/logger", () => ({ default: { warn: mocks.warn, child: () => ({ warn: mocks.warn }) } }));
vi.mock("@/services/daemon-session.service", () => ({ resolveDirectIdeaUuid: mocks.lineage }));
vi.mock("@/services/daemon-connection.service", () => ({ listConnectionsForAgent: vi.fn() }));
vi.mock("@/services/daemon-instruction.service", () => ({ deliverTurnPing: vi.fn() }));
vi.mock("@/services/lineage.service", () => ({ resolveRootIdea: vi.fn() }));
import { resolveWakeSessionAnchor, type WakeNotificationContext } from "@/services/notification-turn";

const ctx: WakeNotificationContext = {
  companyUuid: "company", recipientType: "agent", recipientUuid: "dev", entityType: "task", entityUuid: "T", action: "mentioned",
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.task.mockResolvedValue({ assigneeType: "agent", assigneeUuid: "dev" });
  mocks.idea.mockResolvedValue({ assigneeType: "agent", assigneeUuid: "orchestrator" });
  mocks.lineage.mockResolvedValue("I");
});

describe("session anchor codec", () => {
  it.each([
    ["idea", "idea", "I", "I"], ["task", "task", "T", "task:T"],
    ["review", "task", "T", "review:task:T"], ["review", "proposal", "P", "review:proposal:P"],
    ["review", "idea", "I", "review:idea:I"],
  ] as const)("formats %s/%s", (kind, type, uuid, expected) => {
    expect(formatSessionAnchor(kind, type, uuid)).toBe(expected);
    expect(parseSessionAnchor(expected, "I").kind).toBe(kind);
  });
  it.each(["task:", "review:document:X", "review:task:", "review:task:T:extra", "adhoc"])("leaves malformed/non-anchor %s ad hoc", (id) => {
    expect(parseSessionAnchor(id, "I").kind).toBe("adhoc");
  });
});

describe("ordered wake anchor rules", () => {
  it("leaves quick tasks unchanged even with a hint", async () => {
    expect(await resolveWakeSessionAnchor({ ...ctx, sessionAnchorHint: "review:task:T" }, null)).toBe("T");
    expect(mocks.lineage).not.toHaveBeenCalled();
  });
  it.each(["human_instruction", "idea_creation_requested", "research_requested"])("keeps %s Idea-scoped before hints", async (action) => {
    expect(await resolveWakeSessionAnchor({ ...ctx, action, sessionAnchorHint: "review:task:T" }, "I")).toBe("I");
    expect(mocks.lineage).not.toHaveBeenCalled();
  });
  it.each(["review:task:T", "review:proposal:P", "review:idea:I", "task:T"])("validates hinted %s lineage in the company", async (sessionAnchorHint) => {
    expect(await resolveWakeSessionAnchor({ ...ctx, sessionAnchorHint }, "I")).toBe(sessionAnchorHint);
    expect(mocks.lineage).toHaveBeenCalledWith("company", expect.any(String), expect.any(String));
    expect(mocks.task).not.toHaveBeenCalled();
  });
  it.each([null, "other-Idea"])("rejects a missing or foreign lineage (%s) without falling through to assignee", async (lineage) => {
    mocks.lineage.mockResolvedValue(lineage);
    expect(await resolveWakeSessionAnchor({ ...ctx, sessionAnchorHint: "review:task:T" }, "I")).toBe("I");
    expect(mocks.warn).toHaveBeenCalled();
    expect(mocks.task).not.toHaveBeenCalled();
  });
  it("rejects a malformed hint", async () => {
    expect(await resolveWakeSessionAnchor({ ...ctx, sessionAnchorHint: "invalid" }, "I")).toBe("I");
    expect(mocks.warn).toHaveBeenCalled();
  });
  it("lets the Idea handoff hint override task ownership", async () => {
    expect(await resolveWakeSessionAnchor({ ...ctx, sessionAnchorHint: "idea" }, "I")).toBe("I");
    expect(mocks.task).not.toHaveBeenCalled();
  });
  it("uses a task anchor for the developer", async () => {
    expect(await resolveWakeSessionAnchor(ctx, "I")).toBe("task:T");
  });
  it("keeps a non-assignee recipient in the Idea", async () => {
    expect(await resolveWakeSessionAnchor({ ...ctx, recipientUuid: "reviewer" }, "I")).toBe("I");
  });
  it("resolves an instance assignee to its logical agent", async () => {
    mocks.task.mockResolvedValue({ assigneeType: "agent_instance", assigneeUuid: "instance" });
    mocks.instance.mockResolvedValue({ agentUuid: "dev" });
    expect(await resolveWakeSessionAnchor(ctx, "I")).toBe("task:T");
  });
  it.each(["task_assigned", "task_reopened"])("starts an assignee-orchestrator task on %s", async (action) => {
    mocks.idea.mockResolvedValue({ assigneeType: "agent_instance", assigneeUuid: "instance" });
    mocks.instance.mockResolvedValue({ agentUuid: "dev" });
    expect(await resolveWakeSessionAnchor({ ...ctx, action }, "I")).toBe("task:T");
  });
  it.each(["mentioned", "comment_added", "task_verified"])("keeps an assignee-orchestrator %s/VERDICT reply in the Idea", async (action) => {
    mocks.idea.mockResolvedValue({ assigneeType: "agent", assigneeUuid: "dev" });
    expect(await resolveWakeSessionAnchor({ ...ctx, action }, "I")).toBe("I");
  });
  it("keeps non-task wakes Idea-scoped", async () => {
    expect(await resolveWakeSessionAnchor({ ...ctx, entityType: "proposal" }, "I")).toBe("I");
  });
});
