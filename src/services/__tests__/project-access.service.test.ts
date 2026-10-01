import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AuthContext } from "@/types/auth";

// ===== In-memory fixture =====
interface P {
  uuid: string; companyUuid: string; name: string; visibility: string; groupUuid: string | null;
  description?: string | null; createdByUuid?: string | null; createdAt?: Date; updatedAt?: Date;
}
interface M { projectUuid: string; userUuid: string; companyUuid: string; role: string }

const db = vi.hoisted(() => ({
  projects: [] as P[],
  members: [] as M[],
  agents: [] as { uuid: string; companyUuid: string; ownerUuid: string | null }[],
  entities: {} as Record<string, { uuid: string; companyUuid: string; projectUuid: string }[]>,
  comments: [] as { uuid: string; companyUuid: string; targetType: string; targetUuid: string }[],
}));

function matchesWhere(p: P, where: Record<string, unknown>): boolean {
  if (where.companyUuid && p.companyUuid !== where.companyUuid) return false;
  if (where.uuid && typeof where.uuid === "string" && p.uuid !== where.uuid) return false;
  if (Array.isArray(where.OR)) {
    return (where.OR as Record<string, unknown>[]).some((clause) => {
      const vis = clause.visibility as { not?: string } | undefined;
      if (vis?.not !== undefined) return p.visibility !== vis.not;
      const u = clause.uuid as { in?: string[] } | undefined;
      if (u?.in) return u.in.includes(p.uuid);
      return false;
    });
  }
  return true;
}

const entityFinder = (type: string) => ({
  findFirst: vi.fn(async ({ where }: { where: { uuid: string; companyUuid: string } }) => {
    const e = (db.entities[type] ?? []).find((x) => x.uuid === where.uuid && x.companyUuid === where.companyUuid);
    return e ? { projectUuid: e.projectUuid } : null;
  }),
});

const mockPrisma = vi.hoisted(() => ({}) as Record<string, unknown>);
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));

Object.assign(mockPrisma, {
  project: {
    findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      const p = db.projects.find((x) => matchesWhere(x, where));
      return p ? { ...p } : null;
    }),
    findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
      db.projects.filter((x) => matchesWhere(x, where)).map((p) => ({ uuid: p.uuid })),
    ),
  },
  projectMember: {
    findUnique: vi.fn(async ({ where }: { where: { projectUuid_userUuid: { projectUuid: string; userUuid: string } } }) => {
      const k = where.projectUuid_userUuid;
      const m = db.members.find((x) => x.projectUuid === k.projectUuid && x.userUuid === k.userUuid);
      return m ? { role: m.role } : null;
    }),
    findMany: vi.fn(async ({ where }: { where: { companyUuid?: string; projectUuid?: string; userUuid?: string | { in: string[] } } }) => {
      if (where.userUuid === undefined) {
        return db.members.filter((x) => x.projectUuid === where.projectUuid && x.companyUuid === where.companyUuid)
          .map((m) => ({ userUuid: m.userUuid }));
      }
      if (typeof where.userUuid === "object") {
        const inSet = where.userUuid.in;
        return db.members.filter((x) => x.projectUuid === where.projectUuid && inSet.includes(x.userUuid))
          .map((m) => ({ userUuid: m.userUuid }));
      }
      return db.members.filter((x) => x.companyUuid === where.companyUuid && x.userUuid === where.userUuid)
        .map((m) => ({ projectUuid: m.projectUuid }));
    }),
  },
  agent: {
    findMany: vi.fn(async ({ where }: { where: { companyUuid: string; uuid: { in: string[] } } }) =>
      db.agents.filter((a) => a.companyUuid === where.companyUuid && where.uuid.in.includes(a.uuid))
        .map((a) => ({ uuid: a.uuid, ownerUuid: a.ownerUuid })),
    ),
    findFirst: vi.fn(async ({ where }: { where: { uuid: string; companyUuid: string } }) => {
      const a = db.agents.find((x) => x.uuid === where.uuid && x.companyUuid === where.companyUuid);
      return a ? { ownerUuid: a.ownerUuid } : null;
    }),
  },
  idea: {
    ...entityFinder("idea"),
    findMany: vi.fn(async ({ where }: { where: { companyUuid: string; uuid: { in: string[] } } }) =>
      (db.entities.idea ?? []).filter((x) => x.companyUuid === where.companyUuid && where.uuid.in.includes(x.uuid))
        .map((x) => ({ uuid: x.uuid, projectUuid: x.projectUuid })),
    ),
  },
  task: entityFinder("task"),
  proposal: {
    findFirst: vi.fn(async ({ where, select }: { where: { uuid: string; companyUuid: string }; select?: Record<string, boolean> }) => {
      const e = (db.entities.proposal ?? []).find((x) => x.uuid === where.uuid && x.companyUuid === where.companyUuid) as
        | { projectUuid: string; inputType?: string; inputUuids?: string[] }
        | undefined;
      if (!e) return null;
      return select?.inputUuids ? { inputType: e.inputType ?? "idea", inputUuids: e.inputUuids ?? [] } : { projectUuid: e.projectUuid };
    }),
  },
  document: entityFinder("document"),
  comment: {
    findFirst: vi.fn(async ({ where }: { where: { uuid: string; companyUuid: string } }) => {
      const c = db.comments.find((x) => x.uuid === where.uuid && x.companyUuid === where.companyUuid);
      return c ? { targetType: c.targetType, targetUuid: c.targetUuid } : null;
    }),
  },
});

