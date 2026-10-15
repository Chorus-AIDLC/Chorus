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

// Regression for P2014 ("required relation 'IdeaLineage'") on company delete:
// the real Prisma engine emulates the IdeaLineage Restrict under
// relationMode = "prisma", which a mocked client cannot.
describe("company deletion with idea lineage against isolated in-memory PostgreSQL", () => {
  let database: PGlite;
  let server: PGLiteSocketServer;
  let directory: string;
  let pool: pg.Pool;
  let db: PrismaClient;
  let companies: typeof import("../company.service");

  beforeAll(async () => {
    database = new PGlite();
    const migrations = (await readdir("prisma/migrations")).filter((name) => /^\d/.test(name)).sort();
    for (const migration of migrations) {
      await database.exec(await readFile(join("prisma/migrations", migration, "migration.sql"), "utf8"));
    }
    directory = await mkdtemp(join(tmpdir(), "chorus-company-lineage-test-"));
    server = new PGLiteSocketServer({ db: database, path: join(directory, ".s.PGSQL.5432") });
    await server.start();
    pool = new pg.Pool({ host: directory, port: 5432, database: "postgres", user: "postgres", max: 1 });
    db = new PrismaClient({ adapter: new PrismaPg(pool) });
    state.db = db;
    companies = await import("../company.service");
  }, 60_000);

  afterAll(async () => {
    await db?.$disconnect();
    await pool?.end();
    await server?.stop();
    await database?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  const seed = async (name: string) => {
    const company = await db.company.create({ data: { name } });
    const companyUuid = company.uuid;
    const userUuid = (await db.user.create({ data: { companyUuid, oidcSub: name, email: `${name}@test.local`, name } })).uuid;
    const project = async (projectName: string) =>
      (await db.project.create({ data: { companyUuid, name: projectName } })).uuid;
    const idea = async (projectUuid: string, title: string, parentUuid: string | null = null) =>
      (await db.idea.create({ data: { companyUuid, projectUuid, title, parentUuid, createdByUuid: userUuid } })).uuid;
    const first = await project("first");
    const second = await project("second");
    const a = await idea(first, "a");
    const b = await idea(first, "b", a);
    const c = await idea(first, "c", b);
    await idea(first, "flat");
    const d = await idea(second, "d", a);
    return { company, companyUuid, a, b, c, d };
  };

  it("deletes a company holding a multi-level idea tree", async () => {
    const doomed = await seed("doomed");
    const kept = await seed("kept");

    await expect(companies.deleteCompany(doomed.company.id)).resolves.toMatchObject({ uuid: doomed.companyUuid });

    expect(await db.company.count({ where: { uuid: doomed.companyUuid } })).toBe(0);
    expect(await db.project.count({ where: { companyUuid: doomed.companyUuid } })).toBe(0);
    expect(await db.idea.count({ where: { companyUuid: doomed.companyUuid } })).toBe(0);

    const parents = await db.idea.findMany({
      where: { uuid: { in: [kept.b, kept.c, kept.d] } },
      select: { uuid: true, parentUuid: true },
    });
    expect(Object.fromEntries(parents.map((i) => [i.uuid, i.parentUuid]))).toEqual({
      [kept.b]: kept.a,
      [kept.c]: kept.b,
      [kept.d]: kept.a,
    });
  });
});
