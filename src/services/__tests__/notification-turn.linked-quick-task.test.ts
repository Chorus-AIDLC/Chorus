// Regression: a Quick Task linked directly to an Idea (Task.ideaUuid, no proposal) must
// anchor its daemon wakes to that Idea exactly like a proposal task does — session
// anchor (directIdeaUuid / idea session), root-idea instance-pin inheritance, and the
// direct-idea value mention routing reads. Unlike notification-turn.test.ts, the lineage
// resolver here is REAL (only its row getters are mocked), so this exercises the T1
// `task.ideaUuid` → `via_task_idea` branch end-to-end through the wake bridge.
import { describe, it, expect, vi, beforeEach } from "vitest";

const companyUuid = "company-0000-0000-0000-000000000001";
const agentUuid = "agent-0000-0000-0000-000000000001";
const developerUuid = "agent-0000-0000-0000-000000000002";
const taskUuid = "task-0000-0000-0000-0000000000q1";
const childIdea = "idea-child-0000-0000-0000-0000000000c1";
const rootIdea = "idea-root-0000-0000-0000-00000000000r";
const instanceUuid = "inst-0000-0000-0000-000000000001";
const pinnedHost = "Laptop-Q3";
const pinnedCwd = "/home/u/dev/payments";

type Row = Record<string, unknown>;
const rows = vi.hoisted(() => ({
  tasks: new Map<string, Row>(),
  ideas: new Map<string, Row>(),
}));

// ---- lineage row getters (the only lineage seam that is mocked) ----
vi.mock("@/services/task.service", () => ({
  getTaskByUuid: vi.fn(async (_c: string, uuid: string) => rows.tasks.get(uuid) ?? null),
}));
vi.mock("@/services/idea.service", () => ({
  getIdeaByUuid: vi.fn(async (_c: string, uuid: string) => rows.ideas.get(uuid) ?? null),
}));
vi.mock("@/services/proposal.service", () => ({ getProposalByUuid: vi.fn(async () => null) }));
vi.mock("@/services/document.service", () => ({ getDocumentByUuid: vi.fn(async () => null) }));

// ---- the bridge's prisma reads, served from the same fixture rows ----
const byUuid = vi.hoisted(() => (map: Map<string, Record<string, unknown>>) =>
  vi.fn(async ({ where }: { where: { uuid: string } }) => map.get(where.uuid) ?? null));
const mockAgentInstanceFindFirst = vi.hoisted(() => vi.fn());
vi.mock("@/lib/prisma", () => ({
  prisma: {
    agent: { findFirst: vi.fn(async () => ({ ownerUuid: null })) },
    task: { findFirst: byUuid(rows.tasks) },
    idea: { findFirst: byUuid(rows.ideas) },
    agentInstance: { findFirst: mockAgentInstanceFindFirst },
    daemonSession: { findFirst: vi.fn(async () => null), update: vi.fn(async () => ({})) },
    projectAgentCwdPreference: { findFirst: vi.fn(async () => null) },
  },
}));

const mockListConnectionsForAgent = vi.hoisted(() => vi.fn());
vi.mock("@/services/project-access.service", () => ({ canActorAccessProject: vi.fn(async () => true) }));
vi.mock("@/services/daemon-connection.service", () => ({ listConnectionsForAgent: mockListConnectionsForAgent }));
vi.mock("@/services/daemon-instruction.service", () => ({ deliverTurnPing: vi.fn() }));

// Session persistence is mocked; resolveDirectIdeaUuid stays the REAL lineage export.
const mockResolveOrCreateSession = vi.hoisted(() => vi.fn());
const mockCreatePendingTurn = vi.hoisted(() => vi.fn());
vi.mock("@/services/daemon-session.service", async () => {
  const lineage = await vi.importActual<typeof import("@/services/lineage.service")>("@/services/lineage.service");
  return {
    resolveOrCreateSession: mockResolveOrCreateSession,
    createPendingTurn: mockCreatePendingTurn,
    findReusablePendingInstructionTurn: vi.fn(async () => null),
    resolveDirectIdeaUuid: lineage.resolveDirectIdeaUuid,
  };
});

const childLogger = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }));
vi.mock("@/lib/logger", () => ({ default: { ...childLogger, child: () => childLogger } }));

import { maybeCreateTurnForWakeNotification, type WakeNotificationContext } from "@/services/notification-turn";
import { resolveRootIdea } from "@/services/lineage.service";

function conn(uuid: string, host: string, cwd: string, agent = agentUuid) {
  return {
    uuid, agentUuid: agent, agentName: "Daemon", clientType: "claude_code", clientVersion: null, host, cwd,
    startedAt: null, status: "online", effectiveStatus: "online" as const,
    connectedAt: "2026-11-05T00:00:00.000Z", lastSeenAt: "2026-11-05T00:00:00.000Z", disconnectedAt: null,
  };
}

