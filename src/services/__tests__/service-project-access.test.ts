import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthContext } from "@/types/auth";

const { mockPrisma, notifications } = vi.hoisted(() => {
  const delegate = () => ({
    findMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(),
    count: vi.fn(), groupBy: vi.fn(), upsert: vi.fn(), update: vi.fn(),
  });
  return {
    mockPrisma: {
      project: delegate(), projectMember: delegate(), projectGroup: delegate(), projectGroupMember: delegate(),
      projectVisit: delegate(), idea: delegate(), task: delegate(),
      proposal: delegate(), document: delegate(), activity: delegate(),
      agent: delegate(), agentInstance: delegate(),
    },
    notifications: { list: vi.fn(), markRead: vi.fn(), emitAgentCheckin: vi.fn() },
  };
});
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/event-bus", () => ({ eventBus: { emitChange: vi.fn() } }));
vi.mock("@/services/activity.service", () => ({ createActivityInTx: vi.fn() }));
vi.mock("@/services/notification.service", () => notifications);
vi.mock("@/lib/uuid-resolver", async (importActual) => ({
  ...await importActual<typeof import("@/lib/uuid-resolver")>(),
  formatCreatedBy: vi.fn(async () => ({ type: "user", uuid: "member", name: "Member" })),
}));

import { getCompanyOverviewStats, listProjects, listProjectsWithStats } from "@/services/project.service";
import { getGroupDashboard, getProjectGroup, listProjectGroups } from "@/services/project-group.service";
import { getSidebarQuickAccess, pinProject, recordVisit } from "@/services/project-visit.service";
import { search } from "@/services/search.service";
import { buildActiveProjectDistribution, buildIdeaTracker, buildTaskTracker } from "@/services/idea-tracker.service";
import { getAvailableItems, getMyAssignments } from "@/services/assignment.service";
import { buildCheckinResponse } from "@/services/checkin.service";

// A small in-memory Prisma fixture evaluates actual predicates, ordering and
// pagination. Access helpers are real: membership, visibility and company
// isolation must all be reflected in returned data, not just in query shapes.
type Row = Record<string, unknown>;
type Where = Record<string, unknown>;
type Model = keyof typeof mockPrisma;
let db: Record<Model, Row[]>;
const COMPANY = "company";
const GROUP = "group";
const PRIVATE_GROUP = "private-group";
const EMPTY_GROUP = "empty-group";
const now = new Date("2026-10-01T00:00:00Z");
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const PUBLIC = uuid(1);
const PRIVATE = uuid(2);
const PUBLIC_UNGROUPED = uuid(3);
const PRIVATE_UNGROUPED = uuid(4);
const PRIVATE_ONLY = uuid(5);
const FOREIGN = uuid(6);
const publicProjects = [PUBLIC, PUBLIC_UNGROUPED];
const privateProjects = [PRIVATE, PRIVATE_UNGROUPED, PRIVATE_ONLY];
const member: AuthContext = { type: "user", actorUuid: "member", companyUuid: COMPANY };
const outsider: AuthContext = { type: "user", actorUuid: "outsider", companyUuid: COMPANY };
const agent = (ownerUuid?: string): AuthContext => ({
  type: "agent", actorUuid: "worker", companyUuid: COMPANY, ownerUuid, roles: ["developer"],
});

function fieldMatches(value: unknown, filter: unknown): boolean {
  if (filter === null || typeof filter !== "object" || filter instanceof Date) return value === filter;
  const f = filter as Where;
  return Object.entries(f).every(([op, expected]) => {
    switch (op) {
      case "in": return (expected as unknown[]).includes(value);
      case "notIn": return !(expected as unknown[]).includes(value);
      case "not": return !fieldMatches(value, expected);
      case "contains": return typeof value === "string" &&
        value.toLowerCase().includes(String(expected).toLowerCase());
      case "mode": return true;
      case "equals": return value === expected;
      default: throw new Error(`Fixture does not implement filter ${op}`);
    }
  });
}