import {
  getProjectAccess,
  requireProjectAccess,
  requireProjectOperation,
  requireEntityAccess,
  resolveEntityProjectUuid,
  accessibleProjectWhere,
  accessibleProjectUuids,
  canActorAccessProject,
  filterRecipientsByProjectAccess,
  privateProjectMemberUuids,
  requireProposalInputsAccess,
  filterExecutionViewsByAccess,
  filterRowsByProjectAccess,
  redactLineageByAccess,
  invalidateProjectAccessCache,
  requiredLevelForOperation,
  ProjectNotFoundError,
  ProjectAccessDeniedError,
  type ProjectAccessLevel,
} from "@/services/project-access.service";

// ===== Fixture data =====
const C = "company-1";
const OTHER = "company-2";

const user = (uuid: string, companyUuid = C): AuthContext => ({ type: "user", companyUuid, actorUuid: uuid });
const agent = (uuid: string, ownerUuid?: string): AuthContext => ({ type: "agent", companyUuid: C, actorUuid: uuid, ownerUuid });

beforeEach(() => {
  vi.clearAllMocks();
  db.projects = [
    { uuid: "pub", companyUuid: C, name: "Public", visibility: "public", groupUuid: null },
    { uuid: "priv", companyUuid: C, name: "Private", visibility: "private", groupUuid: null },
    { uuid: "other-co", companyUuid: OTHER, name: "Other", visibility: "public", groupUuid: null },
  ];
  db.members = [
    { projectUuid: "pub", userUuid: "u-admin", companyUuid: C, role: "admin" },
    { projectUuid: "pub", userUuid: "u-viewer", companyUuid: C, role: "viewer" },
    { projectUuid: "priv", userUuid: "u-admin", companyUuid: C, role: "admin" },
    { projectUuid: "priv", userUuid: "u-editor", companyUuid: C, role: "editor" },
    { projectUuid: "priv", userUuid: "u-viewer", companyUuid: C, role: "viewer" },
  ];
  db.agents = [
    { uuid: "a-editor", companyUuid: C, ownerUuid: "u-editor" },
    { uuid: "a-orphan", companyUuid: C, ownerUuid: null },
  ];
  db.entities = {
    task: [{ uuid: "t-priv", companyUuid: C, projectUuid: "priv" }, { uuid: "t-pub", companyUuid: C, projectUuid: "pub" }],
    idea: [{ uuid: "i-priv", companyUuid: C, projectUuid: "priv" }],
    proposal: [{ uuid: "pr-priv", companyUuid: C, projectUuid: "priv" }],
    document: [{ uuid: "d-priv", companyUuid: C, projectUuid: "priv" }],
  };
  db.comments = [{ uuid: "c-priv", companyUuid: C, targetType: "task", targetUuid: "t-priv" }];
});

