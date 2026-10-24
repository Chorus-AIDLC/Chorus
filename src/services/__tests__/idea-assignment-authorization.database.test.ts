import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient, type Prisma } from "../../generated/prisma/client";
import type { AuthContext } from "@/types/auth";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

vi.mock("@/generated/prisma/client", async () => import("../../generated/prisma/client"));
const state = vi.hoisted(() => ({ db: null as unknown, emit: vi.fn(), emitChange: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ get prisma() { return state.db; } }));
vi.mock("@/lib/event-bus", () => ({ eventBus: { emit: state.emit, emitChange: state.emitChange } }));

describe("Idea assignment authority against isolated PostgreSQL", () => {
  let database: PGlite;
  let server: PGLiteSocketServer;
  let directory: string;
  let pool: pg.Pool;
  let db: PrismaClient;
  let service: typeof import("../idea-assignment-authorization.service");
  let auth: AuthContext;
  let executor: AuthContext;
  let first: AuthContext;
  let second: AuthContext;
  let projectUuid: string;
  let legacyBefore: Record<string, unknown>[];
  let legacyAfter: Record<string, unknown>[];
  const day = 24 * 60 * 60 * 1000;

  beforeAll(async () => {
    database = new PGlite();
    for (const migration of (await readdir("prisma/migrations")).filter((name) => /^\d/.test(name)).sort()) {
      const sql = await readFile(join("prisma/migrations", migration, "migration.sql"), "utf8");
      if (sql.includes('ADD COLUMN "teamEnrollmentVersion"')) {
        const companyUuid = randomUUID();
        const ownerUuid = randomUUID();
        const oldProjectUuid = randomUUID();
        const leadUuid = randomUUID();
        const productUuid = randomUUID();
        await database.query('INSERT INTO "Company" ("uuid", "name", "updatedAt") VALUES ($1, $2, NOW())', [companyUuid, "Before migration"]);
        await database.query('INSERT INTO "User" ("uuid", "companyUuid", "oidcSub") VALUES ($1, $2, $3)', [ownerUuid, companyUuid, randomUUID()]);
        await database.query('INSERT INTO "Project" ("uuid", "companyUuid", "name", "updatedAt", "createdByUuid") VALUES ($1, $2, $3, NOW(), $4)', [oldProjectUuid, companyUuid, "Legacy", ownerUuid]);
        for (const managed of [false, true]) {
          await database.query(`INSERT INTO "Idea" ("uuid", "companyUuid", "projectUuid", "title", "createdByUuid", "updatedAt", "assigneeType", "assigneeUuid", "assignedAt", "assignedByType", "assignedByUuid", "teamOwnerUuid", "teamLeadAgentUuid", "teamProductAgentUuid")
            VALUES ($1, $2, $3, $4, $5, NOW(), $6, $7, $8, $9, $10, $11, $12, $13)`,
          [randomUUID(), companyUuid, oldProjectUuid, managed ? "Legacy managed" : "Legacy idle", ownerUuid,
            managed ? "agent" : null, managed ? leadUuid : null, managed ? new Date("2026-01-01") : null,
            managed ? "user" : null, managed ? ownerUuid : null, managed ? ownerUuid : null, managed ? leadUuid : null, managed ? productUuid : null]);
        }
        legacyBefore = (await database.query<Record<string, unknown>>('SELECT * FROM "Idea" ORDER BY "uuid"')).rows;
      }
      await database.exec(sql);
    }
    legacyAfter = (await database.query<Record<string, unknown>>('SELECT * FROM "Idea" ORDER BY "uuid"')).rows;
    directory = await mkdtemp(join(tmpdir(), "chorus-idea-assignment-test-"));
    server = new PGLiteSocketServer({ db: database, path: join(directory, ".s.PGSQL.5432") });
    await server.start();
    pool = new pg.Pool({ host: directory, port: 5432, database: "postgres", user: "postgres", max: 1 });
    db = new PrismaClient({ adapter: new PrismaPg(pool) });
    state.db = db;
    service = await import("../idea-assignment-authorization.service");
  }, 60_000);

  afterAll(async () => {
    await db?.$disconnect();
    await pool?.end();
    await server?.stop();
    await database?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  afterEach(() => vi.restoreAllMocks());

  async function agent(name: string, owner = auth, permissions = ["idea:write"]): Promise<AuthContext> {
    const created = await db.agent.create({ data: { companyUuid: owner.companyUuid, ownerUuid: owner.actorUuid, name, roles: [], permissions } });
    return { type: "agent", companyUuid: owner.companyUuid, actorUuid: created.uuid, ownerUuid: owner.actorUuid };
  }

  async function owner(): Promise<AuthContext> {
    const created = await db.user.create({ data: { companyUuid: auth.companyUuid, oidcSub: randomUUID() } });
    return { type: "user", companyUuid: auth.companyUuid, actorUuid: created.uuid };
  }

  async function bindTeam(human: AuthContext, lead: AuthContext) {
    const template = await db.agentTeam.create({ data: {
      companyUuid: human.companyUuid, ownerUuid: human.actorUuid, name: "Optional default lead",
      members: { create: [{ role: "lead", agentUuid: lead.actorUuid }] },
    } });
    await db.projectAgentTeam.create({ data: {
      companyUuid: human.companyUuid, ownerUuid: human.actorUuid, projectUuid,
      templateUuid: template.uuid, templateName: template.name, snapshot: {},
    } });
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    const company = await db.company.create({ data: { name: "Isolated assignment" } });
    const human = await db.user.create({ data: { companyUuid: company.uuid, oidcSub: randomUUID() } });
    auth = { type: "user", companyUuid: company.uuid, actorUuid: human.uuid };
    executor = await agent("Clay", auth, ["idea:read", "idea:write", "idea:admin"]);
    first = await agent("Leo");
    second = await agent("Tom");
    projectUuid = (await db.project.create({ data: { companyUuid: company.uuid, name: "Assignment project", createdByUuid: human.uuid } })).uuid;
    await bindTeam(auth, executor);
  });

  async function idea(data: Partial<Prisma.IdeaUncheckedCreateInput> = {}) {
    return db.idea.create({ data: { companyUuid: auth.companyUuid, projectUuid, title: "Assignment", createdByUuid: auth.actorUuid, ...data } });
  }

  function assignment(ideaUuid: string, agentUuid = first.actorUuid) {
    return { ideaUuid, assigneeType: "agent" as const, assigneeUuid: agentUuid, operationUuid: randomUUID() };
  }

  async function command(ideaUuid: string, author = auth, content = `chorus:assign ${first.actorUuid}`) {
    return db.comment.create({ data: { companyUuid: author.companyUuid, targetType: "idea", targetUuid: ideaUuid, authorType: author.type, authorUuid: author.actorUuid, content } });
  }

  async function proof(ideaUuid: string) {
    const source = await command(ideaUuid);
    const authorization = await service.issueIdeaAssignmentAuthorization(executor, { ideaUuid, agentUuid: first.actorUuid, commentUuid: source.uuid });
    return { source, authorization, input: { ...assignment(ideaUuid), humanAuthorizationUuid: authorization.uuid } };
  }

  async function snapshot(ideaUuid: string) {
    return {
      idea: await db.idea.findUniqueOrThrow({ where: { uuid: ideaUuid } }),
      proofs: await db.ideaAssignmentAuthorization.findMany({ where: { ideaUuid }, orderBy: { uuid: "asc" } }),
      operations: await db.ideaAssignmentOperation.findMany({ where: { ideaUuid }, orderBy: { uuid: "asc" } }),
      activities: await db.activity.findMany({ where: { targetUuid: ideaUuid }, orderBy: { uuid: "asc" } }),
    };
  }

  async function rejectsUnchanged(ideaUuid: string, run: () => Promise<unknown>, status = 403) {
    const before = await snapshot(ideaUuid);
    state.emit.mockClear();
    state.emitChange.mockClear();
    await expect(run()).rejects.toMatchObject({ status });
    expect(await snapshot(ideaUuid)).toEqual(before);
    expect(state.emit).not.toHaveBeenCalled();
    expect(state.emitChange).not.toHaveBeenCalled();
  }

  it("adds zero-version metadata without rewriting legacy assignment or activating historical Ideas", async () => {
    expect(legacyBefore).toHaveLength(2);
    expect(legacyAfter).toHaveLength(2);
    for (const previous of legacyBefore) {
      expect(legacyAfter.find((row) => row.uuid === previous.uuid)).toEqual({
        ...previous, teamEnrollmentVersion: 0, teamGeneration: 0, teamEnrolledAt: null, teamEnrolledByUuid: null, teamAssignmentChangedAt: null,
      });
    }
    expect(await idea()).toMatchObject({ teamEnrollmentVersion: 0, teamGeneration: 0, teamEnrolledAt: null, teamEnrolledByUuid: null, teamAssignmentChangedAt: null });
    expect(state.emit).not.toHaveBeenCalled();
    expect(await db.ideaAssignmentAuthorization.count()).toBe(0);
    expect(await db.ideaAssignmentOperation.count()).toBe(0);
  });

  it("lets one human independently enroll two non-member, non-lead agents with only idea:write", async () => {
    const alpha = await idea();
    const beta = await idea();
    for (const [source, target] of [[alpha, first], [beta, second]] as const) {
      const result = await service.assignIdeaWithAuthority(auth, assignment(source.uuid, target.actorUuid));
      expect(result).toMatchObject({ replayed: false, kickoff: true, activityUuid: expect.any(String), idea: {
        uuid: source.uuid, assigneeType: "agent", assigneeUuid: target.actorUuid, status: "elaborating",
        teamEnrollmentVersion: 1, teamGeneration: 1, teamOwnerUuid: auth.actorUuid,
        teamLeadAgentUuid: target.actorUuid, teamEnrolledByUuid: auth.actorUuid, teamEnrolledAt: expect.any(Date),
      } });
      expect(await db.idea.findUniqueOrThrow({ where: { uuid: source.uuid } })).toEqual(result.idea);
    }
    expect((await db.idea.findUniqueOrThrow({ where: { uuid: alpha.uuid } })).teamLeadAgentUuid).toBe(first.actorUuid);
    expect(await db.agentTeamMember.count({ where: { agentUuid: { in: [first.actorUuid, second.actorUuid] } } })).toBe(0);
    expect(state.emit.mock.calls.filter(([event]) => event === "activity")).toHaveLength(2);
  });

  it("keeps cross-owner assignment inactive until the receiving owner confirms", async () => {
    const receiver = await owner();
    const foreign = await agent("Receiver's agent", receiver);
    await bindTeam(receiver, foreign);
    const source = await idea();
    await service.assignIdeaWithAuthority(auth, assignment(source.uuid));
    const result = await service.assignIdeaWithAuthority(auth, assignment(source.uuid, foreign.actorUuid));
    expect(result).toMatchObject({ kickoff: false, idea: {
      assigneeUuid: foreign.actorUuid, teamGeneration: 2, teamOwnerUuid: null, teamLeadAgentUuid: null, teamEnrolledAt: null, teamEnrolledByUuid: null,
    } });
    const confirmed = await service.assignIdeaWithAuthority(receiver, assignment(source.uuid, foreign.actorUuid));
    expect(confirmed).toMatchObject({ kickoff: true, idea: { teamGeneration: 3, teamOwnerUuid: receiver.actorUuid, teamLeadAgentUuid: foreign.actorUuid } });
  });

  it("allows unproven agent assignment without activating, refreshing, or clearing a managed guard", async () => {
    const source = await idea();
    const unproven = await service.assignIdeaWithAuthority(executor, assignment(source.uuid));
    expect(unproven).toMatchObject({ kickoff: false, idea: { assigneeUuid: first.actorUuid, teamEnrollmentVersion: 0, teamOwnerUuid: null, teamEnrolledAt: null } });
    const enrolled = await service.assignIdeaWithAuthority(auth, assignment(source.uuid));
    await db.idea.update({ where: { uuid: source.uuid }, data: { teamProductAgentUuid: second.actorUuid } });
    const repeated = await service.assignIdeaWithAuthority(executor, assignment(source.uuid));
    expect(repeated).toMatchObject({ kickoff: false, idea: { teamGeneration: enrolled.idea.teamGeneration, teamProductAgentUuid: second.actorUuid, teamEnrolledAt: enrolled.idea.teamEnrolledAt, teamAssignmentChangedAt: enrolled.idea.teamAssignmentChangedAt } });
    const changed = await service.assignIdeaWithAuthority(executor, assignment(source.uuid, second.actorUuid));
    expect(changed).toMatchObject({ kickoff: false, idea: {
      assigneeUuid: second.actorUuid, teamGeneration: enrolled.idea.teamGeneration + 1, teamEnrollmentVersion: 1,
      teamOwnerUuid: auth.actorUuid, teamLeadAgentUuid: first.actorUuid, teamProductAgentUuid: null,
    } });
  });

  it("requires current idea:admin even when the agent supplies real human consent", async () => {
    const source = await idea();
    const issued = await proof(source.uuid);
    await rejectsUnchanged(source.uuid, () => service.assignIdeaWithAuthority(first, issued.input));
    await rejectsUnchanged(source.uuid, () => service.issueIdeaAssignmentAuthorization(first, { ideaUuid: source.uuid, agentUuid: first.actorUuid, commentUuid: issued.source.uuid }));
  });

  it("mints a source-bound 24-hour proof once and consumes it atomically with executor and human audit identities", async () => {
    const source = await idea();
    const issued = await proof(source.uuid);
    expect(issued.authorization).toMatchObject({ companyUuid: auth.companyUuid, projectUuid, ideaUuid: source.uuid,
      agentUuid: first.actorUuid, humanUuid: auth.actorUuid, generation: 0, sourceUuid: issued.source.uuid,
      sourceType: "comment", sourceDigest: expect.any(String), consumedOperationUuid: null,
    });
    expect(issued.authorization.expiresAt.getTime()).toBe(issued.source.createdAt.getTime() + day);
    expect(await service.issueIdeaAssignmentAuthorization(executor, { ideaUuid: source.uuid, agentUuid: first.actorUuid, commentUuid: issued.source.uuid })).toEqual(issued.authorization);
    expect(state.emit).not.toHaveBeenCalled();
    const result = await service.assignIdeaWithAuthority(executor, issued.input);
    expect(result).toMatchObject({ kickoff: true, replayed: false, idea: {
      assignedByType: "agent", assignedByUuid: executor.actorUuid, teamEnrolledByUuid: auth.actorUuid, teamGeneration: 1,
    } });
    expect(await db.ideaAssignmentAuthorization.findUniqueOrThrow({ where: { uuid: issued.authorization.uuid } })).toMatchObject({ consumedOperationUuid: issued.input.operationUuid });
    expect(await db.activity.findUniqueOrThrow({ where: { uuid: result.activityUuid! } })).toMatchObject({
      actorType: "agent", actorUuid: executor.actorUuid, value: { humanAuthorizerUuid: auth.actorUuid, teamGeneration: 1 },
    });
  });

  it("accepts a bound human confirmation but never an agent-asserted request UUID", async () => {
    const source = await idea();
    const requestUuid = randomUUID();
    await rejectsUnchanged(source.uuid, () => service.issueIdeaAssignmentAuthorization(executor, { ideaUuid: source.uuid, agentUuid: first.actorUuid, requestUuid }));
    const started = Date.now();
    const authorization = await service.issueIdeaAssignmentAuthorization(auth, { ideaUuid: source.uuid, agentUuid: first.actorUuid, requestUuid });
    expect(authorization).toMatchObject({ sourceType: "confirmation", sourceUuid: requestUuid, humanUuid: auth.actorUuid, generation: 0 });
    expect(authorization.expiresAt.getTime()).toBeGreaterThanOrEqual(started + day);
    expect(authorization.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + day);
    expect(await service.issueIdeaAssignmentAuthorization(auth, { ideaUuid: source.uuid, agentUuid: first.actorUuid, requestUuid })).toEqual(authorization);
    const other = await idea();
    await rejectsUnchanged(other.uuid, () => service.issueIdeaAssignmentAuthorization(auth, { ideaUuid: other.uuid, agentUuid: first.actorUuid, requestUuid }));
    expect(await service.assignIdeaWithAuthority(executor, { ...assignment(source.uuid), humanAuthorizationUuid: authorization.uuid })).toMatchObject({ kickoff: true });
  });

  it.each(["prose", "mention", "agent", "other_idea", "other_owner", "predates_assignment"])("rejects %s as a human command source", async (kind) => {
    const source = await idea();
    const author = kind === "agent" ? executor : kind === "other_owner" ? await owner() : auth;
    const text = kind === "prose" ? `Please chorus:assign ${first.actorUuid}` : kind === "mention" ? `@[Leo](agent:${first.actorUuid}) please handle this` : `chorus:assign ${first.actorUuid}`;
    const comment = await command(kind === "other_idea" ? (await idea()).uuid : source.uuid, author, text);
    if (kind === "predates_assignment") await db.idea.update({ where: { uuid: source.uuid }, data: { assignedAt: comment.createdAt } });
    await rejectsUnchanged(source.uuid, () => service.issueIdeaAssignmentAuthorization(executor, { ideaUuid: source.uuid, agentUuid: first.actorUuid, commentUuid: comment.uuid }));
  });

  it("accepts only surrounding whitespace around the standalone command", async () => {
    const source = await idea();
    const comment = await command(source.uuid, auth, ` \nchorus:assign ${first.actorUuid}\n `);
    expect(await service.issueIdeaAssignmentAuthorization(executor, { ideaUuid: source.uuid, agentUuid: first.actorUuid, commentUuid: comment.uuid })).toMatchObject({ sourceUuid: comment.uuid });
  });

  it("keeps an unminted human command invalid after intervening assignment and human release", async () => {
    const source = await idea();
    const consent = await command(source.uuid);
    const request = { ideaUuid: source.uuid, agentUuid: first.actorUuid, commentUuid: consent.uuid };
    const assigned = await service.assignIdeaWithAuthority(auth, assignment(source.uuid, second.actorUuid));
    expect(assigned.idea).toMatchObject({ teamGeneration: 1, teamAssignmentChangedAt: expect.any(Date) });
    await rejectsUnchanged(source.uuid, () => service.issueIdeaAssignmentAuthorization(executor, request));
    const released = await service.assignIdeaWithAuthority(auth, {
      ideaUuid: source.uuid, assigneeType: null, assigneeUuid: null, operationUuid: randomUUID(),
    });
    expect(released).toMatchObject({ kickoff: false, idea: {
      assigneeUuid: null, assignedAt: null, teamGeneration: 2, teamAssignmentChangedAt: expect.any(Date),
    } });
    expect(released.idea.teamAssignmentChangedAt!.getTime()).toBeGreaterThanOrEqual(assigned.idea.teamAssignmentChangedAt!.getTime());
    expect(released.idea.teamAssignmentChangedAt!.getTime()).toBeGreaterThanOrEqual(consent.createdAt.getTime());
    await rejectsUnchanged(source.uuid, () => service.issueIdeaAssignmentAuthorization(executor, request));
    expect(await db.ideaAssignmentAuthorization.count({ where: { ideaUuid: source.uuid } })).toBe(0);
  });

  it.each(["fresh", "already_minted"])("denies an unrelated human editor access to the owner's %s proof", async (kind) => {
    const source = await idea();
    const consent = await command(source.uuid);
    const stranger = await owner();
    await db.projectMember.create({ data: { companyUuid: auth.companyUuid, projectUuid, userUuid: stranger.actorUuid, role: "editor" } });
    const request = { ideaUuid: source.uuid, agentUuid: first.actorUuid, commentUuid: consent.uuid };
    const existing = kind === "already_minted" ? await service.issueIdeaAssignmentAuthorization(auth, request) : null;
    await rejectsUnchanged(source.uuid, () => service.issueIdeaAssignmentAuthorization(stranger, request));
    expect(await db.ideaAssignmentAuthorization.count({ where: { ideaUuid: source.uuid } })).toBe(existing ? 1 : 0);
    const authorized = await service.issueIdeaAssignmentAuthorization(auth, request);
    expect(authorized).toMatchObject({ humanUuid: auth.actorUuid, sourceUuid: consent.uuid });
    if (existing) expect(authorized).toEqual(existing);
  });

  it.each(["edited", "deleted", "timestamp", "author", "target"])("rejects a proof whose comment source was changed: %s", async (kind) => {
    const source = await idea();
    const issued = await proof(source.uuid);
    if (kind === "deleted") await db.comment.delete({ where: { uuid: issued.source.uuid } });
    else await db.comment.update({ where: { uuid: issued.source.uuid }, data:
      kind === "edited" ? { content: "Consent withdrawn" } : kind === "timestamp" ? { updatedAt: new Date(issued.source.updatedAt.getTime() + 1) }
        : kind === "author" ? { authorType: "agent", authorUuid: executor.actorUuid } : { targetUuid: (await idea()).uuid },
    });
    await rejectsUnchanged(source.uuid, () => service.assignIdeaWithAuthority(executor, issued.input));
  });

  it.each(["unknown", "wrong_target", "wrong_idea", "foreign_tenant", "expired", "generation"])("rejects invalid or tampered proof binding: %s", async (kind) => {
    const source = await idea();
    const issued = await proof(source.uuid);
    let input = issued.input;
    let caller = executor;
    if (kind === "unknown") input = { ...input, humanAuthorizationUuid: randomUUID() };
    if (kind === "wrong_target") input = { ...input, assigneeUuid: second.actorUuid };
    if (kind === "wrong_idea") input = { ...input, ideaUuid: (await idea()).uuid };
    if (kind === "foreign_tenant") caller = { ...executor, companyUuid: (await db.company.create({ data: { name: "Foreign" } })).uuid };
    if (kind === "expired") await db.ideaAssignmentAuthorization.update({ where: { uuid: issued.authorization.uuid }, data: { expiresAt: new Date(Date.now() - 1) } });
    if (kind === "generation") await db.idea.update({ where: { uuid: source.uuid }, data: { teamGeneration: { increment: 1 } } });
    await rejectsUnchanged(input.ideaUuid, () => service.assignIdeaWithAuthority(caller, input), kind === "foreign_tenant" ? 404 : 403);
    expect((await db.ideaAssignmentAuthorization.findUniqueOrThrow({ where: { uuid: issued.authorization.uuid } })).consumedOperationUuid).toBeNull();
  });

  it.each(["executor_permission", "executor_owner", "target_owner", "human_inactive", "human_access"])("rechecks current authority before consuming proof: %s", async (kind) => {
    const source = await idea();
    const issued = await proof(source.uuid);
    if (kind === "executor_permission") await db.agent.update({ where: { uuid: executor.actorUuid }, data: { permissions: ["idea:write"] } });
    if (kind === "executor_owner") await db.agent.update({ where: { uuid: executor.actorUuid }, data: { ownerUuid: (await owner()).actorUuid } });
    if (kind === "target_owner") await db.agent.update({ where: { uuid: first.actorUuid }, data: { ownerUuid: (await owner()).actorUuid } });
    if (kind === "human_inactive") await db.user.update({ where: { uuid: auth.actorUuid }, data: { status: "disabled" } });
    if (kind === "human_access") {
      const admin = await owner();
      await db.project.update({ where: { uuid: projectUuid }, data: { visibility: "private" } });
      await db.projectMember.create({ data: { companyUuid: auth.companyUuid, projectUuid, userUuid: admin.actorUuid, role: "admin" } });
    }
    await rejectsUnchanged(source.uuid, () => service.assignIdeaWithAuthority(executor, issued.input));
  });

  it("replays only the exact current operation without another generation, proof use, activity or publication", async () => {
    const source = await idea();
    const issued = await proof(source.uuid);
    const committed = await service.assignIdeaWithAuthority(executor, issued.input);
    const before = await snapshot(source.uuid);
    state.emit.mockClear();
    expect(await service.assignIdeaWithAuthority(executor, issued.input)).toEqual({ ...committed, replayed: true, kickoff: false });
    expect(await snapshot(source.uuid)).toEqual(before);
    expect(state.emit).not.toHaveBeenCalled();
    await rejectsUnchanged(source.uuid, () => service.assignIdeaWithAuthority(executor, { ...issued.input, operationUuid: randomUUID() }));
    await rejectsUnchanged(source.uuid, () => service.assignIdeaWithAuthority(executor, { ...issued.input, assigneeUuid: second.actorUuid }));
    await rejectsUnchanged(source.uuid, () => service.assignIdeaWithAuthority(auth, issued.input));
    await service.assignIdeaWithAuthority(auth, assignment(source.uuid));
    await rejectsUnchanged(source.uuid, () => service.assignIdeaWithAuthority(executor, issued.input));
  });

  it("consumes proof once across competing public calls (PGlite's single socket serializes transactions)", async () => {
    const source = await idea();
    const issued = await proof(source.uuid);
    const inputs = [issued.input, { ...issued.input, operationUuid: randomUUID() }];
    const outcomes = await Promise.allSettled(inputs.map((input) => service.assignIdeaWithAuthority(executor, input)));
    const successes = outcomes.filter((outcome) => outcome.status === "fulfilled");
    const failures = outcomes.filter((outcome) => outcome.status === "rejected");
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0].reason).toMatchObject({ status: 403 });
    const winner = successes[0].value;
    expect(winner).toMatchObject({ replayed: false, kickoff: true, idea: { teamGeneration: 1 } });
    const committed = await snapshot(source.uuid);
    expect(committed.idea).toEqual(winner.idea);
    expect(committed.proofs).toHaveLength(1);
    expect(inputs.map((input) => input.operationUuid)).toContain(committed.proofs[0].consumedOperationUuid);
    expect(committed.operations).toHaveLength(1);
    expect(committed.operations[0]).toMatchObject({ uuid: committed.proofs[0].consumedOperationUuid, generation: 1, activityUuid: winner.activityUuid });
    expect(committed.activities).toHaveLength(1);
    expect(committed.activities[0]).toMatchObject({ uuid: winner.activityUuid, action: "assigned" });
    expect(state.emit).toHaveBeenCalledTimes(1);
    expect(state.emit).toHaveBeenCalledWith("activity", expect.objectContaining({ uuid: winner.activityUuid }));
    expect(state.emitChange).not.toHaveBeenCalled();
  });

  it("increments deliberate same-agent generations, clears delegates and preserves Idea-scoped YOLO", async () => {
    const source = await idea();
    const yolo = await db.activity.create({ data: { companyUuid: auth.companyUuid, projectUuid, targetType: "idea", targetUuid: source.uuid, actorType: "user", actorUuid: auth.actorUuid, action: "yolo_requested" } });
    await service.assignIdeaWithAuthority(auth, assignment(source.uuid));
    await db.idea.update({ where: { uuid: source.uuid }, data: { teamProductAgentUuid: second.actorUuid } });
    const result = await service.assignIdeaWithAuthority(auth, assignment(source.uuid));
    expect(result).toMatchObject({ kickoff: true, idea: { teamGeneration: 2, teamProductAgentUuid: null } });
    expect(await db.activity.findUniqueOrThrow({ where: { uuid: yolo.uuid } })).toEqual(yolo);
  });

  it.each(["user", "release"])("human %s clears enrollment and invalidates outstanding proof", async (kind) => {
    const source = await idea();
    await service.assignIdeaWithAuthority(auth, assignment(source.uuid));
    const authorization = await service.issueIdeaAssignmentAuthorization(auth, { ideaUuid: source.uuid, agentUuid: first.actorUuid });
    const result = await service.assignIdeaWithAuthority(auth, {
      ideaUuid: source.uuid, operationUuid: randomUUID(), assigneeType: kind === "user" ? "user" : null, assigneeUuid: kind === "user" ? auth.actorUuid : null,
    });
    expect(result).toMatchObject({ kickoff: false, idea: { teamGeneration: 2, teamOwnerUuid: null, teamLeadAgentUuid: null, teamEnrolledAt: null, teamEnrolledByUuid: null } });
    await rejectsUnchanged(source.uuid, () => service.assignIdeaWithAuthority(executor, { ...assignment(source.uuid), humanAuthorizationUuid: authorization.uuid }));
  });

  it("does not kickoff a completed proposal/task graph on authorized assignment", async () => {
    const source = await idea({ status: "elaborated", elaborationStatus: "resolved" });
    const proposal = await db.proposal.create({ data: { companyUuid: auth.companyUuid, projectUuid, title: "Delivered", inputType: "idea", inputUuids: [source.uuid], status: "approved", createdByUuid: auth.actorUuid } });
    await db.task.create({ data: { companyUuid: auth.companyUuid, projectUuid, proposalUuid: proposal.uuid, title: "Done", status: "done", createdByUuid: auth.actorUuid } });
    const result = await service.assignIdeaWithAuthority(auth, assignment(source.uuid));
    expect(result).toMatchObject({ kickoff: false, idea: { status: "elaborated", teamGeneration: 1 } });
    expect(await db.activity.count({ where: { targetUuid: source.uuid, action: "assigned" } })).toBe(0);
  });

  it("rolls back two P2034 attempts including proof consumption and publishes only the committed retry", async () => {
    const source = await idea();
    const issued = await proof(source.uuid);
    const original = db.$transaction.bind(db);
    let attempts = 0;
    const transaction = vi.spyOn(db, "$transaction");
    transaction.mockImplementation(((work: (tx: Prisma.TransactionClient) => Promise<unknown>, options: Parameters<typeof db.$transaction>[1]) => original(async (tx) => {
      attempts++;
      expect((await tx.idea.findUniqueOrThrow({ where: { uuid: source.uuid } })).teamGeneration).toBe(0);
      expect((await tx.ideaAssignmentAuthorization.findUniqueOrThrow({ where: { uuid: issued.authorization.uuid } })).consumedOperationUuid).toBeNull();
      expect(await tx.ideaAssignmentOperation.count({ where: { ideaUuid: source.uuid } })).toBe(0);
      expect(await tx.activity.count({ where: { targetUuid: source.uuid } })).toBe(0);
      const result = await work(tx);
      expect((await tx.ideaAssignmentAuthorization.findUniqueOrThrow({ where: { uuid: issued.authorization.uuid } })).consumedOperationUuid).toBe(issued.input.operationUuid);
      expect(await tx.ideaAssignmentOperation.count({ where: { ideaUuid: source.uuid } })).toBe(1);
      expect(await tx.activity.count({ where: { targetUuid: source.uuid } })).toBe(1);
      expect(state.emit).not.toHaveBeenCalled();
      expect(state.emitChange).not.toHaveBeenCalled();
      if (attempts < 3) throw { code: "P2034" };
      return result;
    }, options)) as typeof db.$transaction);
    const result = await service.assignIdeaWithAuthority(executor, issued.input);
    expect(attempts).toBe(3);
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ isolationLevel: "Serializable" }));
    expect(result).toMatchObject({ kickoff: true, idea: { teamGeneration: 1 } });
    const committed = await snapshot(source.uuid);
    expect(committed.operations).toHaveLength(1);
    expect(committed.activities).toHaveLength(1);
    expect(committed.proofs[0].consumedOperationUuid).toBe(issued.input.operationUuid);
    expect(state.emit).toHaveBeenCalledTimes(1);
    expect(state.emit).toHaveBeenCalledWith("activity", expect.objectContaining({ uuid: result.activityUuid, targetUuid: source.uuid, action: "assigned" }));
  });

  it("revalidates the human source after rollback instead of replaying a stale authorization decision", async () => {
    const source = await idea();
    const issued = await proof(source.uuid);
    const before = await snapshot(source.uuid);
    const original = db.$transaction.bind(db);
    let attempts = 0;
    vi.spyOn(db, "$transaction").mockImplementation((async (work: (tx: Prisma.TransactionClient) => Promise<unknown>, options: Parameters<typeof db.$transaction>[1]) => {
      attempts++;
      try {
        return await original(async (tx) => {
          const result = await work(tx);
          if (attempts === 1) throw { code: "P2034" };
          return result;
        }, options);
      } catch (error) {
        if (attempts === 1) await db.comment.update({ where: { uuid: issued.source.uuid }, data: { content: "Authorization withdrawn during conflict" } });
        throw error;
      }
    }) as typeof db.$transaction);
    await expect(service.assignIdeaWithAuthority(executor, issued.input)).rejects.toMatchObject({ status: 403 });
    expect(attempts).toBe(2);
    expect(await snapshot(source.uuid)).toEqual(before);
    expect(state.emit).not.toHaveBeenCalled();
    expect(state.emitChange).not.toHaveBeenCalled();
  });

  it("rejects stale proof after a competing public assignment commits between P2034 attempts", async () => {
    const source = await idea();
    const issued = await proof(source.uuid);
    const competingInput = assignment(source.uuid, second.actorUuid);
    let competingState = await snapshot(source.uuid);
    const original = db.$transaction.bind(db);
    let attempts = 0;
    let runningCompetitor = false;
    vi.spyOn(db, "$transaction").mockImplementation((async (work: (tx: Prisma.TransactionClient) => Promise<unknown>, options: Parameters<typeof db.$transaction>[1]) => {
      if (runningCompetitor) return original(work, options);
      attempts++;
      try {
        return await original(async (tx) => {
          const result = await work(tx);
          if (attempts === 1) {
            expect((await tx.ideaAssignmentAuthorization.findUniqueOrThrow({ where: { uuid: issued.authorization.uuid } })).consumedOperationUuid).toBe(issued.input.operationUuid);
            expect(await tx.ideaAssignmentOperation.count({ where: { ideaUuid: source.uuid } })).toBe(1);
            expect(state.emit).not.toHaveBeenCalled();
            throw { code: "P2034" };
          }
          return result;
        }, options);
      } catch (error) {
        if (attempts === 1) {
          runningCompetitor = true;
          try {
            await service.assignIdeaWithAuthority(auth, competingInput);
            competingState = await snapshot(source.uuid);
          } finally {
            runningCompetitor = false;
          }
        }
        throw error;
      }
    }) as typeof db.$transaction);
    await expect(service.assignIdeaWithAuthority(executor, issued.input)).rejects.toMatchObject({ status: 403 });
    expect(attempts).toBe(2);
    const finalState = await snapshot(source.uuid);
    expect(finalState).toEqual(competingState);
    expect(finalState.idea).toMatchObject({ assigneeUuid: second.actorUuid, teamLeadAgentUuid: second.actorUuid, teamGeneration: 1 });
    expect(finalState.proofs).toHaveLength(1);
    expect(finalState.proofs[0]).toMatchObject({ uuid: issued.authorization.uuid, generation: 0, consumedOperationUuid: null });
    expect(finalState.operations).toHaveLength(1);
    expect(finalState.operations[0]).toMatchObject({ uuid: competingInput.operationUuid, generation: 1 });
    expect(finalState.activities).toHaveLength(1);
    expect(state.emit).toHaveBeenCalledTimes(1);
    expect(state.emit).toHaveBeenCalledWith("activity", expect.objectContaining({ uuid: finalState.activities[0].uuid, actorUuid: auth.actorUuid }));
    expect(state.emitChange).not.toHaveBeenCalled();
  });

  it.each(["actor", "target"])("rolls back assignment and rejects revoked %s project access between P2034 attempts", async (kind) => {
    const source = await idea();
    const otherOwner = await owner();
    const otherAgent = await agent("Other owner's target", otherOwner);
    const issued = kind === "actor" ? await proof(source.uuid) : null;
    const caller = kind === "actor" ? executor : auth;
    const input = issued?.input ?? assignment(source.uuid, otherAgent.actorUuid);
    const before = await snapshot(source.uuid);
    const original = db.$transaction.bind(db);
    let attempts = 0;
    vi.spyOn(db, "$transaction").mockImplementation((async (work: (tx: Prisma.TransactionClient) => Promise<unknown>, options: Parameters<typeof db.$transaction>[1]) => {
      attempts++;
      try {
        return await original(async (tx) => {
          const result = await work(tx);
          if (attempts === 1) {
            expect(await tx.ideaAssignmentOperation.count({ where: { ideaUuid: source.uuid } })).toBe(1);
            expect(await tx.activity.count({ where: { targetUuid: source.uuid } })).toBe(1);
            if (issued) expect((await tx.ideaAssignmentAuthorization.findUniqueOrThrow({ where: { uuid: issued.authorization.uuid } })).consumedOperationUuid).toBe(input.operationUuid);
            expect(state.emit).not.toHaveBeenCalled();
            throw { code: "P2034" };
          }
          return result;
        }, options);
      } catch (error) {
        if (attempts === 1) {
          await db.project.update({ where: { uuid: projectUuid }, data: { visibility: "private" } });
          await db.projectMember.createMany({ data: [
            { companyUuid: auth.companyUuid, projectUuid, userUuid: auth.actorUuid, role: kind === "actor" ? "viewer" : "admin" },
            { companyUuid: auth.companyUuid, projectUuid, userUuid: otherOwner.actorUuid, role: kind === "actor" ? "admin" : "viewer" },
          ] });
        }
        throw error;
      }
    }) as typeof db.$transaction);
    await expect(service.assignIdeaWithAuthority(caller, input)).rejects.toMatchObject({
      status: 403, message: kind === "actor" ? "Project editor access required" : "Assignee project editor access required",
    });
    expect(attempts).toBe(2);
    expect(await snapshot(source.uuid)).toEqual(before);
    expect(state.emit).not.toHaveBeenCalled();
    expect(state.emitChange).not.toHaveBeenCalled();
  });

  it("runs MCP proof preparation and assignment through real services with an idempotent kickoff", async () => {
    const source = await idea();
    const consent = await command(source.uuid);
    const { registerPmTools } = await import("@/mcp/tools/pm");
    type Handler = (input: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>;
    const handlers: Record<string, Handler> = {};
    const server = { registerTool(name: string, _config: unknown, handler: Handler) { handlers[name] = handler; } };
    registerPmTools(server as unknown as McpServer, { ...executor, type: "agent", roles: [], permissions: ["idea:read", "idea:write", "idea:admin"], agentName: "Executor" });
    const prepared = await handlers.chorus_prepare_idea_assignment({ ideaUuid: source.uuid, agentUuid: first.actorUuid, commentUuid: consent.uuid });
    expect(prepared.isError).not.toBe(true);
    const authorization = JSON.parse(prepared.content[0].text);
    const input = { ideaUuid: source.uuid, assigneeType: "agent", assigneeUuid: first.actorUuid, humanAuthorizationUuid: authorization.uuid };
    const assigned = await handlers.chorus_pm_assign_idea(input);
    expect(assigned.isError).not.toBe(true);
    expect(JSON.parse(assigned.content[0].text)).toMatchObject({ wakeRequested: true });
    expect(await db.idea.findUniqueOrThrow({ where: { uuid: source.uuid } })).toMatchObject({ teamEnrollmentVersion: 1, teamGeneration: 1, teamLeadAgentUuid: first.actorUuid });
    const repeated = await handlers.chorus_pm_assign_idea(input);
    expect(repeated.isError).not.toBe(true);
    expect(JSON.parse(repeated.content[0].text)).toMatchObject({ wakeRequested: false });
    expect(await db.activity.count({ where: { targetUuid: source.uuid, action: "assigned" } })).toBe(1);
  });

  it("supports low-permission self-claim without activation and prevents claiming another agent", async () => {
    const source = await idea();
    const input = { ...assignment(source.uuid), claimOnly: true };
    const result = await service.assignIdeaWithAuthority(first, input);
    expect(result).toMatchObject({ kickoff: false, idea: { assigneeUuid: first.actorUuid, teamOwnerUuid: null } });
    expect(await service.assignIdeaWithAuthority(first, input)).toMatchObject({ replayed: true });
    const other = await idea();
    await rejectsUnchanged(other.uuid, () => service.assignIdeaWithAuthority(first, { ...assignment(other.uuid, second.actorUuid), claimOnly: true }));
  });

  it("self-release cannot clear the managed guard or release someone else's Idea", async () => {
    const source = await idea();
    await service.assignIdeaWithAuthority(auth, assignment(source.uuid));
    const input = { ideaUuid: source.uuid, assigneeType: null, assigneeUuid: null, operationUuid: randomUUID(), releaseOwn: true };
    await rejectsUnchanged(source.uuid, () => service.assignIdeaWithAuthority(second, input));
    const result = await service.assignIdeaWithAuthority(first, input);
    expect(result).toMatchObject({ kickoff: false, idea: { assigneeUuid: null, teamOwnerUuid: auth.actorUuid, teamLeadAgentUuid: first.actorUuid } });
  });

  it("runtime-only repinning preserves generation and consent and cannot change the logical owner", async () => {
    const source = await idea();
    const enrolled = await service.assignIdeaWithAuthority(auth, assignment(source.uuid));
    const instance = await db.agentInstance.create({ data: { companyUuid: auth.companyUuid, agentUuid: first.actorUuid, host: "test-host", cwd: "/repo" } });
    const pinned = await service.assignIdeaWithAuthority(auth, { ...assignment(source.uuid), instanceUuid: instance.uuid, pinOnly: true });
    expect(pinned).toMatchObject({ kickoff: false, idea: { assigneeType: "agent_instance", assigneeUuid: instance.uuid, teamGeneration: enrolled.idea.teamGeneration, teamEnrolledAt: enrolled.idea.teamEnrolledAt, teamAssignmentChangedAt: enrolled.idea.teamAssignmentChangedAt } });
    await rejectsUnchanged(source.uuid, () => service.assignIdeaWithAuthority(auth, { ...assignment(source.uuid, second.actorUuid), pinOnly: true }));
  });

  it("creation enrollment can use its existing kickoff without emitting a duplicate assignment wake", async () => {
    const source = await idea();
    const result = await service.assignIdeaWithAuthority(auth, { ...assignment(source.uuid), emitKickoff: false });
    expect(result).toMatchObject({ kickoff: false, idea: { teamEnrollmentVersion: 1, teamOwnerUuid: auth.actorUuid } });
    expect(await db.activity.findUniqueOrThrow({ where: { uuid: result.activityUuid! } })).toMatchObject({ action: "assignment_recorded" });
  });

  it("preserves the ordinary assignment wake for an own agent when no Team is configured", async () => {
    await db.projectAgentTeam.deleteMany({ where: { projectUuid } });
    const source = await idea();
    const result = await service.assignIdeaWithAuthority(auth, assignment(source.uuid));
    expect(result).toMatchObject({ kickoff: true, idea: { assigneeUuid: first.actorUuid, teamOwnerUuid: null, teamLeadAgentUuid: null } });
  });

  it("requires fenced resume for active and retained-paused guards even without session metadata", async () => {
    const source = await idea();
    const { requiresFencedIdeaTeamResume } = await import("../daemon-resume-policy");
    const connectionUuid = randomUUID();
    expect(await requiresFencedIdeaTeamResume(auth.companyUuid, connectionUuid, "idea", source.uuid)).toBe(false);
    await service.assignIdeaWithAuthority(auth, assignment(source.uuid));
    expect(await requiresFencedIdeaTeamResume(auth.companyUuid, connectionUuid, "idea", source.uuid)).toBe(true);
    await service.assignIdeaWithAuthority(first, { ideaUuid: source.uuid, assigneeType: null, assigneeUuid: null, operationUuid: randomUUID(), releaseOwn: true });
    expect(await requiresFencedIdeaTeamResume(auth.companyUuid, connectionUuid, "idea", source.uuid)).toBe(true);
    await service.assignIdeaWithAuthority(auth, { ideaUuid: source.uuid, assigneeType: null, assigneeUuid: null, operationUuid: randomUUID() });
    expect(await requiresFencedIdeaTeamResume(auth.companyUuid, connectionUuid, "idea", source.uuid)).toBe(false);
  });

  it.each(["self_claim", "reassignment"])("keeps a proofless %s round trip paused until human repair", async (mode) => {
    const source = await idea();
    const { getIdeaTeamContext, canReceiveIdeaTeamFence, getIdeaTeamLeadRecipients } = await import("../idea-team.service");
    await service.assignIdeaWithAuthority(auth, assignment(source.uuid));
    if (mode === "self_claim") {
      await service.assignIdeaWithAuthority(first, { ideaUuid: source.uuid, assigneeType: null, assigneeUuid: null, operationUuid: randomUUID(), releaseOwn: true });
    } else {
      await service.assignIdeaWithAuthority(executor, { ...assignment(source.uuid), assigneeUuid: executor.actorUuid });
    }
    const returned = await service.assignIdeaWithAuthority(mode === "self_claim" ? first : executor, { ...assignment(source.uuid), ...(mode === "self_claim" ? { claimOnly: true } : {}) });
    expect(returned).toMatchObject({ kickoff: false, idea: { teamOwnerUuid: auth.actorUuid, teamLeadAgentUuid: first.actorUuid, teamEnrolledAt: null, teamEnrolledByUuid: null } });
    expect(await getIdeaTeamContext(auth, source.uuid)).toMatchObject({ managed: true, state: "paused", reason: "human_assignment_required" });
    const fence = { ideaUuid: source.uuid, generation: returned.idea.teamGeneration, ownerUuid: auth.actorUuid, agentUuid: first.actorUuid, role: "orchestrator" as const };
    expect(await canReceiveIdeaTeamFence(auth.companyUuid, first.actorUuid, fence)).toBe(false);
    expect(await getIdeaTeamLeadRecipients(auth.companyUuid, "idea", source.uuid)).toEqual([]);
    const repaired = await service.assignIdeaWithAuthority(auth, assignment(source.uuid));
    expect(repaired.kickoff).toBe(true);
    expect(await getIdeaTeamContext(auth, source.uuid)).toMatchObject({ state: "active" });
    expect(await canReceiveIdeaTeamFence(auth.companyUuid, first.actorUuid, { ...fence, generation: repaired.idea.teamGeneration })).toBe(true);
  });

  it.each(["P2034", "P2002"])("bounds %s failures without leaving writes or publishing rolled-back work", async (code) => {
    const source = await idea();
    const issued = await proof(source.uuid);
    const before = await snapshot(source.uuid);
    const original = db.$transaction.bind(db);
    const error = { code };
    const transaction = vi.spyOn(db, "$transaction");
    transaction.mockImplementation(((work: (tx: Prisma.TransactionClient) => Promise<unknown>, options: Parameters<typeof db.$transaction>[1]) => original(async (tx): Promise<unknown> => {
      await work(tx);
      throw error;
    }, options)) as typeof db.$transaction);
    await expect(service.assignIdeaWithAuthority(executor, issued.input)).rejects.toBe(error);
    expect(transaction).toHaveBeenCalledTimes(code === "P2034" ? 4 : 1);
    expect(await snapshot(source.uuid)).toEqual(before);
    expect(state.emit).not.toHaveBeenCalled();
    expect(state.emitChange).not.toHaveBeenCalled();
  });
});
