import { describe, it, expect, vi, beforeEach } from "vitest";
import { detectResource, classifyAction, resolveProjectUuid } from "../tools/presence";

// Mock prisma
vi.mock("@/lib/prisma", () => ({
  prisma: {
    task: { findFirst: vi.fn() },
    idea: { findFirst: vi.fn() },
    proposal: { findFirst: vi.fn() },
    document: { findFirst: vi.fn() },
  },
}));

import { prisma } from "@/lib/prisma";

describe("presence wrapper", () => {
  describe("classifyAction", () => {
    it("classifies chorus_get_* as view", () => {
      expect(classifyAction("chorus_get_project")).toBe("view");
      expect(classifyAction("chorus_get_task")).toBe("view");
      expect(classifyAction("chorus_get_idea")).toBe("view");
    });

    it("classifies chorus_list_* as view", () => {
      expect(classifyAction("chorus_list_projects")).toBe("view");
      expect(classifyAction("chorus_list_tasks")).toBe("view");
    });

    it("classifies chorus_search_* as view", () => {
      expect(classifyAction("chorus_search")).toBe("view");
      expect(classifyAction("chorus_search_mentionables")).toBe("view");
    });

    it("classifies other tools as mutate", () => {
      expect(classifyAction("chorus_claim_task")).toBe("mutate");
      expect(classifyAction("chorus_update_task")).toBe("mutate");
      expect(classifyAction("chorus_add_comment")).toBe("mutate");
      expect(classifyAction("chorus_pm_create_idea")).toBe("mutate");
      expect(classifyAction("chorus_checkin")).toBe("mutate");
    });
  });

  describe("detectResource", () => {
    it("detects taskUuid", () => {
      const result = detectResource({ taskUuid: "t-1", projectUuid: "p-1" });
      expect(result).toEqual({
        entityType: "task",
        entityUuid: "t-1",
        projectUuid: "p-1",
      });
    });

    it("detects ideaUuid", () => {
      const result = detectResource({ ideaUuid: "i-1" });
      expect(result).toEqual({
        entityType: "idea",
        entityUuid: "i-1",
        projectUuid: undefined,
      });
    });

    it("detects proposalUuid", () => {
      const result = detectResource({ proposalUuid: "pr-1" });
      expect(result).toEqual({
        entityType: "proposal",
        entityUuid: "pr-1",
        projectUuid: undefined,
      });
    });

    it("detects documentUuid", () => {
      const result = detectResource({ documentUuid: "d-1", projectUuid: "p-1" });
      expect(result).toEqual({
        entityType: "document",
        entityUuid: "d-1",
        projectUuid: "p-1",
      });
    });

    it("detects polymorphic targetUuid + targetType", () => {
      const result = detectResource({
        targetUuid: "t-1",
        targetType: "task",
      });
      expect(result).toEqual({
        entityType: "task",
        entityUuid: "t-1",
        projectUuid: undefined,
      });
    });

    it("handles unknown targetType gracefully", () => {
      const result = detectResource({
        targetUuid: "x-1",
        targetType: "unknown_entity",
      });
      expect(result).toBeNull();
    });

    it("returns null for tools without resource UUIDs", () => {
      const result = detectResource({ query: "search term" });
      expect(result).toBeNull();
    });

    it("returns null for empty params", () => {
      const result = detectResource({});
      expect(result).toBeNull();
    });

    it("prioritizes entity-specific UUID over targetUuid", () => {
      const result = detectResource({
        taskUuid: "t-1",
        targetUuid: "i-1",
        targetType: "idea",
      });
      expect(result?.entityType).toBe("task");
      expect(result?.entityUuid).toBe("t-1");
    });
  });

  describe("resolveProjectUuid", () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it("resolves projectUuid for a task", async () => {
      vi.mocked(prisma.task.findFirst).mockResolvedValue({
        project: { uuid: "proj-resolved" },
      } as never);

      const cache = new Map<string, string>();
      const result = await resolveProjectUuid("task", "task-1", cache);

      expect(result).toBe("proj-resolved");
      expect(prisma.task.findFirst).toHaveBeenCalledWith({
        where: { uuid: "task-1" },
        select: { project: { select: { uuid: true } } },
      });
    });

    it("resolves projectUuid for an idea", async () => {
      vi.mocked(prisma.idea.findFirst).mockResolvedValue({
        project: { uuid: "proj-idea" },
      } as never);

      const cache = new Map<string, string>();
      const result = await resolveProjectUuid("idea", "idea-1", cache);
      expect(result).toBe("proj-idea");
    });

    it("resolves projectUuid for a proposal", async () => {
      vi.mocked(prisma.proposal.findFirst).mockResolvedValue({
        project: { uuid: "proj-prop" },
      } as never);

      const cache = new Map<string, string>();
      const result = await resolveProjectUuid("proposal", "prop-1", cache);
      expect(result).toBe("proj-prop");
    });

    it("resolves projectUuid for a document", async () => {
      vi.mocked(prisma.document.findFirst).mockResolvedValue({
        project: { uuid: "proj-doc" },
      } as never);

      const cache = new Map<string, string>();
      const result = await resolveProjectUuid("document", "doc-1", cache);
      expect(result).toBe("proj-doc");
    });

    it("caches resolved projectUuid", async () => {
      vi.mocked(prisma.task.findFirst).mockResolvedValue({
        project: { uuid: "proj-cached" },
      } as never);

      const cache = new Map<string, string>();
      await resolveProjectUuid("task", "task-cache", cache);
      const result2 = await resolveProjectUuid("task", "task-cache", cache);

      expect(result2).toBe("proj-cached");
      // Should only query once due to cache
      expect(prisma.task.findFirst).toHaveBeenCalledTimes(1);
    });

    it("returns null when entity not found", async () => {
      vi.mocked(prisma.task.findFirst).mockResolvedValue(null);

      const cache = new Map<string, string>();
      const result = await resolveProjectUuid("task", "not-found", cache);
      expect(result).toBeNull();
    });

    it("returns null on DB error", async () => {
      vi.mocked(prisma.task.findFirst).mockRejectedValue(new Error("DB error"));

      const cache = new Map<string, string>();
      const result = await resolveProjectUuid("task", "error-task", cache);
      expect(result).toBeNull();
    });
  });
});