// ===== D2 level table =====
describe("getProjectAccess — D2 level table", () => {
  const cases: [string, () => AuthContext, string, ProjectAccessLevel][] = [
    // users
    ["user admin member × public", () => user("u-admin"), "pub", "admin"],
    ["user viewer row × public (floored at editor)", () => user("u-viewer"), "pub", "editor"],
    ["user non-member × public", () => user("u-nobody"), "pub", "editor"],
    ["user admin × private", () => user("u-admin"), "priv", "admin"],
    ["user editor × private", () => user("u-editor"), "priv", "editor"],
    ["user viewer × private", () => user("u-viewer"), "priv", "viewer"],
    ["user non-member × private", () => user("u-nobody"), "priv", "none"],
    ["user × other company project", () => user("u-admin"), "other-co", "none"],
    // agents inherit owner
    ["agent of admin × public", () => agent("a1", "u-admin"), "pub", "admin"],
    ["agent of non-member × public", () => agent("a1", "u-nobody"), "pub", "editor"],
    ["agent of editor × private", () => agent("a1", "u-editor"), "priv", "editor"],
    ["agent of viewer × private", () => agent("a1", "u-viewer"), "priv", "viewer"],
    ["agent of non-member × private", () => agent("a1", "u-nobody"), "priv", "none"],
    ["agent × other company project", () => agent("a1", "u-admin"), "other-co", "none"],
    // ownerless agents
    ["ownerless agent × public", () => agent("a1"), "pub", "editor"],
    ["ownerless agent × private", () => agent("a1"), "priv", "none"],
  ];

  it.each(cases)("%s → %s", async (_label, makeAuth, projectUuid, expected) => {
    const { level, project } = await getProjectAccess(makeAuth(), projectUuid);
    expect(level).toBe(expected);
    expect(project === null).toBe(expected === "none");
  });

  it("returns none for a missing project", async () => {
    expect((await getProjectAccess(user("u-admin"), "missing")).level).toBe("none");
  });

  it("memoises per auth object and can be invalidated", async () => {
    const auth = user("u-editor");
    await getProjectAccess(auth, "priv");
    await getProjectAccess(auth, "priv");
    const findFirst = (mockPrisma.project as { findFirst: ReturnType<typeof vi.fn> }).findFirst;
    expect(findFirst).toHaveBeenCalledTimes(1);

    invalidateProjectAccessCache(auth, "priv");
    await getProjectAccess(auth, "priv");
    expect(findFirst).toHaveBeenCalledTimes(2);

    invalidateProjectAccessCache(auth);
    await getProjectAccess(auth, "priv");
    expect(findFirst).toHaveBeenCalledTimes(3);
  });
});

describe("requireProjectAccess", () => {
  it("throws ProjectNotFoundError (404) for non-members of a private project", async () => {
    const err = await requireProjectAccess(user("u-nobody"), "priv", "viewer").catch((e) => e);
    expect(err).toBeInstanceOf(ProjectNotFoundError);
    expect(err.status).toBe(404);
    expect(err.message).toBe("Project not found");
  });

  it("throws ProjectAccessDeniedError (403) when the level is insufficient", async () => {
    const err = await requireProjectAccess(user("u-viewer"), "priv", "editor").catch((e) => e);
    expect(err).toBeInstanceOf(ProjectAccessDeniedError);
    expect(err.status).toBe(403);
  });

  it("returns the full Project (D3 contract) with accessLevel when allowed", async () => {
    const createdAt = new Date("2026-01-01T00:00:00Z");
    Object.assign(db.projects[1], { description: "secret", createdByUuid: "u-admin", createdAt, updatedAt: createdAt });

    const p = await requireProjectAccess(user("u-editor"), "priv", "editor");
    expect(p).toEqual({
      uuid: "priv", companyUuid: C, name: "Private", visibility: "private", groupUuid: null,
      description: "secret", createdByUuid: "u-admin", createdAt, updatedAt: createdAt,
      accessLevel: "editor",
    });

    const { project } = await getProjectAccess(user("u-admin"), "priv");
    expect(project).toMatchObject({ description: "secret", createdByUuid: "u-admin", createdAt });
    // No select projection: the full row is loaded.
    const findFirst = (mockPrisma.project as { findFirst: ReturnType<typeof vi.fn> }).findFirst;
    expect(findFirst.mock.calls[0][0]).toEqual({ where: { uuid: "priv", companyUuid: C } });
  });
});

