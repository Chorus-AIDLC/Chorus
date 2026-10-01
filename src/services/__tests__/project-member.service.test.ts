import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AuthContext } from "@/types/auth";

// ===== In-memory store with a per-project lock emulating SELECT … FOR UPDATE =====
interface Row { uuid: string; projectUuid: string; userUuid: string; companyUuid: string; role: string }

const state = vi.hoisted(() => ({
  visibility: "public" as string,
  members: [] as Row[],
  users: new Set<string>(),
  failActivity: false,
  lockChain: Promise.resolve() as Promise<void>,
  lockCalls: 0,
}));

const mockPublish = vi.hoisted(() => vi.fn());
const mockCreateActivityInTx = vi.hoisted(() => vi.fn());
vi.mock("@/services/activity.service", () => ({ createActivityInTx: mockCreateActivityInTx }));

const mockEventBus = vi.hoisted(() => ({ emitChange: vi.fn(), emitProjectAccessChanged: vi.fn() }));
vi.mock("@/lib/event-bus", () => ({ eventBus: mockEventBus }));

const mockAccess = vi.hoisted(() => ({
  requireProjectOperation: vi.fn(),
  requireProjectAccess: vi.fn(),
  invalidateProjectAccessCache: vi.fn(),
}));
vi.mock("@/services/project-access.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/project-access.service")>()),
  ...mockAccess,
}));

// Transactional client: writes go to a working copy that is committed only if
// the callback resolves; $queryRaw (the FOR UPDATE lock) serialises callers.
function makeTx(working: { visibility: string; members: Row[] }, release: { fn?: () => void }) {
  const find = (k: { projectUuid: string; userUuid: string }) =>
    working.members.find((m) => m.projectUuid === k.projectUuid && m.userUuid === k.userUuid) ?? null;
  return {
    $queryRaw: vi.fn(async () => {
      state.lockCalls++;
      const prev = state.lockChain;
      let unlock!: () => void;
      state.lockChain = new Promise<void>((r) => (unlock = r));
      release.fn = unlock;
      await prev;
      // Re-read committed state after acquiring the lock (READ COMMITTED semantics).
      working.visibility = state.visibility;
      working.members = state.members.map((m) => ({ ...m }));
      return [];
    }),
    project: {
      findFirst: vi.fn(async () => ({ visibility: working.visibility })),
      update: vi.fn(async ({ data }: { data: { visibility: string } }) => {
        working.visibility = data.visibility;
        return {};
      }),
    },
    user: {
      findFirst: vi.fn(async ({ where }: { where: { uuid: string } }) => (state.users.has(where.uuid) ? { uuid: where.uuid } : null)),
    },
    projectMember: {
      findUnique: vi.fn(async ({ where }: { where: { projectUuid_userUuid: { projectUuid: string; userUuid: string } } }) => {
        const m = find(where.projectUuid_userUuid);
        return m ? { uuid: m.uuid, role: m.role } : null;
      }),
      create: vi.fn(async ({ data }: { data: Omit<Row, "uuid"> }) => {
        const r = { ...data, uuid: `m-${data.userUuid}` };
        working.members.push(r);
        return { uuid: r.uuid, userUuid: r.userUuid, role: r.role };
      }),
      update: vi.fn(async ({ where, data }: { where: { uuid: string }; data: { role: string } }) => {
        const m = working.members.find((x) => x.uuid === where.uuid)!;
        m.role = data.role;
        return { uuid: m.uuid, userUuid: m.userUuid, role: m.role };
      }),
      delete: vi.fn(async ({ where }: { where: { uuid: string } }) => {
        working.members = working.members.filter((x) => x.uuid !== where.uuid);
        return {};
      }),
      count: vi.fn(async ({ where }: { where: { role: string } }) => working.members.filter((m) => m.role === where.role).length),
      upsert: vi.fn(async ({ where, create, update }: {
        where: { projectUuid_userUuid: { projectUuid: string; userUuid: string } };
        create: Omit<Row, "uuid">;
        update: { role: string };
      }) => {
        const m = find(where.projectUuid_userUuid);
        if (m) m.role = update.role;
        else working.members.push({ ...create, uuid: `m-${create.userUuid}` });
        return {};
      }),
    },
  };
}