function matches(row: Row, where: Where = {}): boolean {
  return Object.entries(where).every(([key, filter]) => {
    if (key === "OR") return (filter as Where[]).some((w) => matches(row, w));
    if (key === "AND") return (Array.isArray(filter) ? filter : [filter]).every((w) => matches(row, w as Where));
    if (key === "NOT") return !matches(row, filter as Where);
    if (key === "group") {
      const group = db.projectGroup.find((g) => g.uuid === row.groupUuid);
      return !!group && matches(group, filter as Where);
    }
    if (key === "members") {
      const some = (filter as Where).some as Where;
      return db.projectGroupMember.some((m) => m.groupUuid === row.uuid && matches(m, some));
    }
    if (key === "projects") {
      const some = (filter as Where).some as Where;
      return db.project.some((project) => project.groupUuid === row.uuid && matches(project, some));
    }
    return fieldMatches(row[key], filter);
  });
}

function selected(row: Row, select?: Row): Row {
  if (!select) return { ...row };
  return Object.fromEntries(Object.keys(select).map((key) => [key, row[key]]));
}

interface Query {
  where?: Where;
  select?: Row;
  orderBy?: Row | Row[];
  take?: number;
  skip?: number;
}

function read(model: Model, args: Query = {}): Row[] {
  let rows = db[model].filter((r) => matches(r, args.where));
  const order = args.orderBy ? (Array.isArray(args.orderBy) ? args.orderBy : [args.orderBy]) : [];
  rows = [...rows].sort((a, b) => {
    for (const sort of order) {
      const [key, direction] = Object.entries(sort)[0];
      const av = a[key] instanceof Date ? (a[key] as Date).getTime() : String(a[key]);
      const bv = b[key] instanceof Date ? (b[key] as Date).getTime() : String(b[key]);
      const comparison = av < bv ? -1 : av > bv ? 1 : 0;
      if (comparison) return direction === "desc" ? -comparison : comparison;
    }
    return 0;
  });
  rows = rows.slice(args.skip ?? 0, args.take === undefined ? undefined : (args.skip ?? 0) + args.take);
  return rows.map((r) => selected(r, args.select));
}

