// Unit tests for research.service requestResearch — private project access gate on the
// research notification/wake writer (Tech Design D4 "Notifications" / "Daemon wakes").
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockPrisma = vi.hoisted(() => ({
  idea: { findFirst: vi.fn() },
  agent: { findFirst: vi.fn() },
  daemonSession: { findFirst: vi.fn() },
  daemonConnection: { count: vi.fn() },
  $transaction: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/event-bus", () => ({ eventBus: { emit: vi.fn(), emitChange: vi.fn() } }));

const mockResolveAssigneeAgentUuid = vi.hoisted(() => vi.fn());
vi.mock("@/lib/uuid-resolver", () => ({ resolveAssigneeAgentUuid: mockResolveAssigneeAgentUuid }));

const mockResolveTarget = vi.hoisted(() => vi.fn());
vi.mock("@/services/project-agent-cwd.service", () => ({ resolveProjectAgentCwdTarget: mockResolveTarget }));
vi.mock("@/services/daemon-session.service", () => ({
  createPendingTurn: vi.fn(),
  resolveOrCreateSession: vi.fn(),
  publishTranscriptEvent: vi.fn(),
  STALE_THRESHOLD_MS: 60_000,
}));
vi.mock("@/services/daemon-instruction.service", () => ({ deliverTurnPing: vi.fn() }));
vi.mock("@/services/daemon-operation", () => ({ dedicatedOperationWrites: () => true }));
vi.mock("@/services/research-eligibility.service", () => ({
  getResearchEligibility: vi.fn(),
  lockResearchProject: vi.fn(),
}));

const mockFilterRecipients = vi.hoisted(() => vi.fn());
vi.mock("@/services/project-access.service", () => ({
  filterRecipientsByProjectAccess: mockFilterRecipients,
}));

import { requestResearch } from "@/services/research.service";

const companyUuid = "company-1";
const actorUuid = "owner-1";
const agentUuid = "agent-1";
const projectUuid = "project-private";
const ideaUuid = "idea-1";

const params = { companyUuid, ideaUuid, actorUuid, actorType: "user" };

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.idea.findFirst.mockResolvedValue({
    uuid: ideaUuid, companyUuid, projectUuid, title: "Idea",
    assigneeType: "agent", assigneeUuid: agentUuid, cwdSource: null, cwdHost: null, runtimeCwd: null,
  });
  mockResolveAssigneeAgentUuid.mockResolvedValue(agentUuid);
  mockPrisma.agent.findFirst.mockResolvedValue({
    uuid: agentUuid, ownerUuid: actorUuid, roles: ["developer_agent", "pm_agent"], permissions: [],
  });
});

describe("requestResearch — project access", () => {
  it("rejects with permission_denied when the target agent cannot see the private project", async () => {
    mockFilterRecipients.mockResolvedValue([]);
    await expect(requestResearch(params)).rejects.toMatchObject({ code: "permission_denied" });
    expect(mockFilterRecipients).toHaveBeenCalledWith(companyUuid, projectUuid, [
      { type: "agent", uuid: agentUuid },
    ]);
    // Rejected before any target resolution, transaction, turn or notification write.
    expect(mockResolveTarget).not.toHaveBeenCalled();
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it("proceeds past the gate when the target agent's owner is a member", async () => {
    mockFilterRecipients.mockImplementation(async (_c: string, _p: string, r: unknown[]) => r);
    const sentinel = new Error("reached target resolution");
    mockResolveTarget.mockRejectedValue(sentinel);
    await expect(requestResearch(params)).rejects.toBe(sentinel);
    expect(mockResolveTarget).toHaveBeenCalled();
  });
});

describe("requestResearch — access re-checked under the project lock", () => {
  // Membership is revoked AFTER the pre-transaction gate passed but BEFORE the
  // project lock was acquired; the transaction must observe the committed removal.
  function reachTransaction(member: { role: string } | null, visibility = "private") {
    mockFilterRecipients.mockImplementation(async (_c: string, _p: string, r: unknown[]) => r);
    mockResolveTarget.mockResolvedValue({ source: "unconfigured", connectionUuid: "conn-1", availability: "ready" });
    mockPrisma.daemonSession.findFirst.mockResolvedValue(null);
    mockPrisma.daemonConnection.count.mockResolvedValue(1);
    const tx = {
      $queryRaw: vi.fn(async () => []),
      idea: { findFirst: mockPrisma.idea.findFirst, update: vi.fn() },
      agent: { findFirst: mockPrisma.agent.findFirst },
      project: { findFirst: vi.fn(async () => ({ visibility })) },
      projectMember: { findUnique: vi.fn(async () => member) },
      notification: { create: vi.fn() },
      daemonConnection: { findFirst: vi.fn() },
      daemonSession: { findFirst: vi.fn() },
    };
    mockPrisma.$transaction.mockImplementation(async (cb: (t: typeof tx) => unknown) => cb(tx));
    return tx;
  }

  it("rejects with permission_denied (no turn, no notification) when the owner was removed meanwhile", async () => {
    const tx = reachTransaction(null);
    await expect(requestResearch(params)).rejects.toMatchObject({ code: "permission_denied" });
    expect(tx.projectMember.findUnique).toHaveBeenCalled();
    expect(tx.notification.create).not.toHaveBeenCalled();
    expect(tx.daemonConnection.findFirst).not.toHaveBeenCalled(); // stopped before origin / turn
  });

  it("rejects a user actor who was demoted to viewer meanwhile", async () => {
    reachTransaction({ role: "viewer" });
    await expect(requestResearch(params)).rejects.toMatchObject({ code: "permission_denied" });
  });

  it("public projects skip the membership re-check", async () => {
    const tx = reachTransaction(null, "public");
    // Proceeds past the access re-check to eligibility (mocked to undefined → throws TypeError).
    await expect(requestResearch(params)).rejects.not.toMatchObject({ code: "permission_denied" });
    expect(tx.projectMember.findUnique).not.toHaveBeenCalled();
  });
});
