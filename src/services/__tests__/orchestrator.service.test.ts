import { beforeEach, describe, expect, it, vi } from "vitest";

const mockPrisma = vi.hoisted(() => ({
  idea: { findFirst: vi.fn() },
  task: { findFirst: vi.fn() },
}));
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));

const mockResolveAssignmentActor = vi.hoisted(() => vi.fn());
vi.mock("@/lib/uuid-resolver", () => ({
  resolveAssignmentActor: mockResolveAssignmentActor,
}));

import { resolveResourceOrchestrator } from "@/services/orchestrator.service";

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
