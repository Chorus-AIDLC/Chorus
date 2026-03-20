import { vi, describe, it, expect, beforeEach } from "vitest";

// ===== Module mocks (hoisted) =====

const mockPrisma = vi.hoisted(() => ({
  task: {
    findMany: vi.fn(),
    count: vi.fn(),
  },
  idea: {
    findMany: vi.fn(),
    count: vi.fn(),
  },
  proposal: {
    findMany: vi.fn(),
    count: vi.fn(),
  },
  document: {
    findMany: vi.fn(),
    count: vi.fn(),
  },
  project: {
    findMany: vi.fn(),
    count: vi.fn(),
  },
  projectGroup: {
    findMany: vi.fn(),
    count: vi.fn(),
  },
}));

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));

// ===== Import under test (after mocks) =====

import { search } from "@/services/search.service";

// ===== Test Suite =====

describe("search.service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("global search", () => {
    it("should return results from all entity types", async () => {
      const now = new Date();
      const companyUuid = "company-1";

      // Mock task search
      mockPrisma.task.findMany.mockResolvedValue([
        {
          uuid: "task-1",
          title: "Test task",
          description: "Task description with test keyword",
          status: "open",
          projectUuid: "project-1",
          updatedAt: now,
          project: { name: "Project A" },
        },
      ]);
      mockPrisma.task.count.mockResolvedValue(1);

      // Mock idea search
      mockPrisma.idea.findMany.mockResolvedValue([
        {
          uuid: "idea-1",
          title: "Test idea",
          content: "Idea content with test keyword",
          status: "open",
          projectUuid: "project-1",
          updatedAt: now,
          project: { name: "Project A" },
        },
      ]);
      mockPrisma.idea.count.mockResolvedValue(1);

      // Mock proposal search
      mockPrisma.proposal.findMany.mockResolvedValue([
        {
          uuid: "proposal-1",
          title: "Test proposal",
          description: "Proposal description",
          status: "draft",
          projectUuid: "project-1",
          updatedAt: now,
          project: { name: "Project A" },
        },
      ]);
      mockPrisma.proposal.count.mockResolvedValue(1);

      // Mock document search
      mockPrisma.document.findMany.mockResolvedValue([
        {
          uuid: "doc-1",
          title: "Test document",
          content: "Document content",
          type: "prd",
          projectUuid: "project-1",
          updatedAt: now,
          project: { name: "Project A" },
        },
      ]);
      mockPrisma.document.count.mockResolvedValue(1);

      // Mock project search
      mockPrisma.project.findMany.mockResolvedValue([
        {
          uuid: "project-1",
          name: "Test project",
          description: "Project description",
          updatedAt: now,
        },
      ]);
      mockPrisma.project.count.mockResolvedValue(1);

      // Mock project group search
      mockPrisma.projectGroup.findMany.mockResolvedValue([
        {
          uuid: "group-1",
          name: "Test group",
          description: "Group description",
          updatedAt: now,
        },
      ]);
      mockPrisma.projectGroup.count.mockResolvedValue(1);

      const result = await search({
        query: "test",
        companyUuid,
        scope: "global",
      });

      expect(result.results).toHaveLength(6);
      expect(result.counts.tasks).toBe(1);
      expect(result.counts.ideas).toBe(1);
      expect(result.counts.proposals).toBe(1);
      expect(result.counts.documents).toBe(1);
      expect(result.counts.projects).toBe(1);
      expect(result.counts.projectGroups).toBe(1);
    });

    it("should filter by entity types", async () => {
      const now = new Date();
      const companyUuid = "company-1";

      mockPrisma.task.findMany.mockResolvedValue([
        {
          uuid: "task-1",
          title: "Test task",
          description: "Description",
          status: "open",
          projectUuid: "project-1",
          updatedAt: now,
          project: { name: "Project A" },
        },
      ]);
      mockPrisma.task.count.mockResolvedValue(1);

      mockPrisma.idea.findMany.mockResolvedValue([
        {
          uuid: "idea-1",
          title: "Test idea",
          content: "Content",
          status: "open",
          projectUuid: "project-1",
          updatedAt: now,
          project: { name: "Project A" },
        },
      ]);
      mockPrisma.idea.count.mockResolvedValue(1);

      const result = await search({
        query: "test",
        companyUuid,
        scope: "global",
        entityTypes: ["task", "idea"],
      });

      expect(result.results).toHaveLength(2);
      expect(result.counts.tasks).toBe(1);
      expect(result.counts.ideas).toBe(1);
      expect(result.counts.proposals).toBe(0);
      expect(result.counts.documents).toBe(0);
      expect(result.counts.projects).toBe(0);
      expect(result.counts.projectGroups).toBe(0);

      // Verify only task and idea were searched
      expect(mockPrisma.task.findMany).toHaveBeenCalled();
      expect(mockPrisma.idea.findMany).toHaveBeenCalled();
      expect(mockPrisma.proposal.findMany).not.toHaveBeenCalled();
      expect(mockPrisma.document.findMany).not.toHaveBeenCalled();
      expect(mockPrisma.project.findMany).not.toHaveBeenCalled();
      expect(mockPrisma.projectGroup.findMany).not.toHaveBeenCalled();
    });
  });

  describe("project scope", () => {
    it("should filter results by project UUID", async () => {
      const now = new Date();
      const companyUuid = "company-1";
      const projectUuid = "project-1";

      mockPrisma.task.findMany.mockResolvedValue([
        {
          uuid: "task-1",
          title: "Test task",
          description: "Description",
          status: "open",
          projectUuid,
          updatedAt: now,
          project: { name: "Project A" },
        },
      ]);
      mockPrisma.task.count.mockResolvedValue(1);

      mockPrisma.idea.findMany.mockResolvedValue([]);
      mockPrisma.idea.count.mockResolvedValue(0);

      mockPrisma.proposal.findMany.mockResolvedValue([]);
      mockPrisma.proposal.count.mockResolvedValue(0);

      mockPrisma.document.findMany.mockResolvedValue([]);
      mockPrisma.document.count.mockResolvedValue(0);

      mockPrisma.project.findMany.mockResolvedValue([]);
      mockPrisma.project.count.mockResolvedValue(0);

      mockPrisma.projectGroup.findMany.mockResolvedValue([]);
      mockPrisma.projectGroup.count.mockResolvedValue(0);

      const result = await search({
        query: "test",
        companyUuid,
        scope: "project",
        scopeUuid: projectUuid,
      });

      expect(result.results).toHaveLength(1);
      expect(result.results[0].projectUuid).toBe(projectUuid);

      // Verify task query included projectUuid filter
      expect(mockPrisma.task.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            projectUuid: { in: [projectUuid] },
          }),
        })
      );
    });
  });

  describe("group scope", () => {
    it("should resolve project UUIDs and filter results", async () => {
      const now = new Date();
      const companyUuid = "company-1";
      const groupUuid = "group-1";

      // Mock project resolution
      mockPrisma.project.findMany.mockResolvedValueOnce([
        { uuid: "project-1" },
        { uuid: "project-2" },
      ]);

      // Mock task search
      mockPrisma.task.findMany.mockResolvedValue([
        {
          uuid: "task-1",
          title: "Test task",
          description: "Description",
          status: "open",
          projectUuid: "project-1",
          updatedAt: now,
          project: { name: "Project A" },
        },
      ]);
      mockPrisma.task.count.mockResolvedValue(1);

      // Mock other empty searches
      mockPrisma.idea.findMany.mockResolvedValue([]);
      mockPrisma.idea.count.mockResolvedValue(0);

      mockPrisma.proposal.findMany.mockResolvedValue([]);
      mockPrisma.proposal.count.mockResolvedValue(0);

      mockPrisma.document.findMany.mockResolvedValue([]);
      mockPrisma.document.count.mockResolvedValue(0);

      // Second call to project.findMany for project search (not resolution)
      mockPrisma.project.findMany.mockResolvedValueOnce([]);
      mockPrisma.project.count.mockResolvedValue(0);

      mockPrisma.projectGroup.findMany.mockResolvedValue([]);
      mockPrisma.projectGroup.count.mockResolvedValue(0);

      const result = await search({
        query: "test",
        companyUuid,
        scope: "group",
        scopeUuid: groupUuid,
      });

      expect(result.results).toHaveLength(1);

      // Verify project resolution was called
      expect(mockPrisma.project.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { companyUuid, groupUuid },
          select: { uuid: true },
        })
      );

      // Verify task query included resolved project UUIDs
      expect(mockPrisma.task.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            projectUuid: { in: ["project-1", "project-2"] },
          }),
        })
      );
    });
  });

  describe("results sorting", () => {
    it("should sort results by updatedAt desc", async () => {
      const companyUuid = "company-1";
      const date1 = new Date("2024-01-01");
      const date2 = new Date("2024-01-02");
      const date3 = new Date("2024-01-03");

      mockPrisma.task.findMany.mockResolvedValue([
        {
          uuid: "task-1",
          title: "Oldest task",
          description: "Description",
          status: "open",
          projectUuid: "project-1",
          updatedAt: date1,
          project: { name: "Project A" },
        },
      ]);
      mockPrisma.task.count.mockResolvedValue(1);

      mockPrisma.idea.findMany.mockResolvedValue([
        {
          uuid: "idea-1",
          title: "Newest idea",
          content: "Content",
          status: "open",
          projectUuid: "project-1",
          updatedAt: date3,
          project: { name: "Project A" },
        },
      ]);
      mockPrisma.idea.count.mockResolvedValue(1);

      mockPrisma.proposal.findMany.mockResolvedValue([
        {
          uuid: "proposal-1",
          title: "Middle proposal",
          description: "Description",
          status: "draft",
          projectUuid: "project-1",
          updatedAt: date2,
          project: { name: "Project A" },
        },
      ]);
      mockPrisma.proposal.count.mockResolvedValue(1);

      mockPrisma.document.findMany.mockResolvedValue([]);
      mockPrisma.document.count.mockResolvedValue(0);

      mockPrisma.project.findMany.mockResolvedValue([]);
      mockPrisma.project.count.mockResolvedValue(0);

      mockPrisma.projectGroup.findMany.mockResolvedValue([]);
      mockPrisma.projectGroup.count.mockResolvedValue(0);

      const result = await search({
        query: "test",
        companyUuid,
        scope: "global",
        entityTypes: ["task", "idea", "proposal"],
      });

      expect(result.results).toHaveLength(3);
      expect(result.results[0].uuid).toBe("idea-1");  // Newest
      expect(result.results[1].uuid).toBe("proposal-1");  // Middle
      expect(result.results[2].uuid).toBe("task-1");  // Oldest
    });
  });

  describe("snippet generation", () => {
    // Helper to search a single task with given description
    const searchWithDescription = async (description: string, query: string) => {
      mockPrisma.task.findMany.mockResolvedValue([
        {
          uuid: "task-1",
          title: "Task title",
          description,
          status: "open",
          projectUuid: "project-1",
          updatedAt: new Date(),
          project: { name: "Project A" },
        },
      ]);
      mockPrisma.task.count.mockResolvedValue(1);
      mockPrisma.idea.findMany.mockResolvedValue([]);
      mockPrisma.idea.count.mockResolvedValue(0);
      mockPrisma.proposal.findMany.mockResolvedValue([]);
      mockPrisma.proposal.count.mockResolvedValue(0);
      mockPrisma.document.findMany.mockResolvedValue([]);
      mockPrisma.document.count.mockResolvedValue(0);
      mockPrisma.project.findMany.mockResolvedValue([]);
      mockPrisma.project.count.mockResolvedValue(0);
      mockPrisma.projectGroup.findMany.mockResolvedValue([]);
      mockPrisma.projectGroup.count.mockResolvedValue(0);

      const result = await search({
        query,
        companyUuid: "company-1",
        scope: "global",
        entityTypes: ["task"],
      });
      return result.results[0].snippet;
    };

    it("should generate snippet around match with ellipsis", async () => {
      const snippet = await searchWithDescription(
        "This is a long description with the keyword test appearing somewhere in the middle of the text to verify snippet extraction works correctly",
        "test"
      );
      expect(snippet).toContain("test");
      expect(snippet).toContain("...");
    });

    it("should adjust start to word boundary when match is in the middle", async () => {
      // Create text where match is far enough from start to trigger word-boundary adjustment (line 66-70)
      const longPrefix = "word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12 ";
      const text = longPrefix + "target keyword here and more text after it to make the string long enough for ellipsis";
      const snippet = await searchWithDescription(text, "target");
      expect(snippet).toContain("target");
      expect(snippet.startsWith("...")).toBe(true);
    });

    it("should return beginning of text when query not found in description", async () => {
      const snippet = await searchWithDescription(
        "A short description that does not contain the search term at all, just some filler text to make it longer than the max snippet length for testing",
        "nomatch"
      );
      // No match → returns beginning of text with ellipsis
      expect(snippet).toContain("A short description");
      expect(snippet.endsWith("...")).toBe(true);
    });

    it("should return full text without ellipsis when text is short", async () => {
      const snippet = await searchWithDescription("short text", "nomatch");
      expect(snippet).toBe("short text");
      expect(snippet).not.toContain("...");
    });

    it("should use title for snippet when description is empty", async () => {
      mockPrisma.task.findMany.mockResolvedValue([
        {
          uuid: "task-1",
          title: "Task with test in title",
          description: null,
          status: "open",
          projectUuid: "project-1",
          updatedAt: new Date(),
          project: { name: "Project A" },
        },
      ]);
      mockPrisma.task.count.mockResolvedValue(1);
      mockPrisma.idea.findMany.mockResolvedValue([]);
      mockPrisma.idea.count.mockResolvedValue(0);
      mockPrisma.proposal.findMany.mockResolvedValue([]);
      mockPrisma.proposal.count.mockResolvedValue(0);
      mockPrisma.document.findMany.mockResolvedValue([]);
      mockPrisma.document.count.mockResolvedValue(0);
      mockPrisma.project.findMany.mockResolvedValue([]);
      mockPrisma.project.count.mockResolvedValue(0);
      mockPrisma.projectGroup.findMany.mockResolvedValue([]);
      mockPrisma.projectGroup.count.mockResolvedValue(0);

      const result = await search({
        query: "test",
        companyUuid: "company-1",
        scope: "global",
        entityTypes: ["task"],
      });
      expect(result.results[0].snippet).toContain("test");
    });
  });


  describe("limit parameter", () => {
    it("should respect limit parameter for combined results", async () => {
      const companyUuid = "company-1";
      const now = new Date();

      // Create 15 tasks
      const tasks = Array.from({ length: 15 }, (_, i) => ({
        uuid: `task-${i}`,
        title: `Task ${i}`,
        description: "Description",
        status: "open",
        projectUuid: "project-1",
        updatedAt: now,
        project: { name: "Project A" },
      }));

      mockPrisma.task.findMany.mockResolvedValue(tasks);
      mockPrisma.task.count.mockResolvedValue(15);

      mockPrisma.idea.findMany.mockResolvedValue([]);
      mockPrisma.idea.count.mockResolvedValue(0);

      mockPrisma.proposal.findMany.mockResolvedValue([]);
      mockPrisma.proposal.count.mockResolvedValue(0);

      mockPrisma.document.findMany.mockResolvedValue([]);
      mockPrisma.document.count.mockResolvedValue(0);

      mockPrisma.project.findMany.mockResolvedValue([]);
      mockPrisma.project.count.mockResolvedValue(0);

      mockPrisma.projectGroup.findMany.mockResolvedValue([]);
      mockPrisma.projectGroup.count.mockResolvedValue(0);

      const result = await search({
        query: "test",
        companyUuid,
        scope: "global",
        limit: 10,
      });

      expect(result.results.length).toBeLessThanOrEqual(10);
      expect(result.counts.tasks).toBe(15);  // Count should reflect total, not limited
    });
  });

  describe("companyUuid scoping", () => {
    it("should include companyUuid in all queries", async () => {
      const companyUuid = "company-1";

      mockPrisma.task.findMany.mockResolvedValue([]);
      mockPrisma.task.count.mockResolvedValue(0);

      mockPrisma.idea.findMany.mockResolvedValue([]);
      mockPrisma.idea.count.mockResolvedValue(0);

      mockPrisma.proposal.findMany.mockResolvedValue([]);
      mockPrisma.proposal.count.mockResolvedValue(0);

      mockPrisma.document.findMany.mockResolvedValue([]);
      mockPrisma.document.count.mockResolvedValue(0);

      mockPrisma.project.findMany.mockResolvedValue([]);
      mockPrisma.project.count.mockResolvedValue(0);

      mockPrisma.projectGroup.findMany.mockResolvedValue([]);
      mockPrisma.projectGroup.count.mockResolvedValue(0);

      await search({
        query: "test",
        companyUuid,
        scope: "global",
      });

      // Verify all queries include companyUuid
      expect(mockPrisma.task.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ companyUuid }),
        })
      );

      expect(mockPrisma.idea.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ companyUuid }),
        })
      );

      expect(mockPrisma.proposal.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ companyUuid }),
        })
      );

      expect(mockPrisma.document.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ companyUuid }),
        })
      );

      expect(mockPrisma.project.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ companyUuid }),
        })
      );

      expect(mockPrisma.projectGroup.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ companyUuid }),
        })
      );
    });
  });

  describe("result structure", () => {
    it("should return correctly structured search results", async () => {
      const companyUuid = "company-1";
      const now = new Date();

      mockPrisma.task.findMany.mockResolvedValue([
        {
          uuid: "task-1",
          title: "Test task",
          description: "Description",
          status: "in_progress",
          projectUuid: "project-1",
          updatedAt: now,
          project: { name: "Project A" },
        },
      ]);
      mockPrisma.task.count.mockResolvedValue(1);

      mockPrisma.idea.findMany.mockResolvedValue([]);
      mockPrisma.idea.count.mockResolvedValue(0);

      mockPrisma.proposal.findMany.mockResolvedValue([]);
      mockPrisma.proposal.count.mockResolvedValue(0);

      mockPrisma.document.findMany.mockResolvedValue([]);
      mockPrisma.document.count.mockResolvedValue(0);

      mockPrisma.project.findMany.mockResolvedValue([]);
      mockPrisma.project.count.mockResolvedValue(0);

      mockPrisma.projectGroup.findMany.mockResolvedValue([]);
      mockPrisma.projectGroup.count.mockResolvedValue(0);

      const result = await search({
        query: "test",
        companyUuid,
        scope: "global",
        entityTypes: ["task"],
      });

      expect(result.results[0]).toMatchObject({
        entityType: "task",
        uuid: "task-1",
        title: "Test task",
        snippet: expect.any(String),
        status: "in_progress",
        projectUuid: "project-1",
        projectName: "Project A",
        updatedAt: expect.any(String),
      });
    });

    it("should return null projectUuid/projectName for project_group", async () => {
      const companyUuid = "company-1";
      const now = new Date();

      mockPrisma.task.findMany.mockResolvedValue([]);
      mockPrisma.task.count.mockResolvedValue(0);

      mockPrisma.idea.findMany.mockResolvedValue([]);
      mockPrisma.idea.count.mockResolvedValue(0);

      mockPrisma.proposal.findMany.mockResolvedValue([]);
      mockPrisma.proposal.count.mockResolvedValue(0);

      mockPrisma.document.findMany.mockResolvedValue([]);
      mockPrisma.document.count.mockResolvedValue(0);

      mockPrisma.project.findMany.mockResolvedValue([]);
      mockPrisma.project.count.mockResolvedValue(0);

      mockPrisma.projectGroup.findMany.mockResolvedValue([
        {
          uuid: "group-1",
          name: "Test group",
          description: "Description",
          updatedAt: now,
        },
      ]);
      mockPrisma.projectGroup.count.mockResolvedValue(1);

      const result = await search({
        query: "test",
        companyUuid,
        scope: "global",
        entityTypes: ["project_group"],
      });

      expect(result.results[0]).toMatchObject({
        entityType: "project_group",
        projectUuid: null,
        projectName: null,
      });
    });
  });

  describe("error handling", () => {
    it("should throw error if scopeUuid missing for project scope", async () => {
      const companyUuid = "company-1";

      await expect(
        search({
          query: "test",
          companyUuid,
          scope: "project",
          // scopeUuid missing
        })
      ).rejects.toThrow('scopeUuid is required for scope "project"');
    });

    it("should throw error if scopeUuid missing for group scope", async () => {
      const companyUuid = "company-1";

      await expect(
        search({
          query: "test",
          companyUuid,
          scope: "group",
          // scopeUuid missing
        })
      ).rejects.toThrow('scopeUuid is required for scope "group"');
    });
  });
});
