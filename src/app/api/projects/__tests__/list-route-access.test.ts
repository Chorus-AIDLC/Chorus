import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { AuthContext } from "@/types/auth";

const mockGetAuthContext = vi.fn();
const mockFindProjects = vi.fn();
const mockCountProjects = vi.fn();
const mockFindMemberships = vi.fn();

vi.mock("@/lib/auth", async () => ({
  ...await vi.importActual<typeof import("@/lib/auth")>("@/lib/auth"),
  getAuthContext: (...args: unknown[]) => mockGetAuthContext(...args),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    project: { findMany: (...args: unknown[]) => mockFindProjects(...args), count: (...args: unknown[]) => mockCountProjects(...args) },
    projectMember: { findMany: (...args: unknown[]) => mockFindMemberships(...args) },
  },
}));
vi.mock("@/services/project-agent-cwd.service", () => ({
  createProjectWithAgentCwds: vi.fn(),
  CwdServiceError: class extends Error {},
}));

import { GET } from "@/app/api/projects/route";

const projects = [
  { uuid: "hidden", visibility: "private", companyUuid: "company" },
  { uuid: "public", visibility: "public", companyUuid: "company" },
  { uuid: "member", visibility: "private", companyUuid: "company" },
  { uuid: "other-company", visibility: "public", companyUuid: "other" },
].map(p => ({
  ...p, name: p.uuid, description: null, groupUuid: null,
  createdAt: new Date("2026-10-01"), updatedAt: new Date("2026-10-01"),
  _count: { ideas: 1, documents: 2, tasks: 3, proposals: 4 },
  tasks: [{ uuid: "done-task" }],
}));

type ProjectWhere = { companyUuid: string; OR: Array<{ visibility?: { not: string }; uuid?: { in: string[] } }> };
function matching(where: ProjectWhere) {
  // Model the database's filtering before skip/take; a missing visibility
  // constraint would return the hidden row and change the pagination total.
  return projects.filter(p => p.companyUuid === where.companyUuid &&
    (!where.OR || where.OR.some(clause =>
      (clause.visibility && p.visibility !== clause.visibility.not) ||
      clause.uuid?.in.includes(p.uuid))));
}

function get(page = 1) {
  return GET(new NextRequest(`http://localhost/api/projects?page=${page}&pageSize=1`), { params: Promise.resolve({}) });
}

describe("project listings filter before pagination and counts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAuthContext.mockResolvedValue({ type: "user", companyUuid: "company", actorUuid: "nonmember" } satisfies AuthContext);
    mockFindMemberships.mockImplementation(({ where }) => Promise.resolve(
      where.userUuid === "owner" ? [{ projectUuid: "member" }] : [],
    ));
    mockFindProjects.mockImplementation(({ where, skip, take }) => Promise.resolve(matching(where).slice(skip, skip + take)));
    mockCountProjects.mockImplementation(({ where }) => Promise.resolve(matching(where).length));
  });

  it("nonmembers see the public row as page one and cannot infer private rows from totals", async () => {
    const response = await get();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.map((p: { uuid: string }) => p.uuid)).toEqual(["public"]);
    expect(body.meta.total).toBe(1);
    expect(body.data[0]).toMatchObject({ visibility: "public", counts: { ideas: 1, documents: 2, tasks: 3, doneTasks: 1, proposals: 4 } });
    const secondPage = await (await get(2)).json();
    expect(secondPage.data).toEqual([]);
  });

  it("agents inherit only their owner's private memberships", async () => {
    mockGetAuthContext.mockResolvedValue({
      type: "agent", companyUuid: "company", actorUuid: "agent", ownerUuid: "owner",
      roles: ["developer_agent"], permissions: ["project:read"],
    });
    const body = await (await get(2)).json();
    expect(body.data.map((p: { uuid: string }) => p.uuid)).toEqual(["member"]);
    expect(body.meta.total).toBe(2);
    expect(mockFindMemberships).toHaveBeenCalledWith(expect.objectContaining({ where: { companyUuid: "company", userUuid: "owner" } }));
  });

  it("ownerless agents see public projects and do not query memberships", async () => {
    mockGetAuthContext.mockResolvedValue({
      type: "agent", companyUuid: "company", actorUuid: "agent", roles: [], permissions: ["project:read"],
    });
    const body = await (await get()).json();
    expect(body.data.map((p: { uuid: string }) => p.uuid)).toEqual(["public"]);
    expect(body.meta.total).toBe(1);
    expect(mockFindMemberships).not.toHaveBeenCalled();
  });

  it("agent permission denial happens before collection queries", async () => {
    mockGetAuthContext.mockResolvedValue({ type: "agent", companyUuid: "company", actorUuid: "agent", roles: [], permissions: [] });
    expect((await get()).status).toBe(403);
    expect(mockFindProjects).not.toHaveBeenCalled();
    expect(mockCountProjects).not.toHaveBeenCalled();
  });
});