const lastTx: { tx?: ReturnType<typeof makeTx> } = {};
const mockPrisma = vi.hoisted(() => ({
  projectMember: { findMany: vi.fn() },
  user: { findMany: vi.fn() },
  $transaction: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));

import {
  listMembers,
  addMember,
  updateMemberRole,
  removeMember,
  setVisibility,
  LastAdminError,
} from "@/services/project-member.service";
import { ProjectAccessDeniedError, ProjectNotFoundError } from "@/services/project-access.service";

const C = "company-1";
const P = "project-1";
const user = (uuid: string): AuthContext => ({ type: "user", companyUuid: C, actorUuid: uuid });
const agentOf = (owner?: string): AuthContext => ({ type: "agent", companyUuid: C, actorUuid: "a-1", ownerUuid: owner });
const row = (userUuid: string, role: string): Row => ({ uuid: `m-${userUuid}`, projectUuid: P, userUuid, companyUuid: C, role });

beforeEach(() => {
  vi.clearAllMocks();
  state.visibility = "private";
  state.members = [row("u-a1", "admin"), row("u-a2", "admin"), row("u-v", "viewer")];
  state.users = new Set(["u-a1", "u-a2", "u-v", "u-new"]);
  state.failActivity = false;
  state.lockChain = Promise.resolve();
  state.lockCalls = 0;

  mockAccess.requireProjectOperation.mockResolvedValue({ uuid: P, accessLevel: "admin" });
  mockAccess.requireProjectAccess.mockResolvedValue({ uuid: P, accessLevel: "viewer" });
  mockCreateActivityInTx.mockImplementation(async () => {
    if (state.failActivity) throw new Error("simulated activity insert failure");
    return { activity: { uuid: "act-1" }, publish: mockPublish };
  });
  mockPrisma.$transaction.mockImplementation(async (cb: (tx: ReturnType<typeof makeTx>) => Promise<unknown>) => {
    const working = { visibility: state.visibility, members: state.members.map((m) => ({ ...m })) };
    const release: { fn?: () => void } = {};
    const tx = makeTx(working, release);
    lastTx.tx = tx;
    try {
      const out = await cb(tx);
      state.visibility = working.visibility;
      state.members = working.members; // commit
      return out;
    } finally {
      release.fn?.();
    }
  });
});

const roles = () => Object.fromEntries(state.members.map((m) => [m.userUuid, m.role]));

describe("listMembers", () => {
  it("requires viewer access and joins user names", async () => {
    mockPrisma.projectMember.findMany.mockResolvedValue([
      { uuid: "m1", userUuid: "u-a1", role: "admin", createdAt: new Date("2026-10-01T00:00:00Z") },
      { uuid: "m2", userUuid: "u-gone", role: "bogus", createdAt: new Date("2026-10-01T00:00:00Z") },
    ]);
    mockPrisma.user.findMany.mockResolvedValue([{ uuid: "u-a1", name: "Ada", email: "ada@x" }]);

    const members = await listMembers(user("u-a1"), P);

    expect(mockAccess.requireProjectAccess).toHaveBeenCalledWith(user("u-a1"), P, "viewer");
    expect(members).toEqual([
      { uuid: "m1", userUuid: "u-a1", name: "Ada", email: "ada@x", role: "admin", createdAt: "2026-10-01T00:00:00.000Z" },
      { uuid: "m2", userUuid: "u-gone", name: null, email: null, role: "viewer", createdAt: "2026-10-01T00:00:00.000Z" },
    ]);
  });
});

describe("authorization", () => {
  it("fast-path 403 opens no transaction", async () => {
    mockAccess.requireProjectOperation.mockRejectedValue(new ProjectAccessDeniedError());
    await expect(addMember(user("u-v"), P, "u-new", "editor")).rejects.toBeInstanceOf(ProjectAccessDeniedError);
    expect(mockAccess.requireProjectOperation).toHaveBeenCalledWith(user("u-v"), P, "manage_members");
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it("re-checks the actor under the lock (actor demoted concurrently → 403, nothing written)", async () => {
    // Fast path passed (mocked), but under the lock u-v is only a viewer.
    await expect(addMember(user("u-v"), P, "u-new", "editor")).rejects.toBeInstanceOf(ProjectAccessDeniedError);
    expect(roles()).not.toHaveProperty("u-new");
    expect(mockEventBus.emitProjectAccessChanged).not.toHaveBeenCalled();
  });

  it("re-check returns 404 when the actor lost all access to a private project", async () => {
    await expect(removeMember(user("u-outsider"), P, "u-v")).rejects.toBeInstanceOf(ProjectNotFoundError);
    expect(roles()).toHaveProperty("u-v");
  });

  it("agents act through their owner", async () => {
    await addMember(agentOf("u-a1"), P, "u-new", "viewer");
    expect(roles()["u-new"]).toBe("viewer");
    expect(lastTx.tx!.projectMember.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ addedByUuid: "u-a1" }),
    }));
  });
});

