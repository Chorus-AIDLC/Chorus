import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthContext } from "@/types/auth";

// Exercise real search + group/project access services. The adapter evaluates
// the actual Prisma relation predicates against mixed group/project grants.
type Row = Record<string, any>;
const fixture = vi.hoisted(() => {
  const groups: Row[] = [];
  const projects: Row[] = [];
  const groupMembers: Row[] = [];
  const members: Row[] = [];
  const matches = (row: Row, where: Row): boolean => Object.entries(where).every(([key, value]) => {
    if (key === "AND") return (Array.isArray(value) ? value : [value]).every((w) => matches(row, w));
    if (key === "OR") return value.some((w: Row) => matches(row, w));
    if (key === "group") return groups.some((g) => g.uuid === row.groupUuid && matches(g, value));
    if (key === "members") {
      const rows = row.groupUuid === undefined ? groupMembers.filter((m) => m.groupUuid === row.uuid) : members.filter((m) => m.projectUuid === row.uuid);
      return rows.some((m) => matches(m, value.some));
    }
    if (key === "projects") return projects.some((p) => p.groupUuid === row.uuid && matches(p, value.some));
    if (value && typeof value === "object") {
      if ("in" in value) return value.in.includes(row[key]);
      if ("not" in value) return row[key] !== value.not;
      if ("contains" in value) return String(row[key] ?? "").toLowerCase().includes(value.contains.toLowerCase());
    }
    return row[key] === value;
  });
  const model = (rows: Row[]) => ({
    findFirst: vi.fn(async ({ where }: Row) => rows.find((r) => matches(r, where)) ?? null),
    findMany: vi.fn(async ({ where }: Row) => rows.filter((r) => matches(r, where))),
    count: vi.fn(async ({ where }: Row) => rows.filter((r) => matches(r, where)).length),
  });
  return {
    groups, projects, groupMembers, members,
    prisma: { user: { findFirst: vi.fn(async () => null) }, project: model(projects), projectGroup: model(groups), projectMember: model(members), projectGroupMember: model(groupMembers) },
  };
});
vi.mock("@/lib/prisma", () => ({ prisma: fixture.prisma }));
import { search } from "@/services/search.service";

const companyUuid = "company";
const hidden = "00000000-0000-4000-8000-000000000001";
const publicGroup = "00000000-0000-4000-8000-000000000002";
const auth = (actorUuid: string): AuthContext => ({ type: "user", companyUuid, actorUuid });
beforeEach(() => {
  vi.clearAllMocks();
  fixture.groups.splice(0, Infinity,
    { uuid: hidden, companyUuid, visibility: "private", name: "Needle secret", description: "", updatedAt: new Date() },
    { uuid: publicGroup, companyUuid, visibility: "public", name: "Needle public", description: "", updatedAt: new Date() },
  );
  fixture.projects.splice(0, Infinity,
    { uuid: "child", companyUuid, groupUuid: hidden, visibility: "private" },
    { uuid: "other-child", companyUuid, groupUuid: hidden, visibility: "private" },
  );
  fixture.groupMembers.splice(0, Infinity,
    { companyUuid, groupUuid: hidden, userUuid: "group-viewer", role: "viewer" },
    { companyUuid, groupUuid: hidden, userUuid: "admin", role: "admin" },
  );
  fixture.members.splice(0, Infinity, { companyUuid, projectUuid: "child", userUuid: "project-only", role: "viewer" });
});

describe("group discovery in real search predicates", () => {
  it.each(["Needle", hidden])("hides private group names and exact UUIDs for outsiders: %s", async (query) => {
    const response = await search({ companyUuid, query, entityTypes: ["project_group"], auth: auth("outsider") });
    expect(response.results.map((r) => r.uuid)).not.toContain(hidden);
    expect(response.counts.projectGroups).toBe(query === "Needle" ? 1 : 0);
  });

  it.each(["group-viewer", "project-only"])("permits discovery through the correct independent grant for %s", async (user) => {
    const response = await search({ companyUuid, query: hidden, entityTypes: ["project_group"], auth: auth(user) });
    expect(response.results.map((r) => r.uuid)).toEqual([hidden]);
  });

  it("resolves agents through their owner and keeps ownerless agents outside private groups", async () => {
    const agent: AuthContext = { type: "agent", companyUuid, actorUuid: "agent", ownerUuid: "group-viewer" };
    expect((await search({ companyUuid, query: hidden, entityTypes: ["project_group"], auth: agent })).results).toHaveLength(1);
    expect((await search({ companyUuid, query: hidden, entityTypes: ["project_group"], auth: { ...agent, ownerUuid: undefined } })).results).toEqual([]);
  });

  it("a hidden group scope stops before enumerating child projects", async () => {
    expect((await search({ companyUuid, query: "Needle", scope: "group", scopeUuid: hidden, entityTypes: ["project_group"], auth: auth("outsider") })).results).toEqual([]);
    expect(fixture.prisma.project.findMany.mock.calls.some(([args]) => args.where.groupUuid === hidden)).toBe(false);
  });

  it("group-only access disappears live while independent project discovery survives", async () => {
    fixture.groupMembers.splice(0, Infinity);
    expect((await search({ companyUuid, query: hidden, entityTypes: ["project_group"], auth: auth("group-viewer") })).results).toEqual([]);
    expect((await search({ companyUuid, query: hidden, entityTypes: ["project_group"], auth: auth("project-only") })).results).toHaveLength(1);
  });

  it("never crosses company scope", async () => {
    expect((await search({ companyUuid: "other-company", query: hidden, entityTypes: ["project_group"], auth: { ...auth("admin"), companyUuid: "other-company" } })).results).toEqual([]);
  });
});
