import { beforeEach, describe, expect, it, vi } from "vitest";
import { fixture, auth, group, groupMember, project, localMember } from "./project-group.fixture";
import type { AgentAuthContext } from "@/types/auth";
import type { ProjectAccessClient } from "@/services/project-access.service";

vi.mock("@/lib/prisma", async () => ({ prisma: (await import("./project-group.fixture")).fixture.prisma }));
vi.mock("@/lib/event-bus", async () => ({ eventBus: (await import("./project-group.fixture")).events }));
vi.mock("@/services/activity.service", () => ({ createActivityInTx: vi.fn(async () => ({ publish: vi.fn() })) }));

import { createProjectGroup, listProjectGroups, updateProjectGroup } from "@/services/project-group.service";
import { accessibleGroupWhere } from "@/services/project-group-access.service";

const transaction = fixture.prisma.$transaction.getMockImplementation();
const agent = (ownerUuid?: string): AgentAuthContext => ({
  type: "agent", actorUuid: "agent", companyUuid: "c", ownerUuid,
  roles: ["admin"], permissions: ["project:admin"], agentName: "test",
});
const create = (name = "existing", actor = agent("local")) => createProjectGroup({ companyUuid: "c", name }, actor);
const serializationError = () => Object.assign(new Error("serialization failure"), { code: "P2034" });
const adapterConflict = () => Object.assign(new Error("TransactionWriteConflict"), {
  name: "DriverAdapterError", cause: { kind: "TransactionWriteConflict" },
});

beforeEach(() => {
  vi.clearAllMocks();
  fixture.reset();
  fixture.prisma.$transaction.mockImplementation(transaction);
});

