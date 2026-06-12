// src/__tests__/integration/project-visibility.integration.test.ts
//
// BLOCKER-2 safeguard (Tech Design §8.1): proves the project-visibility privacy
// boundary actually holds end-to-end across the whole cascade, driving the REAL
// authz layer (src/lib/authz/project-access.ts) and the REAL service functions
// against a faithful in-memory Prisma stub. Nothing about access control is
// mocked — only the database is in-memory.
//
// Scenario:
//   - PRIVATE project P (owner = user A; member = agent M)
//   - SHARED project S (no explicit members)
//   - Non-members: user B, agent N (N carries project:admin to prove the
//     permission bitset grants NO bypass)
//   - super_admin SA (sees everything)
// Each project has one idea / proposal / document / task / activity row, a
// notification for each recipient, and a comment on the task.
//
// Assertions: non-members are denied reads AND writes on P across
// project/idea/proposal/document/task/activity/notification/search/comment;
// owner + member + super_admin are allowed; the shared project S stays visible
// to everyone (regression); and a projectUuids[] header does not grant access.

import { describe, it, expect, beforeEach, vi } from "vitest";

// ---- in-memory store (hoisted so the vi.mock factory can reach it) ----
const { db } = vi.hoisted(() => ({
  db: {
    project: [] as any[],
    projectMember: [] as any[],
    idea: [] as any[],
    proposal: [] as any[],
    document: [] as any[],
    task: [] as any[],
    activity: [] as any[],
    notification: [] as any[],
    comment: [] as any[],
    user: [] as any[],
    agent: [] as any[],
    projectGroup: [] as any[],
    projectGroupMember: [] as any[],
    taskDependency: [] as any[],
    acceptanceCriterion: [] as any[],
  } as Record<string, any[]>,
}));

// Generic where-matcher supporting the operators the gated services use:
// equality, { in: [...] }, { not: x }, { contains, mode }, and top-level OR.
function matchWhere(row: any, where: any): boolean {
  if (!where) return true;
  for (const [key, cond] of Object.entries<any>(where)) {
    if (key === "OR") {
      if (!(cond as any[]).some((sub) => matchWhere(row, sub))) return false;
      continue;
    }
    if (key === "AND") {
      if (!(cond as any[]).every((sub) => matchWhere(row, sub))) return false;
      continue;
    }
    const val = row[key];
    if (cond && typeof cond === "object" && !Array.isArray(cond)) {
      if ("in" in cond) {
        if (!(cond.in as any[]).includes(val)) return false;
      } else if ("not" in cond) {
        if (cond.not === null ? val === null || val === undefined : val === cond.not) return false;
      } else if ("contains" in cond) {
        const hay = String(val ?? "");
        const needle = String(cond.contains);
        const ok = cond.mode === "insensitive"
          ? hay.toLowerCase().includes(needle.toLowerCase())
          : hay.includes(needle);
        if (!ok) return false;
      } else {
        // nested object equality not used by these queries
        if (val !== cond) return false;
      }
    } else {
      if (val !== cond) return false;
    }
  }
  return true;
}

// Hydrate the `project` relation (select { name }/{ uuid, name }) that task
// reads/searches `include`/`select`. Other relations are pre-seeded as [].
function hydrate(name: string, row: any): any {
  if (!row) return row;
  if (name === "task" || name === "idea" || name === "proposal" || name === "document") {
    const proj = db.project.find((p) => p.uuid === row.projectUuid);
    return { ...row, project: proj ? { uuid: proj.uuid, name: proj.name } : undefined };
  }
  return { ...row };
}