function addProject(n: number, visibility: string, groupUuid: string | null, companyUuid = COMPANY) {
  const projectUuid = uuid(n);
  const project = {
    uuid: projectUuid, companyUuid, name: `Access project ${n}`, description: "Access project",
    visibility, groupUuid, createdAt: now, updatedAt: new Date(now.getTime() + n),
    _count: { tasks: 2, ideas: 1, proposals: 1, documents: 1 },
  };
  db.project.push(project);
  const common = {
    companyUuid, projectUuid, project, title: `Access entity ${n}`, description: "Access entity",
    content: "Access entity", status: "open", createdAt: now,
    updatedAt: new Date(now.getTime() + n), createdByUuid: "member",
    assigneeType: "agent", assigneeUuid: "worker",
  };
  db.idea.push({
    ...common, uuid: uuid(100 + n), parentUuid: null, isContainer: false, elaborationStatus: null,
  });
  db.task.push({
    ...common, uuid: uuid(200 + n), priority: "high", assignedAt: now,
    acceptanceCriteriaItems: [{ status: "passed" }, { status: "pending" }],
  }, {
    ...common, uuid: uuid(300 + n), status: "done", priority: "high",
    assignedAt: now, acceptanceCriteriaItems: [],
  });
  db.proposal.push({
    ...common, uuid: uuid(400 + n), status: "pending",
    inputType: "idea", inputUuids: [uuid(100 + n)],
  });
  db.document.push({ ...common, uuid: uuid(500 + n), type: "prd" });
  db.activity.push({
    ...common, uuid: uuid(600 + n), targetType: "task", targetUuid: uuid(200 + n),
    action: "created", actorType: "agent", actorUuid: "worker", value: null,
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  db = {
    project: [], projectMember: [], projectGroup: [], projectGroupMember: [], projectVisit: [],
    idea: [], task: [], proposal: [], document: [], activity: [],
    agent: [], agentInstance: [],
  };
  addProject(1, "public", GROUP);
  addProject(2, "private", GROUP);
  addProject(3, "public", null);
  addProject(4, "private", null);
  addProject(5, "private", PRIVATE_GROUP);
  addProject(6, "public", GROUP, "foreign-company");
  db.projectGroup.push(...[GROUP, PRIVATE_GROUP, EMPTY_GROUP].map((groupUuid) => ({
    uuid: groupUuid, companyUuid: COMPANY, name: `Access ${groupUuid}`,
    description: "Access group", createdAt: now, updatedAt: now,
    visibility: "public", createdByUuid: null, accessVersion: 0,
  })));
  db.projectMember.push(...privateProjects.map((projectUuid) => ({
    companyUuid: COMPANY, projectUuid, userUuid: "member", role: "viewer",
  })));
  for (const [model, delegate] of Object.entries(mockPrisma) as [Model, typeof mockPrisma.project][]) {
    delegate.findMany.mockImplementation(async (args: Query) => read(model, args));
    delegate.findFirst.mockImplementation(async (args: Query) => read(model, { ...args, take: 1 })[0] ?? null);
    delegate.count.mockImplementation(async (args: Query) => read(model, args).length);
    delegate.groupBy.mockImplementation(async (args: Query & { by: string[]; _count: unknown }) => {
      const counts = new Map<unknown, number>();
      const key = args.by[0];
      for (const row of read(model, args)) counts.set(row[key], (counts.get(row[key]) ?? 0) + 1);
      return [...counts].map(([value, count]) => ({
        [key]: value, _count: args._count === true ? count : { _all: count },
      }));
    });
  }
  mockPrisma.projectVisit.findUnique.mockResolvedValue(null);
  mockPrisma.projectVisit.upsert.mockResolvedValue({});
  mockPrisma.agent.update.mockResolvedValue({
    uuid: "worker", name: "Worker", roles: ["developer"], permissions: [],
    ownerUuid: "member", owner: { uuid: "member", name: "Member", email: null },
    persona: null, systemPrompt: null,
  });
  notifications.list.mockResolvedValue({ notifications: [], total: 0, unreadCount: 0 });
});

describe("project listings, groups and aggregates with real access resolution", () => {
  it.each([
    ["nonmember", outsider, publicProjects],
    ["member", member, [...publicProjects, ...privateProjects]],
    ["owner's agent", agent("member"), [...publicProjects, ...privateProjects]],
    ["ownerless agent", agent(), publicProjects],
    ["omitted auth", undefined, publicProjects],
  ])("%s sees only accessible projects and their entity totals", async (_name, auth, expected) => {
    const listing = await listProjects({ companyUuid: COMPANY, skip: 0, take: 50, auth });
    expect(listing.projects.map((p) => p.uuid).sort()).toEqual([...expected].sort());
    expect(listing.total).toBe(expected.length);
    const stats = await listProjectsWithStats({ companyUuid: COMPANY, skip: 0, take: 50, auth });
    expect(stats.projects.map((p) => p.uuid)).toEqual(listing.projects.map((p) => p.uuid));
    expect(stats.projects.every((p) => p.tasksDone === 1)).toBe(true);
    expect(await getCompanyOverviewStats(COMPANY, auth)).toEqual({
      projects: expected.length, tasks: expected.length * 2,
      ideas: expected.length, openProposals: expected.length,
    });
  });

  it.each([[outsider, 1], [member, 2], [undefined, 1]])(
    "filters group counts, dashboard entities and recent activity (%j)", async (auth, count) => {
      const groups = await listProjectGroups(COMPANY, auth);
      expect(groups.total).toBe(3);
      expect(groups.ungroupedCount).toBe(count);
      expect(groups.groups.find((g) => g.uuid === GROUP)?.projectCount).toBe(count);
      expect(groups.groups.find((g) => g.uuid === EMPTY_GROUP)?.projectCount).toBe(0);
      const detail = await getProjectGroup(COMPANY, GROUP, auth);
      expect(detail?.projectCount).toBe(count);
      const dashboard = await getGroupDashboard(COMPANY, GROUP, auth);
      expect(dashboard?.stats).toEqual({
        projectCount: count, totalTasks: count * 2, completedTasks: count,
        completionRate: 50, openIdeas: count, activeProposals: count,
      });
      expect(dashboard?.recentActivity).toHaveLength(count);
      expect(dashboard?.recentActivity.map((a) => a.projectUuid).sort())
        .toEqual(detail?.projects.map((p) => p.uuid).sort());
    },
  );

  it("preserves empty and private-only group metadata with zero visible contents", async () => {
    for (const groupUuid of [EMPTY_GROUP, PRIVATE_GROUP]) {
      const detail = await getProjectGroup(COMPANY, groupUuid, outsider);
      expect(detail).toMatchObject({ uuid: groupUuid, projectCount: 0, projects: [] });
      expect(await getGroupDashboard(COMPANY, groupUuid, outsider)).toMatchObject({
        group: { uuid: groupUuid }, stats: { projectCount: 0, totalTasks: 0 },
        projects: [], recentActivity: [],
      });
    }
  });

  it("filters before pagination", async () => {
    const result = await listProjects({ companyUuid: COMPANY, skip: 0, take: 1, auth: outsider });
    expect(result.total).toBe(2);
    expect(result.projects.map((p) => p.uuid)).toEqual([PUBLIC_UNGROUPED]);
  });

  it("keeps all public-project results after a company becomes public-only", async () => {
    db.project.filter((p) => p.companyUuid === COMPANY).forEach((p) => { p.visibility = "public"; });
    const listing = await listProjectsWithStats({ companyUuid: COMPANY, skip: 0, take: 50 });
    expect(listing.total).toBe(5);
    expect(await getCompanyOverviewStats(COMPANY)).toEqual({
      projects: 5, tasks: 10, openProposals: 5, ideas: 5,
    });
    const result = await search({ companyUuid: COMPANY, query: "Access", limit: 100 });
    expect(result.counts).toEqual({
      projects: 5, tasks: 10, ideas: 5, proposals: 5, documents: 5, projectGroups: 3,
    });
  });
});

describe("search access, filters and exact UUIDs", () => {
  it.each([[outsider, 2], [member, 5], [undefined, 2]])(
    "filters all text entity types and counts (%j)", async (auth, count) => {
      const result = await search({ companyUuid: COMPANY, query: "Access", auth, limit: 100 });
      expect(result.counts).toEqual({
        tasks: count * 2, ideas: count, proposals: count, documents: count,
        projects: count, projectGroups: 3,
      });
      expect(result.results.filter((r) => r.entityType === "project").map((r) => r.uuid))
        .not.toContain(FOREIGN);
      if (count === 2) {
        expect(result.results.filter((r) => r.projectUuid).every((r) => publicProjects.includes(r.projectUuid!))).toBe(true);
      }
    },
  );

  it.each([
    ["task", uuid(202)], ["idea", uuid(102)], ["proposal", uuid(402)],
    ["document", uuid(502)], ["project", PRIVATE],
  ])("hides a private %s even when searched by exact UUID", async (_type, targetUuid) => {
    expect((await search({ companyUuid: COMPANY, query: targetUuid, auth: outsider })).results).toEqual([]);
    const visible = await search({ companyUuid: COMPANY, query: targetUuid, auth: member });
    expect(visible.results.map((r) => r.uuid)).toEqual([targetUuid]);
  });

  it("returns an accessible exact UUID with the compact result", async () => {
    const result = await search({ companyUuid: COMPANY, query: uuid(201), auth: outsider });
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({ uuid: uuid(201), snippet: "", projectUuid: PUBLIC });
  });

  it.each([
    { projectUuids: [PRIVATE] },
    { projectUuids: [] },
    { scope: "project" as const, scopeUuid: PRIVATE },
    { auth: { ...agent("outsider"), projectUuids: [PRIVATE] } },
    { auth: { ...agent("member"), projectUuids: [] } },
  ])("cannot widen a hidden or empty project constraint: %j", async (constraint) => {
    const result = await search({
      companyUuid: COMPANY, query: "Access", auth: outsider, ...constraint, limit: 100,
    });
    expect(result.results).toEqual([]);
    expect(Object.values(result.counts).every((count) => count === 0)).toBe(true);
  });

  it("intersects caller, header and scope filters with accessible projects", async () => {
    const auth = { ...agent("outsider"), projectUuids: [PUBLIC, PRIVATE] };
    const result = await search({
      companyUuid: COMPANY, query: "Access", limit: 100,
      auth,
      projectUuids: [PUBLIC, PRIVATE, PUBLIC_UNGROUPED], scope: "group", scopeUuid: GROUP,
    });
    expect(result.counts.projects).toBe(1);
    expect(result.counts.tasks).toBe(2);
    expect(result.results.filter((r) => r.projectUuid).every((r) => r.projectUuid === PUBLIC)).toBe(true);
    expect(result.results.filter((r) => r.entityType === "project_group").map((r) => r.uuid)).toEqual([GROUP]);
  });

  it("preserves empty group hits for text and exact lookup and excludes groups from project scope", async () => {
    db.projectGroup.find((g) => g.uuid === EMPTY_GROUP)!.uuid = uuid(900);
    expect((await search({
      companyUuid: COMPANY, query: uuid(900), auth: outsider,
    })).results.map((r) => r.uuid)).toEqual([uuid(900)]);
    expect((await search({
      companyUuid: COMPANY, query: "Access", scope: "group", scopeUuid: PRIVATE_GROUP, auth: outsider,
    })).results.map((r) => r.uuid)).toEqual([PRIVATE_GROUP]);
    const scoped = await search({
      companyUuid: COMPANY, query: "Access", scope: "project", scopeUuid: PUBLIC, auth: outsider,
    });
    expect(scoped.counts.projectGroups).toBe(0);
  });

  it("preserves group metadata when there are no accessible projects", async () => {
    db.project.filter((p) => p.companyUuid === COMPANY).forEach((p) => { p.visibility = "private"; });
    const result = await search({ companyUuid: COMPANY, query: "Access", auth: outsider });
    expect(result.results.map((r) => r.entityType)).toEqual(["project_group", "project_group", "project_group"]);
    expect(result.counts.tasks).toBe(0);
    expect(result.counts.projects).toBe(0);
  });
});

describe("sidebar and visit writes", () => {
  it("drops hidden pins and recent visits before the five-entry cap", async () => {
    for (let n = 7; n <= 11; n++) addProject(n, "public", null);
    const liveRecent = [PUBLIC_UNGROUPED, ...[7, 8, 9, 10, 11].map(uuid)];
    for (const userUuid of ["member", "outsider"]) {
      db.projectVisit.push(...[PUBLIC, PRIVATE].map((projectUuid) => ({
        companyUuid: COMPANY, userUuid, projectUuid, pinnedAt: now, lastVisitedAt: now,
      })));
      db.projectVisit.push(...[PRIVATE_UNGROUPED, ...liveRecent].map((projectUuid, i) => ({
        companyUuid: COMPANY, userUuid, projectUuid, pinnedAt: null,
        lastVisitedAt: new Date(now.getTime() - i),
      })));
    }
    const hidden = await getSidebarQuickAccess(COMPANY, "outsider");
    expect(hidden.pinned.map((p) => p.uuid)).toEqual([PUBLIC]);
    expect(hidden.recent.map((p) => p.uuid)).toEqual(liveRecent.slice(0, 5));
    const visible = await getSidebarQuickAccess(COMPANY, "member");
    expect(visible.pinned.map((p) => p.uuid)).toEqual([PUBLIC, PRIVATE]);
    expect(visible.recent.map((p) => p.uuid)).toEqual([PRIVATE_UNGROUPED, ...liveRecent.slice(0, 4)]);
  });

  it.each([recordVisit, pinProject])("rejects hidden/foreign writes and allows member/public writes (%s)", async (write) => {
    await write(COMPANY, "outsider", PRIVATE);
    await write(COMPANY, "outsider", FOREIGN);
    expect(mockPrisma.projectVisit.upsert).not.toHaveBeenCalled();
    await write(COMPANY, "member", PRIVATE);
    await write(COMPANY, "outsider", PUBLIC);
    expect(mockPrisma.projectVisit.upsert).toHaveBeenCalledTimes(2);
  });
});

describe("trackers, available items and checkin", () => {
  it.each([
    ["owner member", agent("member"), [...publicProjects, ...privateProjects]],
    ["owner nonmember", agent("outsider"), publicProjects],
    ["ownerless", agent(), publicProjects],
  ])("%s sees accessible assignments across both trackers and checkin", async (_name, auth, expected) => {
    const assignments = await getMyAssignments(auth);
    expect(Object.keys(assignments.ideaTracker).sort()).toEqual([...expected].sort());
    expect(Object.keys(assignments.taskTracker).sort()).toEqual([...expected].sort());
    expect(assignments.taskTracker[PUBLIC].tasks[0].ac).toEqual({ passed: 1, total: 2 });
    const checkin = await buildCheckinResponse(auth);
    expect(Object.keys(checkin.activeProjects).sort()).toEqual([...expected].sort());
    expect(Object.values(checkin.activeProjects).every((p) => p.activeIdeaCount === 1)).toBe(true);
  });

  it("hides assignments immediately after membership revocation", async () => {
    const auth = agent("member");
    expect(Object.keys((await getMyAssignments(auth)).ideaTracker)).toContain(PRIVATE);
    db.projectMember = [];
    const assignments = await getMyAssignments(auth, [PRIVATE, PUBLIC]);
    expect(Object.keys(assignments.ideaTracker)).toEqual([PUBLIC]);
    expect(Object.keys(assignments.taskTracker)).toEqual([PUBLIC]);
    expect(Object.keys((await buildCheckinResponse(auth)).activeProjects).sort()).toEqual([...publicProjects].sort());
  });

  it("keeps explicit empty tracker filters empty, including header defaults", async () => {
    expect(await getMyAssignments(agent("member"), [])).toEqual({ ideaTracker: {}, taskTracker: {} });
    const auth = { ...agent("member"), projectUuids: [] };
    expect(await buildIdeaTracker(auth)).toEqual({});
    expect(await buildTaskTracker(auth)).toEqual({});
  });

  it("intersects header and explicit tracker constraints", async () => {
    const auth = { ...agent("outsider"), projectUuids: [PUBLIC, PRIVATE] };
    const result = await getMyAssignments(auth, [PUBLIC, PRIVATE, PUBLIC_UNGROUPED]);
    expect(Object.keys(result.ideaTracker)).toEqual([PUBLIC]);
    expect(Object.keys(result.taskTracker)).toEqual([PUBLIC]);
  });

  it("filters inaccessible recent ideas before tracker and active-project caps", async () => {
    for (let n = 7; n <= 17; n++) addProject(n, "public", null);
    db.idea.find((i) => i.projectUuid === PRIVATE)!.updatedAt = new Date(now.getTime() + 10000);
    const auth = agent("outsider");
    const tracker = await buildIdeaTracker(auth, { maxIdeas: 1 });
    expect(Object.keys(tracker)).toEqual([uuid(17)]);
    const distribution = await buildActiveProjectDistribution(auth);
    expect(Object.keys(distribution)).toHaveLength(10);
    expect(Object.keys(distribution)).not.toContain(PRIVATE);
  });

  it.each([[outsider, 0], [member, 1], [undefined, 0]])(
    "does not expose available private entities to nonmembers or omitted auth (%j)", async (auth, count) => {
      const result = await getAvailableItems(COMPANY, PRIVATE, true, true, undefined, auth);
      expect(result.ideas).toHaveLength(count);
      expect(result.tasks).toHaveLength(count);
      if (!count) {
        expect(mockPrisma.idea.findMany).not.toHaveBeenCalled();
        expect(mockPrisma.task.findMany).not.toHaveBeenCalled();
      }
    },
  );

  it("preserves public available items and claim capability filters", async () => {
    const result = await getAvailableItems(COMPANY, PUBLIC, true, true);
    expect(result.ideas.map((i) => i.uuid)).toEqual([uuid(101)]);
    expect(result.tasks.map((t) => t.uuid)).toEqual([uuid(201)]);
    expect(await getAvailableItems(COMPANY, PUBLIC, false, false)).toEqual({ ideas: [], tasks: [] });
  });
});

describe("supplied auth cannot cross company scope", () => {
  it.each([
    () => listProjects({ companyUuid: "other", skip: 0, take: 10, auth: member }),
    () => listProjectsWithStats({ companyUuid: "other", skip: 0, take: 10, auth: member }),
    () => getCompanyOverviewStats("other", member),
    () => listProjectGroups("other", member),
    () => getProjectGroup("other", GROUP, member),
    () => getGroupDashboard("other", GROUP, member),
    () => search({ companyUuid: "other", query: "Access", auth: member }),
    () => getAvailableItems("other", PUBLIC, true, true, undefined, member),
  ])("rejects mismatched company before reading data (%s)", async (call) => {
    await expect(call()).rejects.toMatchObject({ status: 404 });
    expect(mockPrisma.project.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.projectGroup.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.idea.findMany).not.toHaveBeenCalled();
  });
});
