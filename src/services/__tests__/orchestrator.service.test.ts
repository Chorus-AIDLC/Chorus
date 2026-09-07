import { beforeEach, describe, expect, it, vi } from "vitest";

const mockPrisma = vi.hoisted(() => ({
  idea: { findFirst: vi.fn() },
  task: { findFirst: vi.fn() },
  daemonSession: { findFirst: vi.fn() },
}));
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));

const mockResolveAssignmentActor = vi.hoisted(() => vi.fn());
vi.mock("@/lib/uuid-resolver", () => ({
  resolveAssignmentActor: mockResolveAssignmentActor,
}));

const mockListConnectionsForAgent = vi.hoisted(() => vi.fn());
vi.mock("@/services/daemon-connection.service", () => ({
  listConnectionsForAgent: mockListConnectionsForAgent,
}));

import {
  resolveResourceOrchestrator,
  resolveWakerSessionAnchor,
} from "@/services/orchestrator.service";

describe("resolveResourceOrchestrator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(["idea", "task"])(
    "returns the directly addressed %s's live agent assigner",
    async (entityType) => {
      const resourceType = entityType as "idea" | "task";
      mockPrisma[resourceType].findFirst.mockResolvedValue({
        assignedByType: "agent",
        assignedByUuid: "agent-1",
      });
      mockResolveAssignmentActor.mockResolvedValue({
        type: "agent",
        uuid: "agent-1",
        name: "Coordinator",
      });

      await expect(
        resolveResourceOrchestrator(
          "company-1",
          resourceType,
          `${resourceType}-1`,
        ),
      ).resolves.toEqual({
        type: "agent",
        uuid: "agent-1",
        name: "Coordinator",
      });
      expect(mockPrisma[resourceType].findFirst).toHaveBeenCalledWith({
        where: { uuid: `${resourceType}-1`, companyUuid: "company-1" },
        select: { assignedByType: true, assignedByUuid: true },
      });
    },
  );

  it("uses compatibility resolution for a null-type legacy assigner", async () => {
    mockPrisma.task.findFirst.mockResolvedValue({
      assignedByType: null,
      assignedByUuid: "legacy-agent",
    });
    mockResolveAssignmentActor.mockResolvedValue({
      type: "agent",
      uuid: "legacy-agent",
      name: "Legacy Coordinator",
    });

    await resolveResourceOrchestrator("company-1", "task", "task-1");

    expect(mockResolveAssignmentActor).toHaveBeenCalledWith(
      "company-1",
      null,
      "legacy-agent",
    );
  });

  it.each([
    ["user provenance", { assignedByType: "user", assignedByUuid: "user-1" }],
    ["self-claim", { assignedByType: null, assignedByUuid: null }],
  ])("returns null for %s", async (_label, provenance) => {
    mockPrisma.idea.findFirst.mockResolvedValue(provenance);

    await expect(
      resolveResourceOrchestrator("company-1", "idea", "idea-1"),
    ).resolves.toBeNull();
    expect(mockResolveAssignmentActor).not.toHaveBeenCalled();
  });

  it("returns null when the agent assigner was deleted or is unknown", async () => {
    mockPrisma.task.findFirst.mockResolvedValue({
      assignedByType: "agent",
      assignedByUuid: "missing-agent",
    });
    mockResolveAssignmentActor.mockResolvedValue(null);

    await expect(
      resolveResourceOrchestrator("company-1", "task", "task-1"),
    ).resolves.toBeNull();
  });

  it.each(["proposal", "document", "daemon_session"])(
    "returns null for %s without querying resource lineage",
    async (entityType) => {
      await expect(
        resolveResourceOrchestrator("company-1", entityType, "entity-1"),
      ).resolves.toBeNull();
      expect(mockPrisma.idea.findFirst).not.toHaveBeenCalled();
      expect(mockPrisma.task.findFirst).not.toHaveBeenCalled();
      expect(mockResolveAssignmentActor).not.toHaveBeenCalled();
    },
  );
});

describe("resolveWakerSessionAnchor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the anchor when the waker's idea session has an online origin", async () => {
    mockPrisma.daemonSession.findFirst.mockResolvedValue({
      originConnectionUuid: "conn-1",
    });
    mockListConnectionsForAgent.mockResolvedValue([
      { uuid: "conn-0", agentName: "Waker", effectiveStatus: "offline" },
      { uuid: "conn-1", agentName: "Waker", effectiveStatus: "online" },
    ]);

    await expect(
      resolveWakerSessionAnchor("company-1", "agent-1", "idea-1"),
    ).resolves.toEqual({
      agentUuid: "agent-1",
      agentName: "Waker",
      ideaUuid: "idea-1",
    });
    // The session business key is the idea (sessionId === ideaUuid), scoped by company+agent.
    expect(mockPrisma.daemonSession.findFirst).toHaveBeenCalledWith({
      where: { companyUuid: "company-1", agentUuid: "agent-1", sessionId: "idea-1" },
      select: { originConnectionUuid: true },
    });
    expect(mockListConnectionsForAgent).toHaveBeenCalledWith("company-1", "agent-1");
  });

  it("returns null when the waker has no session for the idea (no connection lookup)", async () => {
    mockPrisma.daemonSession.findFirst.mockResolvedValue(null);

    await expect(
      resolveWakerSessionAnchor("company-1", "agent-1", "idea-1"),
    ).resolves.toBeNull();
    expect(mockListConnectionsForAgent).not.toHaveBeenCalled();
  });

  it("returns null when the session's origin connection is offline", async () => {
    mockPrisma.daemonSession.findFirst.mockResolvedValue({
      originConnectionUuid: "conn-1",
    });
    mockListConnectionsForAgent.mockResolvedValue([
      { uuid: "conn-1", agentName: "Waker", effectiveStatus: "offline" },
    ]);

    await expect(
      resolveWakerSessionAnchor("company-1", "agent-1", "idea-1"),
    ).resolves.toBeNull();
  });

  it("returns null when the session's origin connection is not among the agent's connections", async () => {
    mockPrisma.daemonSession.findFirst.mockResolvedValue({
      originConnectionUuid: "conn-gone",
    });
    // Another connection is online, but it is NOT the session's origin — no anchor.
    mockListConnectionsForAgent.mockResolvedValue([
      { uuid: "conn-other", agentName: "Waker", effectiveStatus: "online" },
    ]);

    await expect(
      resolveWakerSessionAnchor("company-1", "agent-1", "idea-1"),
    ).resolves.toBeNull();
  });

  it("falls back to an empty agentName when the online connection has no joined name", async () => {
    mockPrisma.daemonSession.findFirst.mockResolvedValue({
      originConnectionUuid: "conn-1",
    });
    mockListConnectionsForAgent.mockResolvedValue([
      { uuid: "conn-1", agentName: null, effectiveStatus: "online" },
    ]);

    await expect(
      resolveWakerSessionAnchor("company-1", "agent-1", "idea-1"),
    ).resolves.toEqual({
      agentUuid: "agent-1",
      agentName: "",
      ideaUuid: "idea-1",
    });
  });
});