function makeModel(name: string) {
  const rows = () => db[name];
  return {
    findFirst: vi.fn(async ({ where }: any = {}) => {
      const r = rows().find((row) => matchWhere(row, where));
      return r ? hydrate(name, r) : null;
    }),
    findUnique: vi.fn(async ({ where }: any = {}) => {
      // composite unique key used by ProjectMember
      if (where?.projectUuid_memberType_memberUuid) {
        const k = where.projectUuid_memberType_memberUuid;
        return rows().find((r) => r.projectUuid === k.projectUuid && r.memberType === k.memberType && r.memberUuid === k.memberUuid) ?? null;
      }
      // composite unique key used by ProjectGroupMember
      if (where?.projectGroupUuid_memberType_memberUuid) {
        const k = where.projectGroupUuid_memberType_memberUuid;
        return rows().find((r) => r.projectGroupUuid === k.projectGroupUuid && r.memberType === k.memberType && r.memberUuid === k.memberUuid) ?? null;
      }
      const r = rows().find((row) => matchWhere(row, where));
      return r ? hydrate(name, r) : null;
    }),
    findMany: vi.fn(async ({ where, take }: any = {}) => {
      let out = rows().filter((r) => matchWhere(r, where));
      if (typeof take === "number") out = out.slice(0, take);
      return out.map((r) => hydrate(name, r));
    }),
    count: vi.fn(async ({ where }: any = {}) => rows().filter((r) => matchWhere(r, where)).length),
    groupBy: vi.fn(async ({ by, where }: any = {}) => {
      const matched = rows().filter((r) => matchWhere(r, where));
      const key = (by as string[])[0];
      const groups = new Map<string, number>();
      for (const r of matched) groups.set(r[key], (groups.get(r[key]) ?? 0) + 1);
      return [...groups.entries()].map(([k, n]) => ({ [key]: k, _count: { [key]: n, _all: n } }));
    }),
    create: vi.fn(async ({ data }: any) => {
      const row = {
        uuid: data.uuid ?? `${name}-${rows().length + 1}-${Math.floor(performance.now() * 1000)}`,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...data,
      };
      rows().push(row);
      return { ...row };
    }),
    update: vi.fn(async ({ where, data }: any) => {
      const row = rows().find((r) => matchWhere(r, where));
      if (!row) {
        const e: any = new Error("Record to update not found");
        e.code = "P2025";
        throw e;
      }
      Object.assign(row, data, { updatedAt: new Date() });
      // task.update includes project relation in some callers
      return { ...row, project: db.project.find((p) => p.uuid === row.projectUuid) };
    }),
  };
}

const mockPrisma = vi.hoisted(() => ({} as any));
for (const _ of []) void _; // noop to keep hoist ordering clear

vi.mock("@/lib/prisma", () => {
  // Build the prisma stub lazily so `db` is populated per-test.
  const models = ["project", "projectMember", "idea", "proposal", "document", "task", "activity", "notification", "comment", "user", "agent", "projectGroup", "projectGroupMember", "taskDependency", "acceptanceCriterion"];
  const client: any = {};
  for (const m of models) client[m] = makeModel(m);
  client.$transaction = async (arg: any) => (typeof arg === "function" ? arg(client) : Promise.all(arg));
  Object.assign(mockPrisma, client);
  return { prisma: client };
});

// event bus is fire-and-forget; stub it
vi.mock("@/lib/event-bus", () => ({ eventBus: { emitChange: vi.fn() } }));

import { canAccessProject, getAccessibleProjectUuids } from "@/lib/authz/project-access";
import * as projectService from "@/services/project.service";
import * as taskService from "@/services/task.service";
import * as commentService from "@/services/comment.service";
import * as activityService from "@/services/activity.service";
import * as searchService from "@/services/search.service";
import * as notificationService from "@/services/notification.service";
import type { AuthContext, SuperAdminAuthContext, AgentAuthContext } from "@/types/auth";

const COMPANY = "co-1";
const P = "proj-private";
const S = "proj-shared";

// actors
const A: AuthContext = { type: "user", companyUuid: COMPANY, actorUuid: "userA" };       // owner of P
const M: AuthContext = { type: "agent", companyUuid: COMPANY, actorUuid: "agentM" };      // member of P
const B: AuthContext = { type: "user", companyUuid: COMPANY, actorUuid: "userB" };        // non-member
const N: AgentAuthContext = {                                                              // non-member, project:admin
  type: "agent", companyUuid: COMPANY, actorUuid: "agentN",
  roles: ["admin_agent"], permissions: ["project:read", "project:write", "project:admin", "task:read", "task:write", "idea:read"],
  agentName: "AdminBot", projectUuids: [P], // header claims P — must NOT grant access
};
const SA: SuperAdminAuthContext = { type: "super_admin", email: "root@chorus.local" };

