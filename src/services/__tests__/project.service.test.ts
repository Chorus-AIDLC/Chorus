import { describe, it, expect, vi, beforeEach } from "vitest";

// ===== Prisma mock =====
const mockPrisma = vi.hoisted(() => ({
  project: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    count: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  task: {
    count: vi.fn(),
    groupBy: vi.fn(),
  },
  proposal: {
    count: vi.fn(),
    groupBy: vi.fn(),
  },
  idea: {
    count: vi.fn(),
    groupBy: vi.fn(),
  },
  document: {
    count: vi.fn(),
  },
}));
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));

import {
  listProjects,
  getProject,
  createProject,
  updateProject,
  deleteProject,
  projectExists,
  getProjectByUuid,
  getCompanyOverviewStats,
  getProjectStats,
  listProjectsWithStats,
} from "@/services/project.service";

// ===== Helpers =====
const now = new Date("2026-03-13T00:00:00Z");
const companyUuid = "company-0000-0000-0000-000000000001";
const projectUuid = "project-0000-0000-0000-000000000001";

function makeProject(overrides: Record<string, unknown> = {}) {
  return {
    uuid: projectUuid,
    name: "Test Project",
    description: "A test project",
    groupUuid: null,
    createdAt: now,
    updatedAt: now,
    _count: { ideas: 5, documents: 3, tasks: 10, proposals: 2 },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ===== listProjects =====
describe("listProjects", () => {
  it("should return paginated projects with counts", async () => {
    const project = makeProject();
    mockPrisma.project.findMany.mockResolvedValue([project]);
    mockPrisma.project.count.mockResolvedValue(1);

    const result = await listProjects({ companyUuid, skip: 0, take: 20 });

    expect(result.projects).toHaveLength(1);
    expect(result.total).toBe(1);
    expect(result.projects[0].uuid).toBe(projectUuid);
    expect(result.projects[0]._count.tasks).toBe(10);
  });

  it("should pass skip and take to prisma", async () => {
    mockPrisma.project.findMany.mockResolvedValue([]);
    mockPrisma.project.count.mockResolvedValue(0);

    await listProjects({ companyUuid, skip: 10, take: 5 });

    expect(mockPrisma.project.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 10, take: 5 })
    );
  });
});

// ===== getProject =====
describe("getProject", () => {
  it("should return project with activity count", async () => {
    const project = makeProject({ _count: { ideas: 5, documents: 3, tasks: 10, proposals: 2, activities: 100 } });
    mockPrisma.project.findFirst.mockResolvedValue(project);

    const result = await getProject(companyUuid, projectUuid);

    expect(result).not.toBeNull();
    expect(result!.uuid).toBe(projectUuid);
    expect(result!._count.activities).toBe(100);
  });

  it("should return null when project not found", async () => {
    mockPrisma.project.findFirst.mockResolvedValue(null);

    const result = await getProject(companyUuid, "nonexistent");
    expect(result).toBeNull();
  });
});

// ===== createProject =====
describe("createProject", () => {
  it("should create project and return it", async () => {
    const project = makeProject();
    mockPrisma.project.create.mockResolvedValue(project);

    const result = await createProject({
      companyUuid,
      name: "Test Project",
      description: "A test project",
    });

    expect(result.uuid).toBe(projectUuid);
    expect(result.name).toBe("Test Project");
    expect(mockPrisma.project.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          companyUuid,
          name: "Test Project",
          groupUuid: null,
        }),
      })
    );
  });

  it("should pass groupUuid when provided", async () => {
    const groupUuid = "group-0000-0000-0000-000000000001";
    mockPrisma.project.create.mockResolvedValue(makeProject({ groupUuid }));

    await createProject({
      companyUuid,
      name: "Grouped Project",
      groupUuid,
    });

    expect(mockPrisma.project.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ groupUuid }),
      })
    );
  });
});

// ===== updateProject =====
describe("updateProject", () => {
  it("should update project fields", async () => {
    const updated = makeProject({ name: "Updated Name" });
    mockPrisma.project.update.mockResolvedValue(updated);

    const result = await updateProject(projectUuid, { name: "Updated Name" });

    expect(result.name).toBe("Updated Name");
    expect(mockPrisma.project.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { uuid: projectUuid },
        data: { name: "Updated Name" },
      })
    );
  });
});

// ===== deleteProject =====
describe("deleteProject", () => {
  it("should delete project by uuid", async () => {
    mockPrisma.project.delete.mockResolvedValue(makeProject());

    await deleteProject(projectUuid);

    expect(mockPrisma.project.delete).toHaveBeenCalledWith({
      where: { uuid: projectUuid },
    });
  });
});

