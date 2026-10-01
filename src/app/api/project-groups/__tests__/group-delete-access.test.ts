// DELETE /api/project-groups/[uuid] ungroups or deletes EVERY project in the
// group, so it must pass manage_project on the full (unfiltered) project set
// before any write. Uses the real project-access.service over an in-memory
// prisma fixture; the group service is stubbed to record writes.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const db = vi.hoisted(() => ({
  projects: [] as { uuid: string; companyUuid: string; visibility: string; groupUuid: string | null }[],
  members: [] as { projectUuid: string; userUuid: string; role: string }[],
}));
const mockGetAuthContext = vi.hoisted(() => vi.fn());
const mockDeleteProjectGroup = vi.hoisted(() => vi.fn(async () => true));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    project: {
      findMany: vi.fn(async ({ where }: { where: { companyUuid: string; groupUuid: string } }) =>
        db.projects.filter((p) => p.companyUuid === where.companyUuid && p.groupUuid === where.groupUuid)
          .map((p) => ({ uuid: p.uuid })),
      ),
      findFirst: vi.fn(async ({ where }: { where: { uuid: string; companyUuid: string } }) => {
        const p = db.projects.find((x) => x.uuid === where.uuid && x.companyUuid === where.companyUuid);
        return p ? { ...p, id: 1, name: "P", description: null, createdByUuid: null, createdAt: new Date(), updatedAt: new Date() } : null;
      }),
    },
    projectMember: {
      findUnique: vi.fn(async ({ where }: { where: { projectUuid_userUuid: { projectUuid: string; userUuid: string } } }) => {
        const k = where.projectUuid_userUuid;
        const m = db.members.find((x) => x.projectUuid === k.projectUuid && x.userUuid === k.userUuid);
        return m ? { role: m.role } : null;
      }),
    },
  },
}));
vi.mock("@/lib/auth", () => ({
  getAuthContext: (...args: unknown[]) => mockGetAuthContext(...args),
  isUser: (auth: { type: string }) => auth.type === "user",
  isAgent: (auth: { type: string }) => auth.type === "agent",
  hasPermission: () => true,
  checkAgentPermission: () => null,
}));
vi.mock("@/services/project-group.service", () => ({
  getProjectGroup: vi.fn(),
  updateProjectGroup: vi.fn(),
  deleteProjectGroup: mockDeleteProjectGroup,
}));

import { DELETE } from "@/app/api/project-groups/[uuid]/route";

const C = "company-1";
const G = "group-1";

async function del(user: string, deleteProjects = false) {
  mockGetAuthContext.mockResolvedValue({ type: "user", companyUuid: C, actorUuid: user });
  const url = `http://localhost:3000/api/project-groups/${G}${deleteProjects ? "?deleteProjects=true" : ""}`;
  return DELETE(new NextRequest(new URL(url), { method: "DELETE" }), { params: Promise.resolve({ uuid: G }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  db.projects = [
    { uuid: "pub", companyUuid: C, visibility: "public", groupUuid: G },
    { uuid: "priv", companyUuid: C, visibility: "private", groupUuid: G },
  ];
  db.members = [
    { projectUuid: "priv", userUuid: "u-admin", role: "admin" },
    { projectUuid: "priv", userUuid: "u-editor", role: "editor" },
    { projectUuid: "priv", userUuid: "u-viewer", role: "viewer" },
  ];
});

describe("DELETE /api/project-groups/[uuid] — private projects in the group", () => {
  it.each([false, true])("non-member gets 404 and nothing is written (deleteProjects=%s)", async (deleteProjects) => {
    const res = await del("u-out", deleteProjects);
    expect(res.status).toBe(404);
    expect(mockDeleteProjectGroup).not.toHaveBeenCalled();
  });

  it.each(["u-viewer", "u-editor"])("%s gets 403 and nothing is written", async (user) => {
    const res = await del(user, true);
    expect(res.status).toBe(403);
    expect(mockDeleteProjectGroup).not.toHaveBeenCalled();
  });

  it("private-project admin can delete the mixed group", async () => {
    const res = await del("u-admin", true);
    expect(res.status).toBe(200);
    expect(mockDeleteProjectGroup).toHaveBeenCalledWith(C, G, true);
  });
});

describe("DELETE /api/project-groups/[uuid] — unchanged where only public projects are affected", () => {
  it("public-only group stays open to any company member", async () => {
    db.projects = [{ uuid: "pub", companyUuid: C, visibility: "public", groupUuid: G }];
    expect((await del("u-out")).status).toBe(200);
  });

  it("empty group stays open", async () => {
    db.projects = [];
    expect((await del("u-out")).status).toBe(200);
  });
});