function seed() {
  for (const k of Object.keys(db)) db[k].length = 0;
  db.user.push({ uuid: "userA", companyUuid: COMPANY, name: "A" }, { uuid: "userB", companyUuid: COMPANY, name: "B" });
  db.agent.push({ uuid: "agentM", companyUuid: COMPANY, name: "M" }, { uuid: "agentN", companyUuid: COMPANY, name: "N" });

  db.project.push(
    { uuid: P, companyUuid: COMPANY, name: "Private", description: "secret", groupUuid: null, visibility: "private", ownerType: "user", ownerUuid: "userA" },
    { uuid: S, companyUuid: COMPANY, name: "Shared", description: "open", groupUuid: null, visibility: "shared", ownerType: "user", ownerUuid: "userA" },
  );
  // P members: owner A + agent M
  db.projectMember.push(
    { uuid: "pm-a", companyUuid: COMPANY, projectUuid: P, memberType: "user", memberUuid: "userA", role: "member" },
    { uuid: "pm-m", companyUuid: COMPANY, projectUuid: P, memberType: "agent", memberUuid: "agentM", role: "member" },
  );

  for (const proj of [P, S]) {
    const tag = proj === P ? "priv" : "shar";
    db.idea.push({ uuid: `idea-${tag}`, companyUuid: COMPANY, projectUuid: proj, title: `idea ${tag} secretword`, content: null, status: "open", assigneeType: null, assigneeUuid: null, createdByUuid: "userA" });
    db.proposal.push({ uuid: `prop-${tag}`, companyUuid: COMPANY, projectUuid: proj, title: `prop ${tag} secretword`, status: "pending", createdByUuid: "userA" });
    db.document.push({ uuid: `doc-${tag}`, companyUuid: COMPANY, projectUuid: proj, type: "tech_design", title: `doc ${tag} secretword`, content: null, version: 1, proposalUuid: null, createdByUuid: "userA" });
    db.task.push({ uuid: `task-${tag}`, companyUuid: COMPANY, projectUuid: proj, title: `task ${tag} secretword`, description: null, status: "open", priority: "medium", storyPoints: null, acceptanceCriteria: null, assigneeType: null, assigneeUuid: null, assignedAt: null, assignedByUuid: null, proposalUuid: null, createdByUuid: "userA", dependsOn: [], dependedBy: [], acceptanceCriteriaItems: [] });
    db.activity.push({ uuid: `act-${tag}`, companyUuid: COMPANY, projectUuid: proj, targetType: "task", targetUuid: `task-${tag}`, actorType: "user", actorUuid: "userA", action: "created", value: null, sessionUuid: null, sessionName: null });
    db.comment.push({ uuid: `cmt-${tag}`, companyUuid: COMPANY, targetType: "task", targetUuid: `task-${tag}`, content: "hi", authorType: "user", authorUuid: "userA" });
    // a project-scoped notification for user B (recipient) referencing each project
    db.notification.push({ uuid: `ntf-${tag}`, companyUuid: COMPANY, recipientType: "user", recipientUuid: "userB", projectUuid: proj, type: "mention", title: "n", body: "", entityType: null, entityUuid: null, actorType: null, actorUuid: null, readAt: null, archivedAt: null });
  }
  // a non-project notification for B (projectUuid "") — must always be visible
  db.notification.push({ uuid: "ntf-global", companyUuid: COMPANY, recipientType: "user", recipientUuid: "userB", projectUuid: "", type: "system", title: "g", body: "", entityType: null, entityUuid: null, actorType: null, actorUuid: null, readAt: null, archivedAt: null });

  // Stamp timestamps on every seeded row so service formatters (.toISOString())
  // work against the in-memory store.
  const now = new Date("2026-06-11T00:00:00Z");
  for (const k of Object.keys(db)) {
    for (const row of db[k]) {
      if (row.createdAt === undefined) row.createdAt = now;
      if (row.updatedAt === undefined) row.updatedAt = now;
    }
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  seed();
});

describe("project-visibility cascade — canAccessProject core", () => {
  it("private project P: owner A and member M allowed; non-members B and N denied; super_admin allowed", async () => {
    expect(await canAccessProject(A, P)).toBe(true);
    expect(await canAccessProject(M, P)).toBe(true);
    expect(await canAccessProject(B, P)).toBe(false);
    expect(await canAccessProject(N, P)).toBe(false); // project:admin does NOT bypass
    expect(await canAccessProject(SA, P)).toBe(true);
  });

  it("shared project S: visible to every company actor", async () => {
    for (const actor of [A, M, B, N, SA]) {
      expect(await canAccessProject(actor, S)).toBe(true);
    }
  });

  it("AgentAuthContext.projectUuids[] header does NOT grant a non-member access", async () => {
    // N's header lists P, yet access is derived purely from membership.
    expect(N.projectUuids).toContain(P);
    expect(await canAccessProject(N, P)).toBe(false);
  });
});

