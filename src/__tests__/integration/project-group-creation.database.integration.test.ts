import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { PrismaClient, type Prisma } from "../../generated/prisma/client";
import type { AgentAuthContext } from "@/types/auth";

const state = vi.hoisted(() => ({ db: null as unknown, emitChange: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ get prisma() { return state.db; } }));
vi.mock("@/lib/event-bus", () => ({ eventBus: { emitChange: state.emitChange } }));

const url = process.env.PROJECT_GROUP_DATABASE_URL;

describe.skipIf(!url)("visible-name creation — isolated migrated PostgreSQL", () => {
  let pool: pg.Pool;
  let db: PrismaClient;
  let groups: typeof import("@/services/project-group.service");
  let companyUuid: string;
  let foreignCompanyUuid: string;
  let first: string;
  let owner: string;
  let other: string;
  const name = "Exact stored group name";
  const actor = (ownerUuid: string | undefined = owner): AgentAuthContext => ({
    type: "agent", actorUuid: randomUUID(), companyUuid, ownerUuid,
    roles: ["admin"], permissions: ["project:admin"], agentName: "guard test",
  });
  const create = (auth = actor(), visibility: "public" | "private" = "public", groupName = name) =>
    groups.createProjectGroup({ companyUuid, name: groupName, visibility }, auth);

  async function snapshot() {
    const tenant = { companyUuid: { in: [companyUuid, foreignCompanyUuid] } };
    return {
      groups: await db.projectGroup.findMany({ where: tenant, orderBy: { uuid: "asc" } }),
      members: await db.projectGroupMember.findMany({ where: tenant, orderBy: { uuid: "asc" } }),
      comments: await db.comment.findMany({ where: tenant, orderBy: { uuid: "asc" } }),
    };
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 6 });
    db = new PrismaClient({ adapter: new PrismaPg(pool) });
    state.db = db;
    groups = await import("@/services/project-group.service");
  });

  beforeEach(async () => {
    state.db = db;
    state.emitChange.mockClear();
    companyUuid = randomUUID(); foreignCompanyUuid = randomUUID();
    first = randomUUID(); owner = randomUUID(); other = randomUUID();
    await db.company.createMany({ data: [companyUuid, foreignCompanyUuid].map((uuid) => ({ uuid, name: "group guard test" })) });
    await db.user.createMany({ data: [first, owner, other].map((uuid, index) => ({
      uuid, companyUuid, oidcSub: uuid, createdAt: new Date(Date.UTC(2026, 0, index + 1)),
    })) });
  });

  afterEach(async () => {
    state.db = db;
    const tenant = { companyUuid: { in: [companyUuid, foreignCompanyUuid] } };
    await db.comment.deleteMany({ where: tenant });
    await db.projectMember.deleteMany({ where: tenant });
    await db.project.deleteMany({ where: tenant });
    await db.projectGroupMember.deleteMany({ where: tenant });
    await db.projectGroup.deleteMany({ where: tenant });
    await db.user.deleteMany({ where: tenant });
    await db.company.deleteMany({ where: { uuid: tenant.companyUuid } });
  });

  afterAll(async () => { await db?.$disconnect(); await pool?.end(); });

  it.each(["public", "viewer", "editor", "admin", "automatic", "child-viewer", "child-editor", "child-admin", "public-child", "ownerless-public", "ownerless-public-child"])("rejects real %s discovery without writes or disclosure", async (visibility) => {
    const existing = await db.projectGroup.create({ data: {
      companyUuid, name, visibility: ["public", "ownerless-public"].includes(visibility) ? "public" : "private",
    } });
    if (visibility !== "automatic") await db.projectGroupMember.create({ data: {
      companyUuid, groupUuid: existing.uuid, userUuid: other, role: "admin",
    } });
    if (["viewer", "editor", "admin"].includes(visibility)) await db.projectGroupMember.create({ data: {
      companyUuid, groupUuid: existing.uuid, userUuid: owner, role: visibility,
    } });
    if (visibility.includes("child")) {
      const child = await db.project.create({ data: {
        companyUuid, groupUuid: existing.uuid, name: "child", visibility: visibility.includes("public") ? "public" : "private",
      } });
      if (visibility.startsWith("child-")) await db.projectMember.create({ data: {
        companyUuid, projectUuid: child.uuid, userUuid: owner, role: visibility.slice(6),
      } });
    }
    const auth = actor(visibility === "automatic" ? first : owner);
    if (visibility.startsWith("ownerless")) delete auth.ownerUuid;
    const before = await snapshot();
    await expect(create(auth)).rejects.toMatchObject({ code: "CONFLICT", status: 409,
      message: "A visible project group with this name already exists" });
    expect(await snapshot()).toEqual(before);
    expect(state.emitChange).not.toHaveBeenCalled();
  });

  it.each(["hidden", "foreign", "foreign-member", "foreign-child", "ownerless-hidden", "ownerless-automatic"])("allows real %s names without permission widening", async (visibility) => {
    const existing = await db.projectGroup.create({ data: {
      companyUuid: visibility === "foreign" ? foreignCompanyUuid : companyUuid,
      name, visibility: visibility === "foreign" ? "public" : "private",
    } });
    if (visibility !== "ownerless-automatic") await db.projectGroupMember.create({ data: {
      companyUuid: existing.companyUuid, groupUuid: existing.uuid, userUuid: other, role: "admin",
    } });
    if (visibility === "foreign-member") await db.projectGroupMember.create({ data: {
      companyUuid: foreignCompanyUuid, groupUuid: existing.uuid, userUuid: owner, role: "admin",
    } });
    if (visibility === "foreign-child") await db.project.create({ data: {
      companyUuid: foreignCompanyUuid, groupUuid: existing.uuid, name: "foreign child", visibility: "public",
    } });
    const auth = actor();
    if (visibility.startsWith("ownerless")) delete auth.ownerUuid;
    expect(await create(auth)).toMatchObject({ name, visibility: "public" });
    expect(await db.projectGroup.findUnique({ where: { uuid: existing.uuid } })).toEqual(existing);
    expect(await db.projectGroup.count({ where: { name, companyUuid: { in: [companyUuid, foreignCompanyUuid] } } })).toBe(2);
    expect(state.emitChange).toHaveBeenCalledTimes(1);
  });

  it("preserves exact strings, allows renaming, and blocks legacy duplicates beyond twenty tied rows", async () => {
    for (const groupName of ["Exact", "exact", " Exact", "Exact ", "é", "e\u0301"]) {
      expect(await create(actor(), "public", groupName)).toMatchObject({ name: groupName });
    }
    await db.projectGroup.createMany({ data: Array.from({ length: 24 }, (_, index) => ({
      companyUuid, uuid: `guard-${companyUuid}-${String(index).padStart(2, "0")}`,
      name: index >= 22 ? name : `legacy-${index}`, visibility: "public", createdAt: new Date("2025-01-01"),
    })).reverse() });
    const ordered = await groups.listProjectGroups(companyUuid, actor());
    expect(ordered.total).toBe(30);
    expect(ordered.groups.slice(0, 24).map((row) => row.uuid)).toEqual(
      Array.from({ length: 24 }, (_, index) => `guard-${companyUuid}-${String(index).padStart(2, "0")}`),
    );
    const before = await snapshot();
    state.emitChange.mockClear();
    await expect(create()).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await snapshot()).toEqual(before);
    expect(state.emitChange).not.toHaveBeenCalled();
    expect(await groups.updateProjectGroup({ companyUuid, groupUuid: ordered.groups[0].uuid, name }, actor()))
      .toMatchObject({ name });
    expect(await db.projectGroup.count({ where: { companyUuid, name } })).toBe(3);
  });

  it.each((["public", "private"] as const).flatMap((visibility) => [
    { visibility, schedule: "retryable write conflict", delayWrite: true },
    { visibility, schedule: "simultaneous writes, adapter commit conflicts retry", delayWrite: false },
  ]))("overlaps same-owner $visibility creates ($schedule)", async ({ visibility, delayWrite }) => {
    let release!: () => void;
    let reject!: (error: Error) => void;
    let committed!: () => void;
    const barrier = new Promise<void>((resolve, fail) => { release = resolve; reject = fail; });
    const firstCommit = new Promise<void>((resolve) => { committed = resolve; });
    const timer = setTimeout(() => reject(new Error("PostgreSQL guard reads did not overlap")), 4000);
    let arrivals = 0;
    const snapshots: { pid: number; isolation: string }[] = [];
    const failures: unknown[] = [];
    const duplicateReads: unknown[] = [];
    state.db = new Proxy(db, { get(target, property, receiver) {
      if (property !== "$transaction") return Reflect.get(target, property, receiver);
      return async (work: (client: Prisma.TransactionClient) => Promise<unknown>, options: { isolationLevel?: Prisma.TransactionIsolationLevel }) => {
        try {
          const result = await db.$transaction(async (tx) => {
            snapshots.push(...await tx.$queryRaw<{ pid: number; isolation: string }[]>`SELECT pg_backend_pid() AS pid, current_setting('transaction_isolation') AS isolation`);
            const client = new Proxy(tx, { get(transaction, key, transactionReceiver) {
              if (key !== "projectGroup") return Reflect.get(transaction, key, transactionReceiver);
              return new Proxy(tx.projectGroup, { get(model, method, modelReceiver) {
                if (method !== "findFirst") return Reflect.get(model, method, modelReceiver);
                return async (args: Prisma.ProjectGroupFindFirstArgs) => {
                  const result = await tx.projectGroup.findFirst(args);
                  if (Array.isArray(args.where?.AND)) {
                    duplicateReads.push(result);
                    const arrival = ++arrivals;
                    if (arrival <= 2) {
                      if (arrival === 2) release();
                      await barrier;
                      if (arrival === 2 && delayWrite) await firstCommit;
                    }
                  }
                  return result;
                };
              } });
            } });
            return work(client);
          }, options);
          committed();
          return result;
        } catch (error) {
          committed();
          failures.push(error);
          throw error;
        }
      };
    } });
    try {
      const results = await Promise.allSettled([create(actor(), visibility), create(actor(), visibility)]);
      expect(new Set(snapshots.slice(0, 2).map((row) => row.pid)).size).toBe(2);
      expect(snapshots.every((row) => row.isolation === "serializable")).toBe(true);
      expect(duplicateReads.slice(0, 2)).toEqual([null, null]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const rejection = results.find((result) => result.status === "rejected")?.reason;
      expect(duplicateReads.at(-1)).toMatchObject({ uuid: expect.any(String) });
      expect(rejection).toMatchObject({ code: "CONFLICT", status: 409 });
      if (delayWrite) {
        expect(failures).toContainEqual(expect.objectContaining({ code: "P2034" }));
      } else {
        expect(failures.some((failure) => {
          if (typeof failure !== "object" || failure === null) return false;
          return ("code" in failure && failure.code === "P2034")
            || (failure instanceof Error && failure.name === "DriverAdapterError"
              && typeof failure.cause === "object" && failure.cause !== null
              && "kind" in failure.cause && failure.cause.kind === "TransactionWriteConflict");
        })).toBe(true);
      }
      expect(snapshots.length).toBeGreaterThanOrEqual(3);
      const persisted = await snapshot();
      expect(persisted.groups).toHaveLength(1);
      expect(persisted.members).toHaveLength(1);
      expect(persisted.comments).toHaveLength(1);
      expect(state.emitChange).toHaveBeenCalledTimes(1);
    } finally {
      clearTimeout(timer);
      release();
      committed();
      state.db = db;
    }
  });

  it("allows two different owners to create mutually hidden private names", async () => {
    const results = [await create(actor(owner), "private"), await create(actor(other), "private")];
    expect(new Set(results.map((row) => row.uuid)).size).toBe(2);
    expect(await db.projectGroup.count({ where: { companyUuid, name } })).toBe(2);
    expect(state.emitChange).toHaveBeenCalledTimes(2);
  });
});
