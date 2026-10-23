import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "../../generated/prisma/client";
import type { UserAuthContext } from "@/types/auth";
import type { AgentTeamMemberInput } from "@/types/agent-team";

vi.mock("@/generated/prisma/client", async () => import("../../generated/prisma/client"));
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/prisma", () => ({ get prisma() { return state.db; } }));
vi.mock("@/lib/event-bus", () => ({
  eventBus: { emit: vi.fn(), emitChange: vi.fn() }, controlEventName: (uuid: string) => `control:${uuid}`,
}));

describe("agent teams against isolated in-memory PostgreSQL", () => {
  let database: PGlite;
  let server: PGLiteSocketServer;
  let directory: string;
  let pool: pg.Pool;
  let db: PrismaClient;
  let teams: typeof import("../agent-team.service");
  let projectTeams: typeof import("../project-agent-team.service");
  let agents: typeof import("../agent.service");
  let auth: UserAuthContext;
  let otherOwner: UserAuthContext;
  let otherCompany: UserAuthContext;
  let agentUuid: string;
  let secondAgentUuid: string;
  let foreignAgentUuid: string;
  let foreignCompanyAgentUuid: string;

  beforeAll(async () => {
    database = new PGlite();
    const migrations = (await readdir("prisma/migrations")).filter((name) => /^\d/.test(name)).sort();
    for (const migration of migrations) {
      await database.exec(await readFile(join("prisma/migrations", migration, "migration.sql"), "utf8"));
    }
    directory = await mkdtemp(join(tmpdir(), "chorus-agent-team-test-"));
    server = new PGLiteSocketServer({ db: database, path: join(directory, ".s.PGSQL.5432") });
    await server.start();
    pool = new pg.Pool({ host: directory, port: 5432, database: "postgres", user: "postgres", max: 1 });
    db = new PrismaClient({ adapter: new PrismaPg(pool) });
    state.db = db;
    teams = await import("../agent-team.service");
    projectTeams = await import("../project-agent-team.service");
    agents = await import("../agent.service");
  }, 60_000);

  afterAll(async () => {
    await db?.$disconnect();
    await pool?.end();
    await server?.stop();
    await database?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  async function user(companyUuid: string): Promise<UserAuthContext> {
    const created = await db.user.create({ data: { companyUuid, oidcSub: randomUUID() } });
    return { type: "user", companyUuid, actorUuid: created.uuid, workspaceAdmin: true };
  }

  async function agent(owner: UserAuthContext, name: string, roles = ["admin_agent"]) {
    return db.agent.create({ data: { companyUuid: owner.companyUuid, ownerUuid: owner.actorUuid, name, roles } });
  }

  beforeEach(async () => {
    const company = await db.company.create({ data: { name: "Team owner" } });
    const foreign = await db.company.create({ data: { name: "Foreign tenant" } });
    auth = await user(company.uuid);
    otherOwner = await user(company.uuid);
    otherCompany = await user(foreign.uuid);
    agentUuid = (await agent(auth, "Own agent")).uuid;
    secondAgentUuid = (await agent(auth, "Second agent")).uuid;
    foreignAgentUuid = (await agent(otherOwner, "Secret foreign owner agent")).uuid;
    foreignCompanyAgentUuid = (await agent(otherCompany, "Secret foreign tenant agent")).uuid;
  });

  const binding = (agentUuid: string, role: AgentTeamMemberInput["role"] = "development") => ({ agentUuid, role });

  it("persists trimmed metadata, empty teams, multiple members and cross-role reuse", async () => {
    const empty = await teams.createAgentTeam(auth, { name: "  Template  " });
    expect(empty).toMatchObject({ name: "Template", description: "", members: [], ownerUuid: auth.actorUuid, companyUuid: auth.companyUuid });
    expect(empty.createdAt).toBe(new Date(empty.createdAt).toISOString());
    const members = [binding(agentUuid), binding(secondAgentUuid), binding(agentUuid, "review"), binding(agentUuid, "lead")];
    const team = await teams.createAgentTeam(auth, { name: "Template", description: "  Details  ", members });
    expect(team.description).toBe("Details");
    const loaded = await teams.getAgentTeam(auth, team.uuid);
    expect(loaded.members).toHaveLength(4);
    for (const member of loaded.members) {
      expect(member).toEqual({ ...members.find((input) => input.role === member.role && input.agentUuid === member.agentUuid),
        agentName: member.agentUuid === agentUuid ? "Own agent" : "Second agent", eligible: true, missingPermissions: [] });
    }
    expect(await teams.listAgentTeams(auth)).toHaveLength(2);
  });

  it("scopes list, candidates and every CRUD path by both owner and tenant, without admin override", async () => {
    const team = await teams.createAgentTeam(auth, { name: "Private", members: [binding(agentUuid)] });
    await teams.createAgentTeam(otherOwner, { name: "Other owner's template" });
    await teams.createAgentTeam(otherCompany, { name: "Other tenant's template" });
    expect((await teams.listAgentTeams(auth)).map((item) => item.uuid)).toEqual([team.uuid]);
    expect((await teams.listAgentTeamCandidates(auth)).map((item) => item.uuid).sort()).toEqual([agentUuid, secondAgentUuid].sort());
    for (const caller of [otherOwner, otherCompany, { ...auth, companyUuid: otherCompany.companyUuid }]) {
      await expect(teams.getAgentTeam(caller, team.uuid)).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(teams.updateAgentTeam(caller, team.uuid, { name: "" })).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(teams.deleteAgentTeam(caller, team.uuid)).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    expect((await teams.getAgentTeam(auth, team.uuid)).name).toBe("Private");
  });

  it("rejects non-human service callers before accessing metadata", async () => {
    for (const type of ["agent", "super_admin"] as const) {
      const caller = { ...auth, type };
      for (const operation of [
        () => teams.listAgentTeams(caller), () => teams.listAgentTeamCandidates(caller),
        () => teams.getAgentTeam(caller, "bad"), () => teams.createAgentTeam(caller, null),
        () => teams.updateAgentTeam(caller, "bad", null), () => teams.deleteAgentTeam(caller, "bad"),
      ]) await expect(operation()).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
  });

  it("returns not found for malformed and missing team UUIDs before validating PATCH input", async () => {
    for (const uuid of ["bad-id", "", "' OR 1=1", randomUUID()]) {
      await expect(teams.getAgentTeam(auth, uuid)).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(teams.updateAgentTeam(auth, uuid, null)).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(teams.deleteAgentTeam(auth, uuid)).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
  });

  it("rejects foreign and missing agent references identically without revealing metadata", async () => {
    for (const uuid of [foreignAgentUuid, foreignCompanyAgentUuid, randomUUID()]) {
      await expect(teams.createAgentTeam(auth, { name: "Invalid", members: [binding(uuid)] }))
        .rejects.toMatchObject({ code: "VALIDATION_ERROR", message: "Invalid team members", details: undefined });
    }
    expect(await teams.listAgentTeams(auth)).toEqual([]);
  });

  it.each([
    ["null", null], ["array", []], ["missing name", {}], ["blank name", { name: "  " }],
    ["non-string name", { name: 4 }], ["long name", { name: "x".repeat(101) }],
    ["long description", { name: "X", description: "x".repeat(1001) }],
    ["null description", { name: "X", description: null }],
    ["unknown field", { name: "X", ownerUuid: randomUUID() }],
    ["invalid role", { name: "X", members: [{ role: "pm", agentUuid: randomUUID() }] }],
    ["malformed UUID", { name: "X", members: [binding("bad")] }],
    ["non-string UUID", { name: "X", members: [{ role: "lead", agentUuid: 2 }] }],
    ["unknown member field", { name: "X", members: [{ ...binding(randomUUID()), name: "X" }] }],
    ["non-array members", { name: "X", members: {} }],
    ["null member", { name: "X", members: [null] }],
    ["too many members", { name: "X", members: Array.from({ length: 201 }, () => binding(randomUUID())) }],
  ])("rejects %s atomically", async (_label, input) => {
    await expect(teams.createAgentTeam(auth, input)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(await teams.listAgentTeams(auth)).toEqual([]);
  });

  it("rejects duplicate tuples, including mixed-case UUIDs, and accepts maximum field lengths", async () => {
    for (const uuid of [agentUuid, agentUuid.toUpperCase()]) {
      await expect(teams.createAgentTeam(auth, { name: "Duplicate", members: [binding(agentUuid), binding(uuid)] }))
        .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    }
    const team = await teams.createAgentTeam(auth, { name: "x".repeat(100), description: "x".repeat(1000) });
    expect(team.name).toHaveLength(100);
    expect(team.description).toHaveLength(1000);
  });

  it("computes candidate permissions and actionable role errors without changing permissions or grants", async () => {
    await db.agent.update({ where: { uuid: agentUuid }, data: { roles: ["pm"], permissions: ["task:admin"] } });
    const before = await db.agent.findUnique({ where: { uuid: agentUuid } });
    const candidates = await teams.listAgentTeamCandidates(auth);
    expect(Object.keys(candidates[0]).sort()).toEqual(["effectivePermissions", "name", "uuid"]);
    expect(candidates.find((candidate) => candidate.uuid === agentUuid)?.effectivePermissions).toContain("task:admin");
    await expect(teams.createAgentTeam(auth, { name: "Lead", members: [binding(agentUuid, "lead")] }))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR", details: { members: [
        { role: "lead", agentUuid, missingPermissions: ["idea:admin", "proposal:admin"] },
      ] } });
    await teams.createAgentTeam(auth, { name: "Product", members: [binding(agentUuid, "product")] });
    expect(await db.agent.findUnique({ where: { uuid: agentUuid } })).toEqual(before);
    expect(await db.project.count({ where: { companyUuid: auth.companyUuid } })).toBe(0);
  });

  it("accepts the 200-binding boundary with multiple members in every role", async () => {
    const members: AgentTeamMemberInput[] = [];
    for (let index = 0; index < 50; index++) {
      const candidate = await agent(auth, `Candidate ${index}`);
      for (const role of ["product", "development", "review", "lead"] as const) members.push(binding(candidate.uuid, role));
    }
    const team = await teams.createAgentTeam(auth, { name: "Maximum", members });
    expect(team.members).toHaveLength(200);
    expect((await teams.getAgentTeam(auth, team.uuid)).members).toEqual(team.members);
  });

  it("preserves prior metadata and members on failed replacement or invalid PATCH fields", async () => {
    const team = await teams.createAgentTeam(auth, { name: "Before", members: [binding(agentUuid)] });
    await db.agent.update({ where: { uuid: secondAgentUuid }, data: { roles: [], permissions: [] } });
    const invalidInputs = [null, {}, { extra: true }, { name: "After", members: [binding(foreignAgentUuid)] },
      { name: "After", members: [binding(secondAgentUuid)] }, { members: [binding("bad")] },
      { members: [binding(agentUuid), binding(agentUuid)] }];
    for (const input of invalidInputs) {
      await expect(teams.updateAgentTeam(auth, team.uuid, input)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      expect(await teams.getAgentTeam(auth, team.uuid)).toEqual(team);
    }
  });

  it("recomputes drift, retains invalid tuples on edits, permits removal, and rejects re-addition", async () => {
    const members = [binding(agentUuid), binding(secondAgentUuid)];
    const team = await teams.createAgentTeam(auth, { name: "Before downgrade", members });
    await db.agent.update({ where: { uuid: agentUuid }, data: {
      roles: [], permissions: ["idea:read", "proposal:read", "document:read", "task:read", "project:read"],
    } });
    const drifted = await teams.getAgentTeam(auth, team.uuid);
    expect(drifted.members.find((member) => member.agentUuid === agentUuid))
      .toMatchObject({ eligible: false, missingPermissions: ["task:write"] });
    expect((await teams.listAgentTeams(auth))[0].members).toEqual(drifted.members);
    expect((await teams.updateAgentTeam(auth, team.uuid, { name: "Renamed" })).members).toEqual(drifted.members);
    await teams.updateAgentTeam(auth, team.uuid, { description: "Keeps drift", members });
    expect((await teams.updateAgentTeam(auth, team.uuid, { members: [binding(agentUuid)] })).members).toHaveLength(1);
    await expect(teams.updateAgentTeam(auth, team.uuid, { members: [binding(agentUuid), binding(agentUuid, "lead")] }))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect((await teams.updateAgentTeam(auth, team.uuid, { members: [] })).members).toEqual([]);
    await expect(teams.updateAgentTeam(auth, team.uuid, { members: [binding(agentUuid)] }))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR", details: { members: [{ agentUuid, role: "development", missingPermissions: ["task:write"] }] } });
    expect((await teams.getAgentTeam(auth, team.uuid)).members).toEqual([]);
  });

  it("rolls back membership deletion if a subsequent replacement write fails", async () => {
    const team = await teams.createAgentTeam(auth, { name: "Before failure", members: [binding(agentUuid)] });
    const transaction = db.$transaction.bind(db);
    const intercepted = vi.spyOn(db, "$transaction");
    intercepted.mockImplementationOnce((work) => transaction(async (client) => {
      const update = vi.spyOn(client.agentTeam, "update").mockRejectedValueOnce(new Error("Injected write failure"));
      try {
        return await (work as (client: unknown) => Promise<unknown>)(client);
      } finally {
        update.mockRestore();
      }
    }));
    await expect(teams.updateAgentTeam(auth, team.uuid, { name: "After", members: [binding(secondAgentUuid)] }))
      .rejects.toThrow("Injected write failure");
    intercepted.mockRestore();
    expect(await teams.getAgentTeam(auth, team.uuid)).toEqual(team);
  });

  it("validates ownership even for an existing retained tuple and hides foreign agent metadata", async () => {
    const team = await teams.createAgentTeam(auth, { name: "Before transfer", members: [binding(agentUuid)] });
    await db.agent.update({ where: { uuid: agentUuid }, data: { ownerUuid: otherOwner.actorUuid, name: "Foreign now" } });
    expect((await teams.getAgentTeam(auth, team.uuid)).members).toEqual([]);
    await expect(teams.updateAgentTeam(auth, team.uuid, { members: [binding(agentUuid)] }))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR", message: "Invalid team members", details: undefined });
    await teams.updateAgentTeam(auth, team.uuid, { members: [] });
  });

  it("serializes concurrent full replacements without merging sets", async () => {
    const team = await teams.createAgentTeam(auth, { name: "Concurrent" });
    const transaction = vi.spyOn(db, "$transaction");
    await Promise.all([
      teams.updateAgentTeam(auth, team.uuid, { members: [binding(agentUuid)] }),
      teams.updateAgentTeam(auth, team.uuid, { members: [binding(secondAgentUuid)] }),
    ]);
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "Serializable" });
    transaction.mockRestore();
    const loaded = await teams.getAgentTeam(auth, team.uuid);
    expect(loaded.members).toHaveLength(1);
    expect([agentUuid, secondAgentUuid]).toContain(loaded.members[0].agentUuid);
  });

  it("retries serialization conflicts and bounds persistent failures", async () => {
    const transaction = vi.spyOn(db, "$transaction");
    transaction.mockRejectedValueOnce({ code: "P2034" });
    await teams.createAgentTeam(auth, { name: "Retry" });
    expect(transaction).toHaveBeenCalledTimes(2);
    transaction.mockClear();
    transaction.mockRejectedValue({ code: "P2034" });
    await expect(teams.createAgentTeam(auth, { name: "Conflict" })).rejects.toEqual({ code: "P2034" });
    expect(transaction).toHaveBeenCalledTimes(4);
    transaction.mockRestore();
    expect((await teams.listAgentTeams(auth)).map((team) => team.name)).toEqual(["Retry"]);
  });

  it("cascades existing agent-service deletion to memberships while preserving teams and other agents", async () => {
    const first = await teams.createAgentTeam(auth, { name: "First", members: [binding(agentUuid), binding(agentUuid, "review"), binding(secondAgentUuid)] });
    const second = await teams.createAgentTeam(auth, { name: "Second", members: [binding(agentUuid)] });
    await agents.deleteAgent(auth.companyUuid, agentUuid, auth.actorUuid);
    expect(await db.agentTeamMember.count({ where: { agentUuid } })).toBe(0);
    expect((await teams.getAgentTeam(auth, first.uuid)).members).toMatchObject([binding(secondAgentUuid)]);
    expect((await teams.getAgentTeam(auth, second.uuid)).members).toEqual([]);
    expect(await db.agent.count({ where: { uuid: secondAgentUuid } })).toBe(1);
  });

  it("isolates personal project configs and rejects foreign templates, members and machine writes", async () => {
    const project = await db.project.create({ data: { companyUuid: auth.companyUuid, name: "Shared" } });
    const template = await teams.createAgentTeam(auth, { name: "Private", members: [binding(agentUuid, "lead")] });
    const saved = await projectTeams.saveProjectAgentTeam(auth, project.uuid, { templateUuid: template.uuid });
    expect(saved?.roles.lead).toMatchObject([{ agentUuid, eligible: true, online: false, activeCount: 0 }]);
    expect(await projectTeams.getProjectAgentTeam(otherOwner, project.uuid)).toBeNull();
    await expect(projectTeams.getProjectAgentTeam(otherCompany, project.uuid)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(projectTeams.saveProjectAgentTeam(otherOwner, project.uuid, { templateUuid: template.uuid })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(projectTeams.saveProjectAgentTeam(auth, project.uuid, { templateUuid: template.uuid, overrides: { lead: [foreignAgentUuid] } })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    const agentAuth = { type: "agent" as const, actorUuid: agentUuid, companyUuid: auth.companyUuid, ownerUuid: auth.actorUuid };
    expect((await projectTeams.getProjectAgentTeam(agentAuth, project.uuid))?.myRoles).toEqual(["lead"]);
    expect(await projectTeams.getProjectAgentTeam({ ...agentAuth, ownerUuid: undefined }, project.uuid)).toBeNull();
    await expect(projectTeams.saveProjectAgentTeam(agentAuth, project.uuid, { templateUuid: template.uuid })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await projectTeams.deleteProjectAgentTeam(otherOwner, project.uuid);
    expect(await projectTeams.getProjectAgentTeam(auth, project.uuid)).not.toBeNull();
  });

  it("repairs a deleted frozen override member with an explicit empty role", async () => {
    const project = await db.project.create({ data: { companyUuid: auth.companyUuid, name: "Frozen repair" } });
    const template = await teams.createAgentTeam(auth, { name: "Frozen", members: [] });
    await projectTeams.saveProjectAgentTeam(auth, project.uuid, { templateUuid: template.uuid, overrides: { development: [agentUuid] } });
    await teams.deleteAgentTeam(auth, template.uuid);
    await agents.deleteAgent(auth.companyUuid, agentUuid, auth.actorUuid);
    const frozen = await projectTeams.getProjectAgentTeam(auth, project.uuid);
    expect(frozen).toMatchObject({ frozen: true, templateUuid: null, roles: { development: [] }, overrides: { development: [agentUuid] } });
    await expect(projectTeams.saveProjectAgentTeam(auth, project.uuid, {
      templateUuid: null, overrides: { ...frozen?.overrides, product: [] },
    })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await projectTeams.saveProjectAgentTeam(auth, project.uuid, { templateUuid: null, overrides: { development: [] } });
    expect(await projectTeams.getProjectAgentTeam(auth, project.uuid)).toMatchObject({
      frozen: true, templateUuid: null, roles: { development: [] }, overrides: { development: [] },
    });
  });

  it.each(["deleted", "other-owner", "other-company"])("prunes %s frozen inherited members on unrelated saves without relaxing submitted overrides", async (change) => {
    const project = await db.project.create({ data: { companyUuid: auth.companyUuid, name: "Frozen inheritance repair" } });
    const template = await teams.createAgentTeam(auth, { name: "Frozen", members: [binding(agentUuid), binding(secondAgentUuid, "lead")] });
    await projectTeams.saveProjectAgentTeam(auth, project.uuid, { templateUuid: template.uuid });
    await teams.deleteAgentTeam(auth, template.uuid);
    if (change === "deleted") await agents.deleteAgent(auth.companyUuid, agentUuid, auth.actorUuid);
    else await db.agent.update({ where: { uuid: agentUuid }, data: change === "other-owner"
      ? { ownerUuid: otherOwner.actorUuid }
      : { companyUuid: otherCompany.companyUuid, ownerUuid: otherCompany.actorUuid } });
    await db.agent.update({ where: { uuid: secondAgentUuid }, data: { roles: ["developer_agent"] } });
    const frozen = await projectTeams.getProjectAgentTeam(auth, project.uuid);
    expect(frozen).toMatchObject({ frozen: true, overrides: {}, roles: { development: [], lead: [{ agentUuid: secondAgentUuid, eligible: false }] } });
    await projectTeams.saveProjectAgentTeam(auth, project.uuid, { templateUuid: null, overrides: { ...frozen?.overrides, product: [] } });
    expect(await projectTeams.getProjectAgentTeam(auth, project.uuid)).toMatchObject({
      frozen: true, overrides: { product: [] }, roles: { development: [], lead: [{ agentUuid: secondAgentUuid, eligible: false }] },
    });
    expect((await db.projectAgentTeam.findUniqueOrThrow({ where: { projectUuid_ownerUuid: { projectUuid: project.uuid, ownerUuid: auth.actorUuid } } })).snapshot).toMatchObject({ development: [], lead: [secondAgentUuid] });
    for (const invalidUuid of [agentUuid, foreignAgentUuid, foreignCompanyAgentUuid]) {
      await expect(projectTeams.saveProjectAgentTeam(auth, project.uuid, { templateUuid: null, overrides: { development: [invalidUuid] } })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    }
  });

  it("keeps whole-role empty overrides and freezes latest template state, not last read", async () => {
    const project = await db.project.create({ data: { companyUuid: auth.companyUuid, name: "Inheritance" } });
    const template = await teams.createAgentTeam(auth, { name: "Live", members: [binding(agentUuid, "lead"), binding(agentUuid)] });
    await projectTeams.saveProjectAgentTeam(auth, project.uuid, { templateUuid: template.uuid, overrides: { development: [] } });
    await teams.updateAgentTeam(auth, template.uuid, { name: "Latest", members: [binding(secondAgentUuid, "lead"), binding(secondAgentUuid)] });
    await teams.deleteAgentTeam(auth, template.uuid);
    const frozen = await projectTeams.getProjectAgentTeam(auth, project.uuid);
    expect(frozen).toMatchObject({ frozen: true, templateUuid: null, templateName: "Latest", roles: { development: [], lead: [{ agentUuid: secondAgentUuid }] } });
    const reset = await projectTeams.saveProjectAgentTeam(auth, project.uuid, { templateUuid: null, overrides: { lead: [] } });
    expect(reset?.roles.lead).toEqual([]);
    await projectTeams.deleteProjectAgentTeam(auth, project.uuid);
    expect(await projectTeams.getProjectAgentTeam(auth, project.uuid)).toBeNull();
  });

  it("restores latest inheritance and shows removed-lead and permission warnings without assignments", async () => {
    const project = await db.project.create({ data: { companyUuid: auth.companyUuid, name: "Drift" } });
    const template = await teams.createAgentTeam(auth, { name: "Team", members: [binding(agentUuid, "lead")] });
    await projectTeams.saveProjectAgentTeam(auth, project.uuid, { templateUuid: template.uuid, overrides: { lead: [] } });
    await teams.updateAgentTeam(auth, template.uuid, { members: [binding(secondAgentUuid, "lead")] });
    expect((await projectTeams.getProjectAgentTeam(auth, project.uuid))?.roles.lead).toEqual([]);
    expect((await projectTeams.saveProjectAgentTeam(auth, project.uuid, { templateUuid: template.uuid, overrides: {} }))?.roles.lead[0].agentUuid).toBe(secondAgentUuid);
    await db.projectAgentTeam.update({ where: { projectUuid_ownerUuid: { projectUuid: project.uuid, ownerUuid: auth.actorUuid } }, data: { lastLeadAgentUuid: agentUuid } });
    expect((await projectTeams.getProjectAgentTeam(auth, project.uuid))?.handoffWarning).toMatchObject({ agentUuid, reason: "removed_from_lead" });
    await db.agent.update({ where: { uuid: secondAgentUuid }, data: { roles: ["developer"] } });
    const drift = await projectTeams.getProjectAgentTeam(auth, project.uuid);
    expect(drift?.roles.lead[0].eligible).toBe(false);
    expect(drift?.roles.lead[0].missingPermissions).toContain("idea:admin");
    await projectTeams.saveProjectAgentTeam(auth, project.uuid, { templateUuid: template.uuid });
    await projectTeams.saveProjectAgentTeam(auth, project.uuid, { templateUuid: template.uuid, overrides: { lead: [] } });
    await expect(projectTeams.saveProjectAgentTeam(auth, project.uuid, { templateUuid: template.uuid })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("allows empty private viewer configs but does not grant member collaboration rights", async () => {
    const project = await db.project.create({ data: { companyUuid: auth.companyUuid, name: "Private", visibility: "private", createdByUuid: otherOwner.actorUuid } });
    await db.projectMember.create({ data: { companyUuid: auth.companyUuid, projectUuid: project.uuid, userUuid: otherOwner.actorUuid, role: "admin" } });
    await db.projectMember.create({ data: { companyUuid: auth.companyUuid, projectUuid: project.uuid, userUuid: auth.actorUuid, role: "viewer" } });
    const template = await teams.createAgentTeam(auth, { name: "Empty" });
    expect((await projectTeams.saveProjectAgentTeam(auth, project.uuid, { templateUuid: template.uuid }))?.roles.lead).toEqual([]);
    await expect(projectTeams.saveProjectAgentTeam(auth, project.uuid, { templateUuid: template.uuid, overrides: { lead: [agentUuid] } })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await db.projectMember.delete({ where: { projectUuid_userUuid: { projectUuid: project.uuid, userUuid: auth.actorUuid } } });
    await expect(projectTeams.getProjectAgentTeam(auth, project.uuid)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("validates removed inherited tuples on re-add but retains current inherited drift", async () => {
    const project = await db.project.create({ data: { companyUuid: auth.companyUuid, name: "Live retention" } });
    const template = await teams.createAgentTeam(auth, { name: "Team", members: [binding(agentUuid, "lead")] });
    await projectTeams.saveProjectAgentTeam(auth, project.uuid, { templateUuid: template.uuid });
    await teams.updateAgentTeam(auth, template.uuid, { members: [] });
    await db.agent.update({ where: { uuid: agentUuid }, data: { roles: ["developer"] } });
    await expect(projectTeams.saveProjectAgentTeam(auth, project.uuid, { templateUuid: template.uuid, overrides: { lead: [agentUuid] } })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await teams.updateAgentTeam(auth, template.uuid, { members: [binding(secondAgentUuid, "lead")] });
    await db.agent.update({ where: { uuid: secondAgentUuid }, data: { roles: ["developer"] } });
    expect((await projectTeams.saveProjectAgentTeam(auth, project.uuid, { templateUuid: template.uuid, overrides: { development: [] } }))?.roles.lead).toMatchObject([{ agentUuid: secondAgentUuid, eligible: false }]);
  });

  it("freezes the full live union when valid template and override sets exceed 200 combined", async () => {
    const project = await db.project.create({ data: { companyUuid: auth.companyUuid, name: "Large snapshot" } });
    const memberUuids = Array.from({ length: 101 }, () => randomUUID());
    await db.agent.createMany({ data: memberUuids.map((uuid) => ({ uuid, companyUuid: auth.companyUuid, ownerUuid: auth.actorUuid, name: "Member", roles: ["admin_agent"] })) });
    const template = await teams.createAgentTeam(auth, { name: "Team", members: [] });
    await projectTeams.saveProjectAgentTeam(auth, project.uuid, { templateUuid: template.uuid, overrides: { development: memberUuids } });
    await teams.updateAgentTeam(auth, template.uuid, { members: memberUuids.map((uuid) => binding(uuid, "lead")) });
    expect((await projectTeams.getProjectAgentTeam(auth, project.uuid))?.roles.lead).toHaveLength(101);
    await teams.deleteAgentTeam(auth, template.uuid);
    const frozen = await projectTeams.getProjectAgentTeam(auth, project.uuid);
    expect(frozen?.roles.lead).toHaveLength(101);
    expect(frozen?.roles.development).toHaveLength(101);
    expect((await projectTeams.saveProjectAgentTeam(auth, project.uuid, { templateUuid: null, overrides: { development: memberUuids } }))?.roles.lead).toHaveLength(101);
  });

  it("deletes only the scoped template and its bindings, never agents or other teams", async () => {
    const doomed = await teams.createAgentTeam(auth, { name: "Doomed", members: [binding(agentUuid)] });
    const kept = await teams.createAgentTeam(auth, { name: "Kept", members: [binding(agentUuid)] });
    expect(await teams.deleteAgentTeam(auth, doomed.uuid)).toEqual({ deleted: true });
    expect(await db.agentTeamMember.count({ where: { teamUuid: doomed.uuid } })).toBe(0);
    expect((await teams.getAgentTeam(auth, kept.uuid)).members).toHaveLength(1);
    expect(await db.agent.count({ where: { uuid: agentUuid } })).toBe(1);
  });
});