// ===== D2 operation table =====
describe("requireProjectOperation — D2 operation table", () => {
  type Expect = "ok" | 403 | 404;
  const cases: [string, () => AuthContext, string, "manage_project" | "change_visibility" | "manage_members", Expect][] = [
    ["non-member manages public settings", () => user("u-nobody"), "pub", "manage_project", "ok"],
    ["agent of non-member manages public settings", () => agent("a1", "u-nobody"), "pub", "manage_project", "ok"],
    ["non-member makes public private", () => user("u-nobody"), "pub", "change_visibility", 403],
    ["viewer-row member makes public private", () => user("u-viewer"), "pub", "change_visibility", 403],
    ["non-member manages public members", () => user("u-nobody"), "pub", "manage_members", 403],
    ["admin makes public private", () => user("u-admin"), "pub", "change_visibility", "ok"],
    ["admin manages public members", () => user("u-admin"), "pub", "manage_members", "ok"],
    ["agent of admin makes public private", () => agent("a1", "u-admin"), "pub", "change_visibility", "ok"],
    ["editor manages private settings", () => user("u-editor"), "priv", "manage_project", 403],
    ["editor changes private visibility", () => user("u-editor"), "priv", "change_visibility", 403],
    ["editor manages private members", () => user("u-editor"), "priv", "manage_members", 403],
    ["admin manages private settings", () => user("u-admin"), "priv", "manage_project", "ok"],
    ["admin changes private visibility", () => user("u-admin"), "priv", "change_visibility", "ok"],
    ["admin manages private members", () => user("u-admin"), "priv", "manage_members", "ok"],
    ["non-member manages private settings", () => user("u-nobody"), "priv", "manage_project", 404],
  ];

  it.each(cases)("%s → %s", async (_label, makeAuth, projectUuid, op, expected) => {
    const result = await requireProjectOperation(makeAuth(), projectUuid, op).then(() => "ok" as const, (e) => e.status as number);
    expect(result).toBe(expected);
  });

  it("requiredLevelForOperation matches the table", () => {
    expect(requiredLevelForOperation("manage_project", "public")).toBe("editor");
    expect(requiredLevelForOperation("manage_project", "private")).toBe("admin");
    expect(requiredLevelForOperation("change_visibility", "public")).toBe("admin");
    expect(requiredLevelForOperation("manage_members", "public")).toBe("admin");
  });
});

