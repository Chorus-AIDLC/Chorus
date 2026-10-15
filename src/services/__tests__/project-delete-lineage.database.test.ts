import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "../../generated/prisma/client";
vi.mock("@/generated/prisma/client", async () => import("../../generated/prisma/client"));

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/prisma", () => ({ get prisma() { return state.db; } }));
vi.mock("@/lib/event-bus", () => ({ eventBus: { emit: vi.fn(), emitChange: vi.fn(), emitProjectAccessChanged: vi.fn() } }));

// Regression for the production P2014 ("required relation 'IdeaLineage'"):
// the real Prisma engine emulates Project → Idea Cascade and the IdeaLineage
// Restrict under relationMode = "prisma", which a mocked client cannot.
describe("project deletion with idea lineage against isolated in-memory PostgreSQL", () => {
  let database: PGlite;
  let server: PGLiteSocketServer;
  let directory: string;
  let pool: pg.Pool;
  let db: PrismaClient;
  let projects: typeof import("../project.service");
  let groups: typeof import("../project-group.service");
  let companyUuid: string;
  let userUuid: string;
  const auth = () => ({ type: "user" as const, companyUuid, actorUuid: userUuid });

  beforeAll(async () => {
    database = new PGlite();
    const migrations = (await readdir("prisma/migrations")).filter((name) => /^\d/.test(name)).sort();
    for (const migration of migrations) {
      await database.exec(await readFile(join("prisma/migrations", migration, "migration.sql"), "utf8"));
    }
    directory = await mkdtemp(join(tmpdir(), "chorus-lineage-test-"));
    server = new PGLiteSocketServer({ db: database, path: join(directory, ".s.PGSQL.5432") });
    await server.start();
    pool = new pg.Pool({ host: directory, port: 5432, database: "postgres", user: "postgres", max: 1 });
    db = new PrismaClient({ adapter: new PrismaPg(pool) });
    state.db = db;
    projects = await import("../project.service");
    groups = await import("../project-group.service");
    companyUuid = (await db.company.create({ data: { name: "lineage" } })).uuid;
    userUuid = (await db.user.create({ data: { companyUuid, oidcSub: "lineage", email: "lineage@test.local", name: "lineage" } })).uuid;
  }, 60_000);

  afterAll(async () => {
    await db?.$disconnect();
    await pool?.end();
    await server?.stop();
    await database?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  const project = async (name: string, groupUuid?: string) =>
    (await projects.createProject({ companyUuid, name, groupUuid, createdByUuid: userUuid, auth: auth() })).uuid;
  const idea = async (projectUuid: string, title: string, parentUuid: string | null = null, company = companyUuid) =>
    (await db.idea.create({ data: { companyUuid: company, projectUuid, title, parentUuid, createdByUuid: userUuid } })).uuid;
  const tree = async (projectUuid: string) => {
    const a = await idea(projectUuid, "a");
    const b = await idea(projectUuid, "b", a);
    await idea(projectUuid, "c", b);
    await idea(projectUuid, "flat");
    return a;
  };
  const parentOf = async (uuid: string) => (await db.idea.findUnique({ where: { uuid } }))?.parentUuid;

  it("deletes a project with a multi-level tree and orphans cross-project children", async () => {
    const doomed = await project("doomed");
    const other = await project("other");
    const root = await tree(doomed);
    const cross = await idea(other, "cross", root);
    const keepRoot = await idea(other, "keep-root");
    const keepChild = await idea(other, "keep-child", keepRoot);
    const foreignCompany = (await db.company.create({ data: { name: "foreign" } })).uuid;
    const foreignProject = (await db.project.create({ data: { companyUuid: foreignCompany, name: "foreign" } })).uuid;
    const foreignRoot = await idea(foreignProject, "f-root", null, foreignCompany);
    const foreignChild = await idea(foreignProject, "f-child", foreignRoot, foreignCompany);

    expect(await projects.deleteProject(companyUuid, doomed, auth())).toBe(true);

    expect(await db.idea.count({ where: { projectUuid: doomed } })).toBe(0);
    expect(await parentOf(cross)).toBeNull();
    expect(await parentOf(keepChild)).toBe(keepRoot);
    expect(await parentOf(foreignChild)).toBe(foreignRoot);
  });

  it("deletes projects without ideas or without lineage", async () => {
    const empty = await project("empty");
    const flat = await project("flat");
    await idea(flat, "x");
    await idea(flat, "y");
    expect(await projects.deleteProject(companyUuid, empty, auth())).toBe(true);
    expect(await projects.deleteProject(companyUuid, flat, auth())).toBe(true);
    expect(await db.idea.count({ where: { projectUuid: flat } })).toBe(0);
  });

  it("deletes a group together with several projects holding idea trees", async () => {
    const group = await groups.createProjectGroup({ companyUuid, name: "with-projects" }, auth());
    const first = await project("g-first", group.uuid);
    const second = await project("g-second", group.uuid);
    await tree(first);
    await tree(second);

    expect(await groups.deleteProjectGroup(companyUuid, group.uuid, true, auth())).toBe(true);

    expect(await db.project.count({ where: { uuid: { in: [first, second] } } })).toBe(0);
    expect(await db.idea.count({ where: { projectUuid: { in: [first, second] } } })).toBe(0);
  });

  it("keeps projects, ideas and lineage when the group is deleted without its projects", async () => {
    const group = await groups.createProjectGroup({ companyUuid, name: "keep-projects" }, auth());
    const kept = await project("kept", group.uuid);
    const root = await idea(kept, "root");
    const child = await idea(kept, "child", root);

    expect(await groups.deleteProjectGroup(companyUuid, group.uuid, false, auth())).toBe(true);

    expect((await db.project.findUnique({ where: { uuid: kept } }))?.groupUuid).toBeNull();
    expect(await parentOf(child)).toBe(root);
  });

  it("rolls the lineage detach back when the delete fails after it", async () => {
    const doomed = await project("rollback");
    const other = await project("rollback-other");
    const root = await idea(doomed, "root");
    const cross = await idea(other, "cross", root);
    // A child in another tenant is outside the company-scoped detach, so the
    // engine's Restrict still fires — after the detach has already run.
    const foreignCompany = (await db.company.create({ data: { name: "foreign-ref" } })).uuid;
    const foreignProject = (await db.project.create({ data: { companyUuid: foreignCompany, name: "foreign-ref" } })).uuid;
    const foreignChild = await idea(foreignProject, "foreign-child", root, foreignCompany);

    await expect(projects.deleteProject(companyUuid, doomed, auth())).rejects.toMatchObject({ code: "P2014" });

    expect(await db.project.count({ where: { uuid: doomed } })).toBe(1);
    expect(await parentOf(cross)).toBe(root);
    expect(await parentOf(foreignChild)).toBe(root);
  });

  it("performs no lineage detach when the permission check rejects the delete", async () => {
    const guarded = await project("guarded");
    const other = await project("guarded-other");
    const root = await idea(guarded, "root");
    const cross = await idea(other, "cross", root);
    const stranger = (await db.user.create({ data: { companyUuid, oidcSub: "stranger", email: "s@test.local", name: "s" } })).uuid;
    await db.project.update({ where: { uuid: guarded }, data: { visibility: "private" } });

    await expect(projects.deleteProject(companyUuid, guarded, { type: "user", companyUuid, actorUuid: stranger }))
      .rejects.toThrow();

    expect(await db.project.count({ where: { uuid: guarded } })).toBe(1);
    expect(await parentOf(cross)).toBe(root);
  });
});