describe("exact visible-name creation guard", () => {
  it.each(["public", "viewer", "editor", "admin", "automatic", "child-viewer", "child-editor", "child-admin", "public-child"])("rejects %s visibility without writes or events", async (visibility) => {
    group("existing", visibility === "public" ? "public" : "private", visibility !== "automatic");
    if (["viewer", "editor", "admin"].includes(visibility)) groupMember("existing", "local", visibility);
    if (visibility.startsWith("child-")) {
      project("child", "existing");
      localMember("child", "local", visibility.slice(6));
    }
    if (visibility === "public-child") project("child", "existing", "public");
    const before = structuredClone(fixture.state);
    await expect(create("existing", agent(visibility === "automatic" ? "admin" : "local")))
      .rejects.toMatchObject({ code: "CONFLICT", status: 409, message: "A visible project group with this name already exists" });
    expect(fixture.state).toEqual(before);
    expect(fixture.writes).toEqual([]);
    expect(fixture.events).toEqual([]);
    expect(fixture.prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it.each(["hidden", "foreign", "foreign-member", "foreign-child", "agent-only"])("allows %s names without widening project:admin access", async (visibility) => {
    group("existing", visibility === "foreign" ? "public" : "private");
    if (visibility === "foreign") fixture.state.projectGroup[0].companyUuid = "foreign";
    if (visibility === "foreign-member") {
      groupMember("existing", "local", "admin");
      fixture.state.projectGroupMember[1].companyUuid = "foreign";
    }
    if (visibility === "foreign-child") {
      project("child", "existing", "public");
      fixture.state.project[0].companyUuid = "foreign";
    }
    if (visibility === "agent-only") groupMember("existing", "agent", "admin");
    const existing = structuredClone(fixture.state.projectGroup[0]);
    expect(await create()).toMatchObject({ name: "existing", visibility: "public" });
    expect(fixture.state.projectGroup[0]).toEqual(existing);
    expect(fixture.state.projectGroup).toHaveLength(2);
    expect(fixture.events).toHaveLength(1);
  });

  it.each(["public", "public-child", "hidden", "automatic", "agent-only"])("keeps ownerless %s visibility", async (visibility) => {
    group("existing", visibility === "public" ? "public" : "private", visibility !== "automatic");
    if (visibility === "public-child") project("child", "existing", "public");
    if (visibility === "agent-only") groupMember("existing", "agent", "admin");
    if (["public", "public-child"].includes(visibility)) {
      await expect(create("existing", agent())).rejects.toMatchObject({ code: "CONFLICT", status: 409 });
      expect(fixture.writes).toEqual([]);
      expect(fixture.events).toEqual([]);
    } else {
      expect(await create("existing", agent())).toMatchObject({ explicitRole: null });
      expect(fixture.state.projectGroupMember.filter((member) => member.groupUuid !== "existing")).toEqual([]);
    }
  });

  it.each(["Existing", " existing", "existing ", "EXISTING", "é", "e\u0301"])("stores %j without normalization", async (name) => {
    group("existing", "public");
    if (name === "e\u0301") fixture.state.projectGroup[0].name = "é";
    expect(await create(name)).toMatchObject({ name });
  });

  it("finds legacy duplicates beyond the first twenty without changing them", async () => {
    for (let index = 0; index < 24; index++) group(`group-${index}`, "public");
    fixture.state.projectGroup[22].name = "existing";
    fixture.state.projectGroup[23].name = "existing";
    const before = structuredClone(fixture.state);
    await expect(create()).rejects.toMatchObject({ code: "CONFLICT" });
    expect(fixture.state).toEqual(before);
    expect(fixture.writes).toEqual([]);
  });

  it("does not guard renaming", async () => {
    group("existing"); group("rename");
    expect(await updateProjectGroup({ companyUuid: "c", groupUuid: "rename", name: "existing" }, auth()))
      .toMatchObject({ name: "existing" });
    expect(fixture.state.projectGroup.map((row) => row.name)).toEqual(["existing", "existing"]);
  });

  it("orders tied dates by uuid, with createdAt as the primary key", async () => {
    for (const uuid of ["z", "b", "a"]) group(uuid, "public");
    fixture.state.projectGroup.forEach((row) => { row.createdAt = new Date("2026-01-02"); });
    fixture.state.projectGroup[0].createdAt = new Date("2026-01-01");
    expect((await listProjectGroups("c", agent("local"))).groups.map((row) => row.uuid)).toEqual(["z", "a", "b"]);
  });
});

describe("Serializable creation attempts", () => {
  it("bypasses cached first-user discovery and uses the transaction client throughout the guard", async () => {
    const actor = agent("local");
    await accessibleGroupWhere(actor);
    const transactionUser = vi.fn(async () => ({ uuid: "local" }));
    const transactionGroup = vi.fn(async () => null);
    const client = { ...fixture.prisma, user: { ...fixture.prisma.user, findFirst: transactionUser },
      projectGroup: { ...fixture.prisma.projectGroup, findFirst: transactionGroup } };
    fixture.prisma.$transaction.mockImplementationOnce(async (work: (client: ProjectAccessClient) => Promise<unknown>) => transaction(() => work(client as ProjectAccessClient)));
    await create("new", actor);
    expect(transactionUser).toHaveBeenCalledTimes(2);
    expect(transactionGroup).toHaveBeenCalledWith({
      where: { AND: [{ companyUuid: "c", OR: expect.arrayContaining([
        { members: { none: { companyUuid: "c", role: "admin" } } },
      ]) }, { name: "new" }] }, select: { uuid: true },
    });
    expect(fixture.prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "Serializable" });
    expect(fixture.events).toMatchObject([{ inTransaction: false }]);
  });

  it.each([1, 3])("retries %s P2034 failures then commits and emits once", async (failures) => {
    const failure = serializationError();
    let attempts = 0;
    fixture.prisma.$transaction.mockImplementation((work: (client: ProjectAccessClient) => Promise<unknown>) => transaction(async (client: ProjectAccessClient) => {
      const result = await work({ ...client });
      if (attempts++ < failures) throw failure;
      return result;
    }));
    await create();
    expect(fixture.prisma.$transaction).toHaveBeenCalledTimes(failures + 1);
    expect(fixture.prisma.user.findFirst.mock.calls.filter(([query]: [{ orderBy?: unknown }]) => query.orderBy)).toHaveLength(failures + 1);
    expect(fixture.state.projectGroup).toHaveLength(1);
    expect(fixture.state.projectGroupMember).toHaveLength(1);
    expect(fixture.state.comment).toHaveLength(1);
    expect(fixture.events).toMatchObject([{ inTransaction: false, data: { action: "created" } }]);
  });

  it("rechecks a competing committed duplicate after P2034", async () => {
    fixture.prisma.$transaction.mockImplementationOnce(async () => {
      group("existing", "public");
      throw serializationError();
    });
    await expect(create()).rejects.toMatchObject({ code: "CONFLICT", status: 409 });
    expect(fixture.prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(fixture.writes).toEqual([]);
    expect(fixture.events).toEqual([]);
  });

  it("surfaces the original fourth failure with no committed writes/events", async () => {
    const failures = Array.from({ length: 4 }, serializationError);
    let attempts = 0;
    fixture.prisma.$transaction.mockImplementation((work: (client: ProjectAccessClient) => Promise<unknown>) => transaction(async (client: ProjectAccessClient) => {
      await work(client);
      throw failures[attempts++];
    }));
    await expect(create()).rejects.toBe(failures[3]);
    expect(fixture.prisma.$transaction).toHaveBeenCalledTimes(4);
    expect(fixture.state.projectGroup).toEqual([]);
    expect(fixture.state.projectGroupMember).toEqual([]);
    expect(fixture.state.comment).toEqual([]);
    expect(fixture.events).toEqual([]);
  });

  it.each(["P2002", "P2028", "40001", undefined])("does not retry non-P2034 error %s", async (code) => {
    const failure = Object.assign(new Error("infrastructure error"), { code });
    fixture.prisma.$transaction.mockRejectedValueOnce(failure);
    await expect(create()).rejects.toBe(failure);
    expect(fixture.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(fixture.events).toEqual([]);
  });

  it("retries a code-less adapter commit conflict and commits only once", async () => {
    const failure = adapterConflict();
    fixture.prisma.$transaction.mockImplementationOnce((work: (client: ProjectAccessClient) => Promise<unknown>) => transaction(async (client: ProjectAccessClient) => {
      await work({ ...client });
      throw failure;
    }));
    await create();
    expect(fixture.prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(fixture.state.projectGroup).toHaveLength(1);
    expect(fixture.state.projectGroupMember).toHaveLength(1);
    expect(fixture.state.comment).toHaveLength(1);
    expect(fixture.events).toMatchObject([{ inTransaction: false, data: { action: "created" } }]);
  });

  it("rechecks a competing committed duplicate after a code-less adapter conflict", async () => {
    fixture.prisma.$transaction.mockImplementationOnce(async () => {
      group("existing", "public");
      throw adapterConflict();
    });
    await expect(create()).rejects.toMatchObject({ code: "CONFLICT", status: 409 });
    expect(fixture.prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(fixture.writes).toEqual([]);
    expect(fixture.events).toEqual([]);
  });

  it("bounds code-less adapter conflict retries and preserves the final failure", async () => {
    const failures = Array.from({ length: 4 }, adapterConflict);
    let attempts = 0;
    fixture.prisma.$transaction.mockImplementation((work: (client: ProjectAccessClient) => Promise<unknown>) => transaction(async (client: ProjectAccessClient) => {
      await work(client);
      throw failures[attempts++];
    }));
    await expect(create()).rejects.toBe(failures[3]);
    expect(fixture.prisma.$transaction).toHaveBeenCalledTimes(4);
    expect(fixture.state.projectGroup).toEqual([]);
    expect(fixture.state.projectGroupMember).toEqual([]);
    expect(fixture.state.comment).toEqual([]);
    expect(fixture.events).toEqual([]);
  });

  it.each([
    Object.assign(new Error("other adapter failure"), { name: "DriverAdapterError", cause: { kind: "ConnectionClosed" } }),
    Object.assign(new Error("unrecognized wrapper"), { cause: { kind: "TransactionWriteConflict" } }),
    Object.assign(new Error("missing cause"), { name: "DriverAdapterError" }),
    null,
    "TransactionWriteConflict",
  ])("does not retry unrelated errors %#", async (failure) => {
    fixture.prisma.$transaction.mockRejectedValueOnce(failure);
    await expect(create()).rejects.toBe(failure);
    expect(fixture.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(fixture.events).toEqual([]);
  });

  it.each(["projectGroup", "projectGroupMember", "comment"])("rolls back %s write failure without retry or event", async (table) => {
    fixture.failWrite = table;
    const before = structuredClone(fixture.state);
    await expect(create()).rejects.toThrow(`forced ${table} failure`);
    expect(fixture.state).toEqual(before);
    expect(fixture.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(fixture.events).toEqual([]);
  });
});