// ===== projectExists =====
describe("projectExists", () => {
  it("should return true when project exists", async () => {
    mockPrisma.project.findFirst.mockResolvedValue({ uuid: projectUuid });

    const result = await projectExists(companyUuid, projectUuid);
    expect(result).toBe(true);
  });

  it("should return false when project does not exist", async () => {
    mockPrisma.project.findFirst.mockResolvedValue(null);

    const result = await projectExists(companyUuid, "missing");
    expect(result).toBe(false);
  });
});

// ===== getProjectByUuid =====
describe("getProjectByUuid", () => {
  it("should return basic project info", async () => {
    mockPrisma.project.findFirst.mockResolvedValue({
      uuid: projectUuid,
      name: "Test Project",
    });

    const result = await getProjectByUuid(companyUuid, projectUuid);

    expect(result).toEqual({
      uuid: projectUuid,
      name: "Test Project",
    });
    expect(mockPrisma.project.findFirst).toHaveBeenCalledWith({
      where: { uuid: projectUuid, companyUuid },
      select: { uuid: true, name: true },
    });
  });

  it("should return null when project not found", async () => {
    mockPrisma.project.findFirst.mockResolvedValue(null);

    const result = await getProjectByUuid(companyUuid, "nonexistent");
    expect(result).toBeNull();
  });
});

// ===== getCompanyOverviewStats =====
describe("getCompanyOverviewStats", () => {
  it("should return aggregated company stats", async () => {
    mockPrisma.project.count.mockResolvedValue(3);
    mockPrisma.task.count.mockResolvedValue(25);
    mockPrisma.proposal.count.mockResolvedValue(2);
    mockPrisma.idea.count.mockResolvedValue(10);

    const result = await getCompanyOverviewStats(companyUuid);

    expect(result).toEqual({
      projects: 3,
      tasks: 25,
      openProposals: 2,
      ideas: 10,
    });
  });
});

// ===== getProjectStats =====
describe("getProjectStats", () => {
  it("should return per-project stats grouped by status", async () => {
    mockPrisma.idea.groupBy.mockResolvedValue([
      { status: "open", _count: 5 },
      { status: "claimed", _count: 3 },
    ]);
    mockPrisma.task.groupBy.mockResolvedValue([
      { status: "open", _count: 2 },
      { status: "assigned", _count: 1 },
      { status: "in_progress", _count: 4 },
      { status: "to_verify", _count: 2 },
      { status: "done", _count: 6 },
      { status: "closed", _count: 1 },
    ]);
    mockPrisma.proposal.groupBy.mockResolvedValue([
      { status: "pending", _count: 2 },
      { status: "approved", _count: 5 },
    ]);
    mockPrisma.document.count.mockResolvedValue(8);

    const result = await getProjectStats(companyUuid, projectUuid);

    expect(result.ideas).toEqual({ total: 8, open: 5 });
    expect(result.tasks).toEqual({ total: 16, inProgress: 4, todo: 3, toVerify: 2, done: 7 });
    expect(result.proposals).toEqual({ total: 7, pending: 2 });
    expect(result.documents).toEqual({ total: 8 });
  });
});

// ===== listProjectsWithStats =====
describe("listProjectsWithStats", () => {
  it("should return projects with task completion stats", async () => {
    const project1 = makeProject({ uuid: "project-0000-0000-0000-000000000001" });
    const project2 = makeProject({ uuid: "project-0000-0000-0000-000000000002" });

    mockPrisma.project.findMany.mockResolvedValue([project1, project2]);
    mockPrisma.project.count.mockResolvedValue(2);
    mockPrisma.task.groupBy.mockResolvedValue([
      { projectUuid: "project-0000-0000-0000-000000000001", _count: 5 },
      { projectUuid: "project-0000-0000-0000-000000000002", _count: 3 },
    ]);

    const result = await listProjectsWithStats({ companyUuid, skip: 0, take: 20 });

    expect(result.projects).toHaveLength(2);
    expect(result.total).toBe(2);
    expect(result.projects[0].tasksDone).toBe(5);
    expect(result.projects[1].tasksDone).toBe(3);
    expect(mockPrisma.task.groupBy).toHaveBeenCalledWith({
      by: ["projectUuid"],
      where: {
        companyUuid,
        projectUuid: { in: [project1.uuid, project2.uuid] },
        status: "done",
      },
      _count: true,
    });
  });

  it("should handle projects with no completed tasks", async () => {
    const project = makeProject();
    mockPrisma.project.findMany.mockResolvedValue([project]);
    mockPrisma.project.count.mockResolvedValue(1);
    mockPrisma.task.groupBy.mockResolvedValue([]);

    const result = await listProjectsWithStats({ companyUuid, skip: 0, take: 20 });

    expect(result.projects[0].tasksDone).toBe(0);
  });
});