describe("resolveEntityProjectUuid / requireEntityAccess", () => {
  it.each([
    ["task", "t-priv"],
    ["idea", "i-priv"],
    ["proposal", "pr-priv"],
    ["document", "d-priv"],
    ["comment", "c-priv"],
    ["project", "priv"],
  ] as const)("resolves %s to its project (company-scoped)", async (type, uuid) => {
    expect(await resolveEntityProjectUuid(C, type, uuid)).toBe("priv");
    expect(await resolveEntityProjectUuid(OTHER, type, uuid)).toBeNull();
  });

  it("returns null for unknown types", async () => {
    expect(await resolveEntityProjectUuid(C, "widget", "x")).toBeNull();
  });

  it("404s with the entity label for non-members and missing entities", async () => {
    const hidden = await requireEntityAccess(user("u-nobody"), "task", "t-priv", "viewer").catch((e) => e);
    expect(hidden).toBeInstanceOf(ProjectNotFoundError);
    expect(hidden.message).toBe("Task not found");

    const missing = await requireEntityAccess(user("u-admin"), "idea", "nope", "viewer").catch((e) => e);
    expect(missing).toBeInstanceOf(ProjectNotFoundError);
    expect(missing.message).toBe("Idea not found");
  });

  it("403s a viewer writing, allows an agent of an editor", async () => {
    await expect(requireEntityAccess(user("u-viewer"), "task", "t-priv", "editor")).rejects.toBeInstanceOf(ProjectAccessDeniedError);
    await expect(requireEntityAccess(agent("a1", "u-editor"), "task", "t-priv", "editor"))
      .resolves.toEqual({ projectUuid: "priv", accessLevel: "editor" });
  });

  it("lets any company actor write public-project entities", async () => {
    await expect(requireEntityAccess(user("u-nobody"), "task", "t-pub", "editor"))
      .resolves.toEqual({ projectUuid: "pub", accessLevel: "editor" });
  });
});

describe("accessibleProjectWhere / accessibleProjectUuids", () => {
  it("non-members see public projects of their company only", async () => {
    expect(await accessibleProjectUuids(user("u-nobody"))).toEqual(["pub"]);
    expect(await accessibleProjectUuids(agent("a1"))).toEqual(["pub"]);
  });

  it("members also see their private projects; agents inherit", async () => {
    expect(await accessibleProjectUuids(user("u-viewer"))).toEqual(["pub", "priv"]);
    expect(await accessibleProjectUuids(agent("a1", "u-editor"))).toEqual(["pub", "priv"]);
  });

  it("builds a company-scoped OR clause", async () => {
    expect(await accessibleProjectWhere(user("u-nobody"))).toEqual({
      companyUuid: C,
      OR: [{ visibility: { not: "private" } }],
    });
    expect(await accessibleProjectWhere(user("u-editor"))).toEqual({
      companyUuid: C,
      OR: [{ visibility: { not: "private" } }, { uuid: { in: ["priv"] } }],
    });
  });
});

describe("filterRowsByProjectAccess", () => {
  const rows = [
    { id: 1, projectUuid: "pub" },
    { id: 2, projectUuid: "priv" },
    { id: 3, projectUuid: null },
  ];
  const projectOf = (r: (typeof rows)[number]) => r.projectUuid;

  it("drops rows in hidden projects and rows with no project", async () => {
    expect((await filterRowsByProjectAccess(user("u-nobody"), rows, projectOf)).map((r) => r.id)).toEqual([1]);
    expect((await filterRowsByProjectAccess(agent("a1", "u-editor"), rows, projectOf)).map((r) => r.id)).toEqual([1, 2]);
  });

  it("returns empty input untouched", async () => {
    expect(await filterRowsByProjectAccess(user("u-nobody"), [], projectOf)).toEqual([]);
  });
});