describe("addMember", () => {
  it("rejects invalid roles", async () => {
    await expect(addMember(user("u-a1"), P, "u-new", "owner" as never)).rejects.toMatchObject({ status: 400 });
  });

  it("rejects users from another company", async () => {
    await expect(addMember(user("u-a1"), P, "u-foreign", "viewer")).rejects.toMatchObject({ status: 400 });
    expect(lastTx.tx!.user.findFirst).toHaveBeenCalledWith({ where: { uuid: "u-foreign", companyUuid: C }, select: { uuid: true } });
  });

  it("rejects duplicates with 409", async () => {
    await expect(addMember(user("u-a1"), P, "u-v", "editor")).rejects.toMatchObject({ status: 409 });
  });

  it("writes the member and its Activity in one locked transaction, then publishes", async () => {
    await addMember(user("u-a1"), P, "u-new", "editor");

    expect(state.lockCalls).toBe(1);
    expect(roles()["u-new"]).toBe("editor");
    expect(mockCreateActivityInTx).toHaveBeenCalledWith(lastTx.tx, expect.objectContaining({
      targetType: "project", targetUuid: P, actorType: "user", actorUuid: "u-a1",
      action: "project_member_added", value: { userUuid: "u-new", role: "editor" },
    }));
    expect(mockPublish).toHaveBeenCalledTimes(1);
    expect(mockEventBus.emitProjectAccessChanged).toHaveBeenCalledWith({ companyUuid: C, projectUuid: P, userUuids: ["u-new"] });
    expect(mockAccess.invalidateProjectAccessCache).toHaveBeenCalledWith(user("u-a1"), P);
  });
});

