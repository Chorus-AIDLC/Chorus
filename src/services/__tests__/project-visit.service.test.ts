import { describe, it, expect, vi, beforeEach } from "vitest";

// ===== Prisma mock =====
const mockPrisma = vi.hoisted(() => ({
  project: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
  },
  projectGroup: {
    findMany: vi.fn(),
  },
  projectVisit: {
    upsert: vi.fn(),
    findUnique: vi.fn(),
    updateMany: vi.fn(),
    findMany: vi.fn(),
  },
}));
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));

import {
  recordVisit,
  pinProject,
  unpinProject,
  getSidebarQuickAccess,
} from "@/services/project-visit.service";

// ===== Constants =====
const companyUuid = "company-0000-0000-0000-000000000001";
const userUuid = "user-0000-0000-0000-000000000001";
const projectUuid = "project-0000-0000-0000-000000000001";

// Route projectVisit.findMany by its pinnedAt filter so pinned/recent queries
// resolve independently regardless of call order.
function stubQuickAccessQueries(pinnedVisits: unknown[], recentVisits: unknown[]) {
  mockPrisma.projectVisit.findMany.mockImplementation((args: { where: { pinnedAt: unknown } }) => {
    const p = args.where.pinnedAt;
    if (p === null) return Promise.resolve(recentVisits);
    return Promise.resolve(pinnedVisits); // { not: null }
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ===== recordVisit =====
describe("recordVisit", () => {
  it("upserts lastVisitedAt=now and leaves pinnedAt untouched when project is in company", async () => {
    mockPrisma.project.findFirst.mockResolvedValue({ uuid: projectUuid });
    mockPrisma.projectVisit.upsert.mockResolvedValue({});

    await recordVisit(companyUuid, userUuid, projectUuid);

    expect(mockPrisma.project.findFirst).toHaveBeenCalledWith({
      where: { uuid: projectUuid, companyUuid },
      select: { uuid: true },
    });
    expect(mockPrisma.projectVisit.upsert).toHaveBeenCalledTimes(1);
    const args = mockPrisma.projectVisit.upsert.mock.calls[0][0];
    expect(args.where).toEqual({ userUuid_projectUuid: { userUuid, projectUuid } });
    expect(args.update).toEqual({ lastVisitedAt: expect.any(Date) });
    // create path must NOT set pinnedAt (defaults to null)
    expect(args.create).toEqual({
      companyUuid,
      userUuid,
      projectUuid,
      lastVisitedAt: expect.any(Date),
    });
    expect(args.create.pinnedAt).toBeUndefined();
  });

  it("does nothing when the project is not in the caller's company (forged/foreign UUID)", async () => {
    mockPrisma.project.findFirst.mockResolvedValue(null);

    await recordVisit(companyUuid, userUuid, "foreign-project");

    expect(mockPrisma.projectVisit.upsert).not.toHaveBeenCalled();
  });
});

// ===== pinProject =====
describe("pinProject", () => {
  it("does nothing when the project is not in the caller's company", async () => {
    mockPrisma.project.findFirst.mockResolvedValue(null);

    await pinProject(companyUuid, userUuid, "foreign-project");

    expect(mockPrisma.projectVisit.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.projectVisit.upsert).not.toHaveBeenCalled();
  });

  it("pins a never-visited project (no existing row) with pinnedAt + lastVisitedAt on create", async () => {
    mockPrisma.project.findFirst.mockResolvedValue({ uuid: projectUuid });
    mockPrisma.projectVisit.findUnique.mockResolvedValue(null);
    mockPrisma.projectVisit.upsert.mockResolvedValue({});

    await pinProject(companyUuid, userUuid, projectUuid);

    const args = mockPrisma.projectVisit.upsert.mock.calls[0][0];
    expect(args.where).toEqual({ userUuid_projectUuid: { userUuid, projectUuid } });
    expect(args.update).toEqual({ pinnedAt: expect.any(Date) });
    expect(args.create).toEqual({
      companyUuid,
      userUuid,
      projectUuid,
      pinnedAt: expect.any(Date),
      lastVisitedAt: expect.any(Date),
    });
  });

  it("pins an existing unpinned row (pinnedAt null) by updating pinnedAt", async () => {
    mockPrisma.project.findFirst.mockResolvedValue({ uuid: projectUuid });
    mockPrisma.projectVisit.findUnique.mockResolvedValue({ pinnedAt: null });
    mockPrisma.projectVisit.upsert.mockResolvedValue({});

    await pinProject(companyUuid, userUuid, projectUuid);

    expect(mockPrisma.projectVisit.upsert).toHaveBeenCalledTimes(1);
    expect(mockPrisma.projectVisit.upsert.mock.calls[0][0].update).toEqual({
      pinnedAt: expect.any(Date),
    });
  });

  it("is idempotent: re-pinning an already-pinned project does NOT move pinnedAt", async () => {
    mockPrisma.project.findFirst.mockResolvedValue({ uuid: projectUuid });
    mockPrisma.projectVisit.findUnique.mockResolvedValue({
      pinnedAt: new Date("2026-01-01T00:00:00Z"),
    });

    await pinProject(companyUuid, userUuid, projectUuid);

    expect(mockPrisma.projectVisit.upsert).not.toHaveBeenCalled();
  });
});

// ===== unpinProject =====
describe("unpinProject", () => {
  it("clears pinnedAt scoped by company + user + project", async () => {
    mockPrisma.projectVisit.updateMany.mockResolvedValue({ count: 1 });

    await unpinProject(companyUuid, userUuid, projectUuid);

    expect(mockPrisma.projectVisit.updateMany).toHaveBeenCalledWith({
      where: { companyUuid, userUuid, projectUuid },
      data: { pinnedAt: null },
    });
  });

  it("is idempotent / no-op-safe when no row matches (updates zero rows)", async () => {
    mockPrisma.projectVisit.updateMany.mockResolvedValue({ count: 0 });

    await expect(unpinProject(companyUuid, userUuid, projectUuid)).resolves.toBeUndefined();
    expect(mockPrisma.projectVisit.updateMany).toHaveBeenCalledTimes(1);
  });
});

// ===== getSidebarQuickAccess =====
describe("getSidebarQuickAccess", () => {
  it("returns pinned (pinnedAt ASC) and recent (lastVisitedAt DESC) with correct where clauses; pinned never appears in recent", async () => {
    const pinnedU = "proj-pinned";
    const recentU = "proj-recent";
    stubQuickAccessQueries(
      [{ projectUuid: pinnedU }],
      [{ projectUuid: recentU }]
    );
    mockPrisma.project.findMany.mockResolvedValue([
      { uuid: pinnedU, name: "Pinned Project", groupUuid: "group-1" },
      { uuid: recentU, name: "Recent Project", groupUuid: null },
    ]);
    mockPrisma.projectGroup.findMany.mockResolvedValue([{ uuid: "group-1", name: "Alpha Group" }]);

    const result = await getSidebarQuickAccess(companyUuid, userUuid);

    expect(result.pinned).toEqual([
      { uuid: pinnedU, name: "Pinned Project", groupUuid: "group-1", groupName: "Alpha Group" },
    ]);
    // ungrouped project → groupName null
    expect(result.recent).toEqual([
      { uuid: recentU, name: "Recent Project", groupUuid: null, groupName: null },
    ]);
    // dedupe: pinned uuid must not be in recent
    const recentUuids = result.recent.map((r) => r.uuid);
    expect(recentUuids).not.toContain(pinnedU);

    // Verify query filters: pinned uses pinnedAt not-null + ASC; recent uses null + DESC + no take
    const calls = mockPrisma.projectVisit.findMany.mock.calls.map((c) => c[0]);
    const pinnedCall = calls.find((c) => c.where.pinnedAt !== null);
    const recentCall = calls.find((c) => c.where.pinnedAt === null);
    expect(pinnedCall).toMatchObject({
      where: { companyUuid, userUuid, pinnedAt: { not: null } },
      orderBy: { pinnedAt: "asc" },
    });
    expect(recentCall).toMatchObject({
      where: { companyUuid, userUuid, pinnedAt: null },
      orderBy: { lastVisitedAt: "desc" },
    });
    expect(recentCall).not.toHaveProperty("take");
  });

  it("filter-then-cap: a stale/deleted newest project does NOT consume a recent slot, so 5 live remain visible", async () => {
    // Newest recent visit points to a deleted project; six more live non-pinned visits follow.
    const recentVisits = [
      { projectUuid: "deleted-newest" }, // stale — must be dropped, not counted
      { projectUuid: "live-1" },
      { projectUuid: "live-2" },
      { projectUuid: "live-3" },
      { projectUuid: "live-4" },
      { projectUuid: "live-5" },
      { projectUuid: "live-6" }, // beyond cap → dropped by the break, not by staleness
    ];
    stubQuickAccessQueries([], recentVisits);
    // "deleted-newest" is intentionally absent from the live project set.
    mockPrisma.project.findMany.mockResolvedValue(
      ["live-1", "live-2", "live-3", "live-4", "live-5", "live-6"].map((u) => ({
        uuid: u,
        name: u.toUpperCase(),
        groupUuid: null,
      }))
    );
    mockPrisma.projectGroup.findMany.mockResolvedValue([]);

    const result = await getSidebarQuickAccess(companyUuid, userUuid);

    expect(result.recent).toHaveLength(5);
    expect(result.recent.map((r) => r.uuid)).toEqual(["live-1", "live-2", "live-3", "live-4", "live-5"]);
    // the stale newest never appears and did not push the count below 5
    expect(result.recent.map((r) => r.uuid)).not.toContain("deleted-newest");
  });

  it("drops a stale/foreign pinned project from the aggregate", async () => {
    stubQuickAccessQueries(
      [{ projectUuid: "live-pinned" }, { projectUuid: "gone-pinned" }],
      []
    );
    // only live-pinned resolves; gone-pinned (deleted or another company) is absent
    mockPrisma.project.findMany.mockResolvedValue([
      { uuid: "live-pinned", name: "Live Pinned", groupUuid: null },
    ]);
    mockPrisma.projectGroup.findMany.mockResolvedValue([]);

    const result = await getSidebarQuickAccess(companyUuid, userUuid);

    expect(result.pinned).toEqual([
      { uuid: "live-pinned", name: "Live Pinned", groupUuid: null, groupName: null },
    ]);
    expect(result.pinned.map((p) => p.uuid)).not.toContain("gone-pinned");
    expect(result.recent).toEqual([]);
  });

  it("resolves groupName null when the project's group is missing (dangling groupUuid)", async () => {
    stubQuickAccessQueries([], [{ projectUuid: "proj-1" }]);
    mockPrisma.project.findMany.mockResolvedValue([
      { uuid: "proj-1", name: "Project One", groupUuid: "dangling-group" },
    ]);
    // group lookup returns nothing → groupName should fall back to null
    mockPrisma.projectGroup.findMany.mockResolvedValue([]);

    const result = await getSidebarQuickAccess(companyUuid, userUuid);

    expect(result.recent).toEqual([
      { uuid: "proj-1", name: "Project One", groupUuid: "dangling-group", groupName: null },
    ]);
  });

  it("unpinned project (pinnedAt null) is eligible for recent", async () => {
    // After an unpin the row has pinnedAt=null, so it comes back via the recent query.
    stubQuickAccessQueries([], [{ projectUuid: "was-pinned" }]);
    mockPrisma.project.findMany.mockResolvedValue([
      { uuid: "was-pinned", name: "Formerly Pinned", groupUuid: null },
    ]);
    mockPrisma.projectGroup.findMany.mockResolvedValue([]);

    const result = await getSidebarQuickAccess(companyUuid, userUuid);

    expect(result.pinned).toEqual([]);
    expect(result.recent.map((r) => r.uuid)).toEqual(["was-pinned"]);
  });

  it("returns empty lists when the user has no visits", async () => {
    stubQuickAccessQueries([], []);
    mockPrisma.project.findMany.mockResolvedValue([]);
    mockPrisma.projectGroup.findMany.mockResolvedValue([]);

    const result = await getSidebarQuickAccess(companyUuid, userUuid);

    expect(result).toEqual({ pinned: [], recent: [] });
    // group lookup should be scoped and receive an empty uuid set
    expect(mockPrisma.projectGroup.findMany).toHaveBeenCalledWith({
      where: { companyUuid, uuid: { in: [] } },
      select: { uuid: true, name: true },
    });
  });
});