describe("redactLineageByAccess", () => {
  const base = {
    rootIdeaUuid: "i-priv",
    directIdeaUuid: "i-pub",
    lineage: [
      { type: "task", uuid: "t-pub", title: "T" },
      { type: "proposal", uuid: "pr-pub", title: "P" },
      { type: "idea", uuid: "i-pub", title: "pub idea" },
      { type: "idea", uuid: "i-priv", title: "secret idea" },
    ],
    resolvedVia: "via_proposal",
    ambiguous: true,
    candidates: ["i-priv", "i-pub"],
  };
  beforeEach(() => {
    db.entities.idea = [...db.entities.idea, { uuid: "i-pub", companyUuid: C, projectUuid: "pub" }];
  });

  it("returns the result untouched when every idea is visible", async () => {
    expect(await redactLineageByAccess(user("u-editor"), base)).toBe(base);
  });

  it("drops hidden idea nodes and re-derives anchors and candidates", async () => {
    const out = await redactLineageByAccess(user("u-nobody"), base);
    expect(JSON.stringify(out)).not.toContain("i-priv");
    expect(JSON.stringify(out)).not.toContain("secret");
    expect(out.rootIdeaUuid).toBe("i-pub");
    expect(out.directIdeaUuid).toBe("i-pub");
    expect(out.resolvedVia).toBe("via_proposal");
    expect(out.ambiguous).toBeUndefined();
    expect(out.candidates).toBeUndefined();
  });

  it("all ideas hidden → no-idea-ancestor shape", async () => {
    const onlyPriv = { ...base, directIdeaUuid: "i-priv", lineage: base.lineage.filter((n) => n.uuid !== "i-pub"), candidates: undefined, ambiguous: undefined };
    const out = await redactLineageByAccess(agent("a-orphan"), onlyPriv);
    expect(out.rootIdeaUuid).toBeNull();
    expect(out.directIdeaUuid).toBeNull();
    expect(out.resolvedVia).toBe("proposal_input_not_idea");
    expect(out.lineage.map((n) => n.type)).toEqual(["task", "proposal"]);
  });

  it("no idea nodes → untouched", async () => {
    const none = { rootIdeaUuid: null, directIdeaUuid: null, lineage: [], resolvedVia: "not_found" };
    expect(await redactLineageByAccess(user("u-nobody"), none)).toBe(none);
  });
});

describe("canActorAccessProject (third parties)", () => {
  it("checks users by membership", async () => {
    expect(await canActorAccessProject(C, { type: "user", uuid: "u-viewer" }, "priv", "viewer")).toBe(true);
    expect(await canActorAccessProject(C, { type: "user", uuid: "u-viewer" }, "priv", "editor")).toBe(false);
    expect(await canActorAccessProject(C, { type: "user", uuid: "u-nobody" }, "priv", "viewer")).toBe(false);
    expect(await canActorAccessProject(C, { type: "user", uuid: "u-nobody" }, "pub", "editor")).toBe(true);
  });

  it("checks agents via their owner", async () => {
    expect(await canActorAccessProject(C, { type: "agent", uuid: "a-editor" }, "priv", "editor")).toBe(true);
    expect(await canActorAccessProject(C, { type: "agent", uuid: "a-orphan" }, "priv", "viewer")).toBe(false);
    expect(await canActorAccessProject(C, { type: "agent", uuid: "a-orphan" }, "pub", "editor")).toBe(true);
    expect(await canActorAccessProject(C, { type: "agent", uuid: "a-missing" }, "pub", "viewer")).toBe(false);
  });

  it("rejects unknown actor types", async () => {
    expect(await canActorAccessProject(C, { type: "super_admin", uuid: "x" }, "pub", "viewer")).toBe(false);
  });
});

describe("filterRecipientsByProjectAccess", () => {
  const people = [
    { type: "user", uuid: "u-viewer" },
    { type: "user", uuid: "u-nobody" },
    { type: "agent", uuid: "a-editor" },
    { type: "agent", uuid: "a-orphan" },
    { type: "agent", uuid: "a-missing" },
  ];

  it("private project keeps only members and agents owned by members", async () => {
    expect(await filterRecipientsByProjectAccess(C, "priv", people)).toEqual([
      { type: "user", uuid: "u-viewer" },
      { type: "agent", uuid: "a-editor" },
    ]);
  });

  it("public project keeps every user/agent recipient", async () => {
    expect(await filterRecipientsByProjectAccess(C, "pub", people)).toEqual(people);
  });

  it("unknown / other-company project drops everyone; empty input short-circuits", async () => {
    expect(await filterRecipientsByProjectAccess(C, "other-co", people)).toEqual([]);
    expect(await filterRecipientsByProjectAccess(C, "priv", [])).toEqual([]);
  });
});

describe("privateProjectMemberUuids", () => {
  it("lists members of a private project, null for public / unknown / other-company", async () => {
    expect((await privateProjectMemberUuids(C, "priv"))?.sort()).toEqual(["u-admin", "u-editor", "u-viewer"]);
    expect(await privateProjectMemberUuids(C, "pub")).toBeNull();
    expect(await privateProjectMemberUuids(C, "missing")).toBeNull();
    expect(await privateProjectMemberUuids(C, "other-co")).toBeNull();
  });
});