describe("project-visibility cascade — single-entity reads", () => {
  it("getProject(P): owner/member/SA get it, non-members get null", async () => {
    expect(await projectService.getProject(COMPANY, P, A)).not.toBeNull();
    expect(await projectService.getProject(COMPANY, P, M)).not.toBeNull();
    expect(await projectService.getProject(COMPANY, P, SA)).not.toBeNull();
    expect(await projectService.getProject(COMPANY, P, B)).toBeNull();
    expect(await projectService.getProject(COMPANY, P, N)).toBeNull();
  });

  it("getTask on private task: members allowed, non-members get null", async () => {
    expect(await taskService.getTask(COMPANY, "task-priv", A)).not.toBeNull();
    expect(await taskService.getTask(COMPANY, "task-priv", M)).not.toBeNull();
    expect(await taskService.getTask(COMPANY, "task-priv", B)).toBeNull();
    expect(await taskService.getTask(COMPANY, "task-priv", N)).toBeNull();
    expect(await taskService.getTask(COMPANY, "task-priv", SA)).not.toBeNull();
  });

  it("shared task is readable by a non-member of P (regression)", async () => {
    expect(await taskService.getTask(COMPANY, "task-shar", B)).not.toBeNull();
    expect(await taskService.getTask(COMPANY, "task-shar", N)).not.toBeNull();
  });
});

describe("project-visibility cascade — list reads", () => {
  it("listProjects: non-members never see P; owner/member do; both see S", async () => {
    const forB = await projectService.listProjects({ companyUuid: COMPANY, skip: 0, take: 50, auth: B });
    const uuidsB = forB.projects.map((p: any) => p.uuid);
    expect(uuidsB).toContain(S);
    expect(uuidsB).not.toContain(P);

    const forA = await projectService.listProjects({ companyUuid: COMPANY, skip: 0, take: 50, auth: A });
    expect(forA.projects.map((p: any) => p.uuid).sort()).toEqual([P, S].sort());

    const forSA = await projectService.listProjects({ companyUuid: COMPANY, skip: 0, take: 50, auth: SA });
    expect(forSA.projects.map((p: any) => p.uuid).sort()).toEqual([P, S].sort());
  });

  it("listTasks on P: empty for non-members, populated for members", async () => {
    const params = (auth: any) => ({ companyUuid: COMPANY, projectUuid: P, skip: 0, take: 50, auth });
    expect((await taskService.listTasks(params(B))).total).toBe(0);
    expect((await taskService.listTasks(params(N))).total).toBe(0);
    expect((await taskService.listTasks(params(M))).total).toBe(1);
    expect((await taskService.listTasks(params(A))).total).toBe(1);
  });

  it("listActivities on P: empty for non-members, populated for members", async () => {
    const params = (auth: any) => ({ companyUuid: COMPANY, projectUuid: P, skip: 0, take: 50, auth });
    expect((await activityService.listActivities(params(B))).total).toBe(0);
    expect((await activityService.listActivities(params(N))).total).toBe(0);
    expect((await activityService.listActivities(params(M))).total).toBe(1);
  });
});

describe("project-visibility cascade — search never leaks private entities", () => {
  const baseSearch = (auth: any) => ({ query: "secretword", companyUuid: COMPANY, auth });

  it("non-member global search returns only shared-project entities", async () => {
    const res = await searchService.search(baseSearch(B));
    const projectUuidsHit = new Set(res.results.map((r: any) => r.projectUuid).filter(Boolean));
    expect(projectUuidsHit.has(P)).toBe(false);
    // shared entities still found
    expect(res.results.some((r: any) => r.projectUuid === S)).toBe(true);
  });

  it("project:admin non-member search still cannot see private entities", async () => {
    const res = await searchService.search(baseSearch(N));
    expect(res.results.some((r: any) => r.projectUuid === P)).toBe(false);
  });

  it("member search DOES see private entities", async () => {
    const res = await searchService.search(baseSearch(M));
    expect(res.results.some((r: any) => r.projectUuid === P)).toBe(true);
  });
});

describe("project-visibility cascade — notifications", () => {
  it("non-member B does not receive the private-project notification but keeps shared + global ones", async () => {
    const res = await notificationService.list({ companyUuid: COMPANY, recipientType: "user", recipientUuid: "userB", auth: B });
    const uuids = res.notifications.map((n: any) => n.uuid);
    expect(uuids).not.toContain("ntf-priv");   // private project -> hidden
    expect(uuids).toContain("ntf-shar");        // shared project -> visible
    expect(uuids).toContain("ntf-global");      // non-project -> always visible
  });

  it("super_admin sees all of B's notifications including the private-project one", async () => {
    const res = await notificationService.list({ companyUuid: COMPANY, recipientType: "user", recipientUuid: "userB", auth: SA });
    expect(res.notifications.map((n: any) => n.uuid)).toContain("ntf-priv");
  });
});