const ctx = (overrides: Partial<WakeNotificationContext> = {}): WakeNotificationContext => ({
  companyUuid, recipientType: "agent", recipientUuid: agentUuid, entityType: "task", entityUuid: taskUuid,
  action: "task_assigned", ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  rows.tasks.clear();
  rows.ideas.clear();
  // Quick Task: no proposal, linked directly to the child idea (whose parent is the root).
  rows.tasks.set(taskUuid, { uuid: taskUuid, title: "Quick", proposalUuid: null, ideaUuid: childIdea, assigneeType: "agent", assigneeUuid: agentUuid, cwdHost: null, runtimeCwd: null });
  rows.ideas.set(childIdea, { uuid: childIdea, title: "Child", parentUuid: rootIdea, assigneeType: "agent", assigneeUuid: agentUuid, cwdHost: null, runtimeCwd: null });
  rows.ideas.set(rootIdea, { uuid: rootIdea, title: "Root", parentUuid: null, assigneeType: "agent", assigneeUuid: agentUuid, cwdHost: null, runtimeCwd: null });
  mockListConnectionsForAgent.mockResolvedValue([conn("conn-online-first", "other-host", "/home/u/dev/other"), conn("conn-pinned", pinnedHost, pinnedCwd)]);
  mockAgentInstanceFindFirst.mockResolvedValue(null);
  mockResolveOrCreateSession.mockImplementation(async (p: Row) => ({ uuid: "session-1", ...p }));
  mockCreatePendingTurn.mockImplementation(async (p: { trigger: string }) => ({ uuid: "turn-1", sessionUuid: "session-1", trigger: p.trigger, status: "pending" }));
});

describe("linked Quick Task wakes anchor to the Idea (task.ideaUuid lineage)", () => {
  it("resolves root-idea lineage via_task_idea with the child as the direct idea (the value mention routing reads)", async () => {
    const result = await resolveRootIdea(companyUuid, "task", taskUuid);
    expect(result).toMatchObject({ rootIdeaUuid: rootIdea, directIdeaUuid: childIdea, resolvedVia: "via_task_idea" });
    expect(result.lineage.map((node) => node.uuid)).toEqual([taskUuid, childIdea, rootIdea]);
  });

  it("anchors an orchestrator (idea-hinted) wake on the linked task to the Idea's daemon session", async () => {
    // The task is assigned to a developer; the recipient is the Idea's orchestrator.
    rows.tasks.get(taskUuid)!.assigneeUuid = developerUuid;
    await maybeCreateTurnForWakeNotification(ctx({ action: "mentioned", sessionAnchorHint: "idea" }));
    expect(mockResolveOrCreateSession).toHaveBeenCalledWith(expect.objectContaining({
      agentUuid, sessionId: childIdea, directIdeaUuid: childIdea,
    }));
  });

  it("keeps the assignee's task_assigned wake in a task session scoped to the Idea (not a standalone task)", async () => {
    // Orchestrator differs from the task assignee → per-task thread under the idea.
    rows.ideas.get(childIdea)!.assigneeUuid = developerUuid;
    await maybeCreateTurnForWakeNotification(ctx());
    expect(mockResolveOrCreateSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: `task:${taskUuid}`, directIdeaUuid: childIdea,
    }));
  });

  it("inherits the root Idea's agent_instance pin for a task_assigned wake (directed to the pinned connection)", async () => {
    Object.assign(rows.ideas.get(rootIdea)!, { assigneeType: "agent_instance", assigneeUuid: instanceUuid });
    mockAgentInstanceFindFirst.mockResolvedValue({ host: pinnedHost, cwd: pinnedCwd, agentUuid });
    await maybeCreateTurnForWakeNotification(ctx());
    expect(mockAgentInstanceFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ uuid: instanceUuid }) }));
    expect(mockResolveOrCreateSession).toHaveBeenCalledWith(expect.objectContaining({
      directIdeaUuid: childIdea, originConnectionUuid: "conn-pinned",
    }));
  });

  it("an unlinked Quick Task keeps standalone provenance (no idea anchor, no inherited pin)", async () => {
    Object.assign(rows.tasks.get(taskUuid)!, { ideaUuid: null });
    Object.assign(rows.ideas.get(rootIdea)!, { assigneeType: "agent_instance", assigneeUuid: instanceUuid });
    mockAgentInstanceFindFirst.mockResolvedValue({ host: pinnedHost, cwd: pinnedCwd, agentUuid });
    await maybeCreateTurnForWakeNotification(ctx());
    expect(mockResolveOrCreateSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: taskUuid, directIdeaUuid: null, originConnectionUuid: "conn-online-first",
    }));
    expect(mockAgentInstanceFindFirst).not.toHaveBeenCalled();
  });
});