describe("updateMemberRole", () => {
  it("404s an unknown member", async () => {
    await expect(updateMemberRole(user("u-a1"), P, "u-x", "viewer")).rejects.toMatchObject({ status: 404 });
  });

  it("is a no-op when the role is unchanged", async () => {
    await updateMemberRole(user("u-a1"), P, "u-v", "viewer");
    expect(mockCreateActivityInTx).not.toHaveBeenCalled();
    expect(mockEventBus.emitProjectAccessChanged).not.toHaveBeenCalled();
  });

  it("demotes an admin while another admin remains", async () => {
    await updateMemberRole(user("u-a1"), P, "u-a2", "editor");
    expect(roles()["u-a2"]).toBe("editor");
    expect(mockCreateActivityInTx).toHaveBeenCalledWith(lastTx.tx, expect.objectContaining({
      action: "project_member_role_changed", value: { userUuid: "u-a2", fromRole: "admin", toRole: "editor" },
    }));
  });

  it("blocks demoting the last admin and rolls back", async () => {
    state.members = [row("u-a1", "admin")];
    const err = await updateMemberRole(user("u-a1"), P, "u-a1", "editor").catch((e) => e);
    expect(err).toBeInstanceOf(LastAdminError);
    expect(err.status).toBe(400);
    expect(roles()["u-a1"]).toBe("admin");
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it("concurrent self-demotions of the last two admins: exactly one succeeds", async () => {
    const results = await Promise.allSettled([
      updateMemberRole(user("u-a1"), P, "u-a1", "editor"),
      updateMemberRole(user("u-a2"), P, "u-a2", "editor"),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(state.members.filter((m) => m.role === "admin")).toHaveLength(1);
  });
});

describe("removeMember", () => {
  it("removes a non-admin member", async () => {
    await removeMember(user("u-a1"), P, "u-v");
    expect(roles()).not.toHaveProperty("u-v");
    expect(mockCreateActivityInTx).toHaveBeenCalledWith(lastTx.tx, expect.objectContaining({ action: "project_member_removed" }));
    expect(mockEventBus.emitProjectAccessChanged).toHaveBeenCalledWith({ companyUuid: C, projectUuid: P, userUuids: ["u-v"] });
  });

  it("404s an unknown member", async () => {
    await expect(removeMember(user("u-a1"), P, "u-x")).rejects.toMatchObject({ status: 404 });
  });

  it("blocks removing the last admin", async () => {
    state.members = [row("u-a1", "admin")];
    await expect(removeMember(user("u-a1"), P, "u-a1")).rejects.toBeInstanceOf(LastAdminError);
    expect(roles()).toHaveProperty("u-a1");
  });

  it("concurrent self-removals of the last two admins: exactly one succeeds", async () => {
    const results = await Promise.allSettled([
      removeMember(user("u-a1"), P, "u-a1"),
      removeMember(user("u-a2"), P, "u-a2"),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(state.members.filter((m) => m.role === "admin")).toHaveLength(1);
  });
});

describe("Activity failure rolls back every access change and announces nothing", () => {
  beforeEach(() => {
    state.failActivity = true;
  });

  it("removeMember (viewer keeps membership)", async () => {
    await expect(removeMember(user("u-a1"), P, "u-v")).rejects.toThrow("simulated activity insert failure");
    expect(roles()).toHaveProperty("u-v", "viewer");
    expect(mockEventBus.emitProjectAccessChanged).not.toHaveBeenCalled();
    expect(mockAccess.invalidateProjectAccessCache).not.toHaveBeenCalled();
  });

  it("addMember", async () => {
    await expect(addMember(user("u-a1"), P, "u-new", "editor")).rejects.toThrow();
    expect(roles()).not.toHaveProperty("u-new");
    expect(mockEventBus.emitProjectAccessChanged).not.toHaveBeenCalled();
  });

  it("updateMemberRole", async () => {
    await expect(updateMemberRole(user("u-a1"), P, "u-v", "editor")).rejects.toThrow();
    expect(roles()["u-v"]).toBe("viewer");
    expect(mockEventBus.emitProjectAccessChanged).not.toHaveBeenCalled();
  });

  it("setVisibility", async () => {
    await expect(setVisibility(user("u-a1"), P, "public")).rejects.toThrow();
    expect(state.visibility).toBe("private");
    expect(mockEventBus.emitProjectAccessChanged).not.toHaveBeenCalled();
  });
});

describe("setVisibility", () => {
  it("requires change_visibility on the fast path", async () => {
    mockAccess.requireProjectOperation.mockRejectedValue(new ProjectAccessDeniedError());
    await expect(setVisibility(user("u-v"), P, "public")).rejects.toBeInstanceOf(ProjectAccessDeniedError);
    expect(mockAccess.requireProjectOperation).toHaveBeenCalledWith(user("u-v"), P, "change_visibility");
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it("non-admin is rejected under the lock on a public project (cannot flip it private)", async () => {
    state.visibility = "public";
    await expect(setVisibility(user("u-nobody"), P, "private")).rejects.toBeInstanceOf(ProjectAccessDeniedError);
    expect(state.visibility).toBe("public");
  });

  it("rejects invalid values and ownerless agents", async () => {
    await expect(setVisibility(user("u-a1"), P, "secret" as never)).rejects.toMatchObject({ status: 400 });
    state.visibility = "public";
    await expect(setVisibility(agentOf(undefined), P, "private")).rejects.toMatchObject({ status: 400 });
    expect(state.visibility).toBe("public");
  });

  it("is a no-op when unchanged", async () => {
    await setVisibility(user("u-a1"), P, "private");
    expect(mockCreateActivityInTx).not.toHaveBeenCalled();
    expect(mockEventBus.emitProjectAccessChanged).not.toHaveBeenCalled();
  });

  it("public → private keeps the actor (agent → owner) as admin, atomically with its Activity", async () => {
    state.visibility = "public";
    await setVisibility(agentOf("u-a1"), P, "private");
    expect(state.visibility).toBe("private");
    expect(roles()["u-a1"]).toBe("admin");
    expect(mockCreateActivityInTx).toHaveBeenCalledWith(lastTx.tx, expect.objectContaining({
      actorType: "agent", action: "project_visibility_changed",
      value: { fromVisibility: "public", toVisibility: "private" },
    }));
    expect(mockEventBus.emitProjectAccessChanged).toHaveBeenCalledWith({ companyUuid: C, projectUuid: P, userUuids: [] });
    expect(mockPublish).toHaveBeenCalledTimes(1);
  });

  it("private → public keeps membership rows", async () => {
    await setVisibility(user("u-a1"), P, "public");
    expect(state.visibility).toBe("public");
    expect(state.members).toHaveLength(3);
  });
});