describe("project-visibility cascade — writes", () => {
  it("claimTask on a private task: non-members rejected, member succeeds", async () => {
    await expect(
      taskService.claimTask({ taskUuid: "task-priv", companyUuid: COMPANY, assigneeType: "user", assigneeUuid: "userB", assignedByUuid: "userB" }, B),
    ).rejects.toThrow();
    await expect(
      taskService.claimTask({ taskUuid: "task-priv", companyUuid: COMPANY, assigneeType: "agent", assigneeUuid: "agentN", assignedByUuid: "agentN" }, N),
    ).rejects.toThrow();
    // member M succeeds
    const claimed = await taskService.claimTask({ taskUuid: "task-priv", companyUuid: COMPANY, assigneeType: "agent", assigneeUuid: "agentM", assignedByUuid: "agentM" }, M);
    expect(claimed.status).toBe("assigned");
  });

  it("createComment on a private task: non-members rejected, member succeeds", async () => {
    await expect(
      commentService.createComment({ companyUuid: COMPANY, targetType: "task", targetUuid: "task-priv", content: "x", authorType: "user", authorUuid: "userB", auth: B }),
    ).rejects.toThrow();
    await expect(
      commentService.createComment({ companyUuid: COMPANY, targetType: "task", targetUuid: "task-priv", content: "x", authorType: "agent", authorUuid: "agentN", auth: N }),
    ).rejects.toThrow();
    const ok = await commentService.createComment({ companyUuid: COMPANY, targetType: "task", targetUuid: "task-priv", content: "ok", authorType: "agent", authorUuid: "agentM", auth: M });
    expect(ok.uuid).toBeTruthy();
  });

  it("listComments on a private task: empty for non-members, populated for members", async () => {
    expect((await commentService.listComments({ companyUuid: COMPANY, targetType: "task", targetUuid: "task-priv", skip: 0, take: 50, auth: B })).total).toBe(0);
    expect((await commentService.listComments({ companyUuid: COMPANY, targetType: "task", targetUuid: "task-priv", skip: 0, take: 50, auth: M })).total).toBeGreaterThan(0);
  });

  it("createComment on a SHARED task: non-member of P is allowed (regression)", async () => {
    const ok = await commentService.createComment({ companyUuid: COMPANY, targetType: "task", targetUuid: "task-shar", content: "ok", authorType: "user", authorUuid: "userB", auth: B });
    expect(ok.uuid).toBeTruthy();
  });
});

// ===========================================================================
// Two-level inheritance (ProjectGroup → Project) — dynamic union
// ===========================================================================
//
// Group GRP: PRIVATE, owned by user A, with agent M as a GROUP member (M is NOT
// a direct member of the project below). Contains:
//   - GP : a PRIVATE project (owner A, no extra direct members) with one task.
//   - GPS: a SHARED project (must stay company-wide regardless of the private group).
// userB is a non-member of everything.
const GRP = "group-private";
const GP = "proj-in-group";
const GPS = "shared-in-private-group";

function seedGroupFixtures() {
  db.projectGroup.push({
    uuid: GRP, companyUuid: COMPANY, name: "Private Group", description: "g",
    visibility: "private", ownerType: "user", ownerUuid: "userA",
  });
  // Group members: owner A + agent M (M reaches projects ONLY via the group).
  db.projectGroupMember.push(
    { uuid: "gm-a", companyUuid: COMPANY, projectGroupUuid: GRP, memberType: "user", memberUuid: "userA", role: "member" },
    { uuid: "gm-m", companyUuid: COMPANY, projectGroupUuid: GRP, memberType: "agent", memberUuid: "agentM", role: "member" },
  );
  db.project.push(
    { uuid: GP, companyUuid: COMPANY, name: "GroupedPrivate", description: "gp", groupUuid: GRP, visibility: "private", ownerType: "user", ownerUuid: "userA" },
    { uuid: GPS, companyUuid: COMPANY, name: "GroupedShared", description: "gps", groupUuid: GRP, visibility: "shared", ownerType: "user", ownerUuid: "userA" },
  );
  // GP has its own ProjectMember only for the owner (so M's access is purely via the group).
  db.projectMember.push({ uuid: "pm-gp-a", companyUuid: COMPANY, projectUuid: GP, memberType: "user", memberUuid: "userA", role: "member" });
  db.task.push({ uuid: "task-gp", companyUuid: COMPANY, projectUuid: GP, title: "grouped task", description: null, status: "open", priority: "medium", storyPoints: null, acceptanceCriteria: null, assigneeType: null, assigneeUuid: null, assignedAt: null, assignedByUuid: null, proposalUuid: null, createdByUuid: "userA", dependsOn: [], dependedBy: [], acceptanceCriteriaItems: [], createdAt: new Date("2026-06-11T00:00:00Z"), updatedAt: new Date("2026-06-11T00:00:00Z") });
  db.comment.push({ uuid: "cmt-gp", companyUuid: COMPANY, targetType: "task", targetUuid: "task-gp", content: "hi", authorType: "user", authorUuid: "userA", createdAt: new Date("2026-06-11T00:00:00Z"), updatedAt: new Date("2026-06-11T00:00:00Z") });
}