describe("requireProposalInputsAccess", () => {
  it("passes when every stored input is visible, 404s on a hidden or missing one", async () => {
    db.entities.proposal = [
      { uuid: "pr-ok", companyUuid: C, projectUuid: "pub", inputType: "idea", inputUuids: ["i-priv"] } as never,
      { uuid: "pr-gone", companyUuid: C, projectUuid: "pub", inputType: "idea", inputUuids: ["i-nope"] } as never,
    ];
    await expect(requireProposalInputsAccess(user("u-viewer"), "pr-ok")).resolves.toBeUndefined();
    const hidden = await requireProposalInputsAccess(user("u-nobody"), "pr-ok").catch((e) => e);
    expect(hidden).toBeInstanceOf(ProjectNotFoundError);
    expect(hidden.message).toBe("Idea not found");
    await expect(requireProposalInputsAccess(user("u-admin"), "pr-gone")).rejects.toBeInstanceOf(ProjectNotFoundError);
  });

  it("404s a proposal outside the company", async () => {
    const err = await requireProposalInputsAccess(user("u-admin", OTHER), "pr-priv").catch((e) => e);
    expect(err.message).toBe("Proposal not found");
  });
});

describe("filterExecutionViewsByAccess", () => {
  const row = (uuid: string, projectUuid: string | null, idea: string | null) =>
    ({ uuid, projectUuid, directIdeaUuid: idea, rootIdeaUuid: null });

  it("redacts hidden direct/root anchors on a visible row (never leaks a private root title)", async () => {
    db.entities.idea = [...(db.entities.idea ?? []), { uuid: "i-pub", companyUuid: C, projectUuid: "pub" }];
    const rows = [{ uuid: "e-mixed", projectUuid: "pub", directIdeaUuid: "i-pub", rootIdeaUuid: "i-priv", rootIdeaTitle: "SECRET" }];
    expect(await filterExecutionViewsByAccess(user("u-nobody"), rows)).toEqual([
      { uuid: "e-mixed", projectUuid: "pub", directIdeaUuid: "i-pub", rootIdeaUuid: null, rootIdeaTitle: null },
    ]);
    // A member keeps every anchor.
    expect(await filterExecutionViewsByAccess(user("u-viewer"), rows)).toEqual(rows);
    // A hidden DIRECT anchor is redacted the same way.
    const direct = [{ uuid: "e-d", projectUuid: "pub", directIdeaUuid: "i-priv", rootIdeaUuid: null, rootIdeaTitle: null }];
    expect((await filterExecutionViewsByAccess(user("u-nobody"), direct))[0].directIdeaUuid).toBeNull();
  });

  it("uses a caller-supplied live visible set instead of querying", async () => {
    const rows = [{ uuid: "e", projectUuid: "priv", directIdeaUuid: null, rootIdeaUuid: null }];
    expect(await filterExecutionViewsByAccess(user("u-nobody"), rows, new Set(["priv"]))).toEqual(rows);
    expect(await filterExecutionViewsByAccess(user("u-admin"), rows, new Set())).toEqual([]);
  });

  it("keeps visible-project rows and ad-hoc rows; drops hidden-project and unresolvable-idea rows", async () => {
    const rows = [
      row("e-pub", "pub", null),
      row("e-priv", "priv", null),
      row("e-priv-idea", null, "i-priv"),
      row("e-gone-idea", null, "i-missing"),
      row("e-adhoc", null, null),
    ];
    expect((await filterExecutionViewsByAccess(user("u-nobody"), rows)).map((r) => r.uuid)).toEqual(["e-pub", "e-adhoc"]);
    expect((await filterExecutionViewsByAccess(user("u-viewer"), rows)).map((r) => r.uuid))
      .toEqual(["e-pub", "e-priv", "e-priv-idea", "e-adhoc"]);
    expect(await filterExecutionViewsByAccess(user("u-nobody"), [])).toEqual([]);
  });
});