describe("group inheritance — dynamic union (read + write via group membership)", () => {
  beforeEach(() => seedGroupFixtures());

  it("group member M can READ the group's private project + its task (purely via group membership)", async () => {
    expect(await canAccessProject(M, GP)).toBe(true);
    expect(await projectService.getProject(COMPANY, GP, M)).not.toBeNull();
    expect(await taskService.getTask(COMPANY, "task-gp", M)).not.toBeNull();
    expect((await taskService.listTasks({ companyUuid: COMPANY, projectUuid: GP, skip: 0, take: 50, auth: M })).total).toBe(1);
  });

  it("group member M can WRITE the group's private project (claim task, comment) via group membership", async () => {
    const claimed = await taskService.claimTask({ taskUuid: "task-gp", companyUuid: COMPANY, assigneeType: "agent", assigneeUuid: "agentM", assignedByUuid: "agentM" }, M);
    expect(claimed.status).toBe("assigned");
    const c = await commentService.createComment({ companyUuid: COMPANY, targetType: "task", targetUuid: "task-gp", content: "via group", authorType: "agent", authorUuid: "agentM", auth: M });
    expect(c.uuid).toBeTruthy();
  });

  it("the grouped private project appears in M's accessible-project set", async () => {
    const accessible = await getAccessibleProjectUuids(M);
    expect(accessible).not.toBe("ALL");
    expect(accessible as string[]).toContain(GP);
  });

  it("a NON-group-member (user B) is denied the group's private project + task", async () => {
    expect(await canAccessProject(B, GP)).toBe(false);
    expect(await projectService.getProject(COMPANY, GP, B)).toBeNull();
    expect(await taskService.getTask(COMPANY, "task-gp", B)).toBeNull();
    await expect(
      taskService.claimTask({ taskUuid: "task-gp", companyUuid: COMPANY, assigneeType: "user", assigneeUuid: "userB", assignedByUuid: "userB" }, B),
    ).rejects.toThrow();
  });

  it("project:admin agent N (non-group-member) is still denied (no bypass)", async () => {
    expect(await canAccessProject(N, GP)).toBe(false);
  });

  it("DYNAMIC: removing M from the group revokes access to the grouped project", async () => {
    expect(await canAccessProject(M, GP)).toBe(true);
    // Remove M's group membership row (dynamic — no snapshot).
    const idx = db.projectGroupMember.findIndex((r) => r.projectGroupUuid === GRP && r.memberType === "agent" && r.memberUuid === "agentM");
    db.projectGroupMember.splice(idx, 1);
    expect(await canAccessProject(M, GP)).toBe(false);
    expect(await taskService.getTask(COMPANY, "task-gp", M)).toBeNull();
  });

  it("INVARIANT: a SHARED project inside the PRIVATE group is still company-wide", async () => {
    // userB is in no group and no project, yet the shared project is visible.
    expect(await canAccessProject(B, GPS)).toBe(true);
    expect(await projectService.getProject(COMPANY, GPS, B)).not.toBeNull();
  });

  it("INVARIANT: a non-member does NOT inherit the private grouped project just because they can't see the group", async () => {
    // Sanity: B has no accessible projects from this group.
    const accessible = await getAccessibleProjectUuids(B);
    expect(accessible).not.toBe("ALL");
    expect(accessible as string[]).not.toContain(GP);
    // but DOES include the shared one
    expect(accessible as string[]).toContain(GPS);
  });
});
