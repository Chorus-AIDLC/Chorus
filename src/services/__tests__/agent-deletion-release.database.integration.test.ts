/**
 * Opt-in real persistence test for agent deletion releasing unfinished work.
 * Use ONLY an isolated, already migrated test database:
 * AGENT_DELETION_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5447/chorus \
 * pnpm exec vitest run src/services/__tests__/agent-deletion-release.database.integration.test.ts
 *
 * Only the Prisma singleton and the event bus are injected; deleteAgent,
 * releaseAgentAssignments and the activity service are production code. Each
 * case owns its tenants and removes only their fixtures.
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
// Bypass Vitest's generated-client alias, which is a unit-test stub.
import { PrismaClient } from "../../generated/prisma/client";

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/prisma", () => ({ get prisma() { return state.db; } }));
const events = vi.hoisted(() => ({ emit: vi.fn(), emitChange: vi.fn() }));
vi.mock("@/lib/event-bus", () => ({
  eventBus: events, controlEventName: (id: string) => `control:${id}`,
}));

const url = process.env.AGENT_DELETION_DATABASE_URL;

describe.skipIf(!url)("agent deletion releases assignments — real PostgreSQL", () => {
  let db: PrismaClient;
  let pool: pg.Pool;
  let deleteAgent: typeof import("../agent.service").deleteAgent;
  let companyUuid: string;
  let foreignCompanyUuid: string;
  let projectUuid: string;
  let foreignProjectUuid: string;
  let agentUuid: string;
  let otherAgentUuid: string;
  let instanceUuid: string;
  const userUuid = randomUUID();

  beforeAll(async () => {
    // One connection: deleteAgent must not need a second one while its
    // transaction is open.
    pool = new pg.Pool({ connectionString: url, max: 1 });
    db = new PrismaClient({ adapter: new PrismaPg(pool) });
    state.db = db;
    ({ deleteAgent } = await import("../agent.service"));
  }, 30_000);

  beforeEach(async () => {
    events.emitChange.mockClear();
    companyUuid = (await db.company.create({ data: { name: `Agent deletion ${randomUUID()}` } })).uuid;
    foreignCompanyUuid = (await db.company.create({ data: { name: `Agent deletion foreign ${randomUUID()}` } })).uuid;
    projectUuid = (await db.project.create({ data: { companyUuid, name: "Agent deletion" } })).uuid;
    foreignProjectUuid = (await db.project.create({ data: { companyUuid: foreignCompanyUuid, name: "Foreign" } })).uuid;
    agentUuid = (await db.agent.create({ data: { companyUuid, name: "Doomed", ownerUuid: userUuid, roles: ["developer_agent"] } })).uuid;
    otherAgentUuid = (await db.agent.create({ data: { companyUuid, name: "Survivor", ownerUuid: userUuid, roles: ["developer_agent"] } })).uuid;
    instanceUuid = (await db.agentInstance.create({ data: { companyUuid, agentUuid, host: "h", cwd: "/w" } })).uuid;
    await db.apiKey.create({ data: { companyUuid, agentUuid, keyHash: randomUUID(), keyPrefix: "cho_test" } });
  });

  afterEach(async () => {
    state.db = db;
    for (const tenant of [{ companyUuid }, { companyUuid: foreignCompanyUuid }]) {
      await db.activity.deleteMany({ where: tenant });
      await db.task.deleteMany({ where: tenant });
      await db.proposal.deleteMany({ where: tenant });
      await db.idea.deleteMany({ where: tenant });
      await db.apiKey.deleteMany({ where: tenant });
      await db.agentInstance.deleteMany({ where: tenant });
      await db.agent.deleteMany({ where: tenant });
      await db.project.deleteMany({ where: tenant });
    }
    await db.company.deleteMany({ where: { uuid: { in: [companyUuid, foreignCompanyUuid] } } });
  });

  afterAll(async () => {
    await db?.$disconnect();
    await pool?.end();
  });

  const assigned = (assigneeType: string, assigneeUuid: string) => ({
    assigneeType, assigneeUuid, assignedAt: new Date(), assignedByType: "user", assignedByUuid: userUuid,
    cwdHost: "h", runtimeCwd: "/w", cwdSource: "project_fixed",
  });
  const task = (status: string, assigneeType = "agent", assigneeUuid = agentUuid, extra: Record<string, unknown> = {}) =>
    db.task.create({ data: {
      companyUuid, projectUuid, title: `task ${status}`, status, createdByUuid: userUuid,
      ...assigned(assigneeType, assigneeUuid), ...extra,
    } });
  const idea = (status: string, assigneeType = "agent", assigneeUuid = agentUuid, extra: Record<string, unknown> = {}) =>
    db.idea.create({ data: {
      companyUuid, projectUuid, title: `idea ${status}`, status, createdByUuid: userUuid,
      ...assigned(assigneeType, assigneeUuid), ...extra,
    } });
  const approvedProposal = (ideaUuid: string) => db.proposal.create({ data: {
    companyUuid, projectUuid, title: "p", inputType: "idea", inputUuids: [ideaUuid],
    status: "approved", createdByUuid: userUuid,
  } });

  it("releases unfinished tasks (agent + instance pinned), keeps finished ones, and logs released activities", async () => {
    const t1 = await task("in_progress");
    const t2 = await task("done");
    const t3 = await task("assigned", "agent_instance", instanceUuid);
    const t4 = await task("to_verify", "agent_instance", instanceUuid);
    const t5 = await task("closed");
    const other = await task("assigned", "agent", otherAgentUuid);
    const foreign = await db.task.create({ data: {
      companyUuid: foreignCompanyUuid, projectUuid: foreignProjectUuid, title: "foreign", status: "assigned",
      createdByUuid: userUuid, ...assigned("agent", agentUuid),
    } });

    const deleted = await deleteAgent(companyUuid, agentUuid, userUuid);
    expect(deleted?.uuid).toBe(agentUuid);

    const byUuid = async (uuid: string) => db.task.findUniqueOrThrow({ where: { uuid } });
    for (const released of [t1, t3]) {
      expect(await byUuid(released.uuid)).toMatchObject({
        status: "open", assigneeType: null, assigneeUuid: null, assignedAt: null,
        assignedByType: null, assignedByUuid: null, cwdHost: null, runtimeCwd: null, cwdSource: null,
      });
    }
    expect(await byUuid(t2.uuid)).toMatchObject({ status: "done", assigneeType: "agent", assigneeUuid: agentUuid });
    expect(await byUuid(t4.uuid)).toMatchObject({ status: "to_verify", assigneeType: "agent_instance", assigneeUuid: instanceUuid });
    expect(await byUuid(t5.uuid)).toMatchObject({ status: "closed", assigneeUuid: agentUuid });
    expect(await byUuid(other.uuid)).toMatchObject({ status: "assigned", assigneeUuid: otherAgentUuid });
    expect(await byUuid(foreign.uuid)).toMatchObject({ status: "assigned", assigneeUuid: agentUuid });

    const activities = await db.activity.findMany({ where: { companyUuid, action: "released" } });
    expect(activities.map((a) => a.targetUuid).sort()).toEqual([t1.uuid, t3.uuid].sort());
    for (const a of activities) {
      expect(a).toMatchObject({ actorType: "user", actorUuid: userUuid, targetType: "task", projectUuid });
    }
    expect(await db.activity.count({ where: { companyUuid: foreignCompanyUuid } })).toBe(0);

    expect(await db.agent.findUnique({ where: { uuid: agentUuid } })).toBeNull();
    expect(await db.agentInstance.count({ where: { agentUuid } })).toBe(0);
    expect(await db.apiKey.count({ where: { agentUuid } })).toBe(0);
    expect(events.emitChange).toHaveBeenCalledWith(expect.objectContaining({ entityType: "task", entityUuid: t1.uuid }));
  });

  it("releases non-done ideas with releaseIdea semantics and keeps done ideas", async () => {
    const elaborating = await idea("elaborating", "agent_instance", instanceUuid, {
      elaborationDepth: "standard", elaborationStatus: "pending_answers",
    });
    const building = await idea("elaborated", "agent", agentUuid, { elaborationStatus: "resolved", elaborationDepth: "minimal" });
    const buildingProposal = await approvedProposal(building.uuid);
    // The agent's in_progress task under this proposal is released too, but
    // done-ness is judged on the pre-release snapshot either way.
    await task("in_progress", "agent", otherAgentUuid, { proposalUuid: buildingProposal.uuid });
    const done = await idea("elaborated", "agent", agentUuid, { elaborationStatus: "resolved" });
    const doneProposal = await approvedProposal(done.uuid);
    await task("done", "agent", otherAgentUuid, { proposalUuid: doneProposal.uuid });
    await task("closed", "agent", otherAgentUuid, { proposalUuid: doneProposal.uuid });

    await deleteAgent(companyUuid, agentUuid, userUuid);

    expect(await db.idea.findUniqueOrThrow({ where: { uuid: elaborating.uuid } })).toMatchObject({
      status: "open", assigneeType: null, assigneeUuid: null, elaborationDepth: null, elaborationStatus: null,
      assignedAt: null, assignedByType: null, assignedByUuid: null, cwdHost: null, runtimeCwd: null, cwdSource: null,
    });
    expect(await db.idea.findUniqueOrThrow({ where: { uuid: building.uuid } })).toMatchObject({
      status: "elaborated", elaborationStatus: "resolved", elaborationDepth: "minimal",
      assigneeType: null, assigneeUuid: null,
    });
    expect(await db.idea.findUniqueOrThrow({ where: { uuid: done.uuid } })).toMatchObject({
      status: "elaborated", assigneeType: "agent", assigneeUuid: agentUuid,
    });

    const released = await db.activity.findMany({ where: { companyUuid, action: "released", targetType: "idea" } });
    expect(released.map((a) => a.targetUuid).sort()).toEqual([elaborating.uuid, building.uuid].sort());
    expect(released.every((a) => a.actorType === "user" && a.actorUuid === userUuid)).toBe(true);
  });

  it("leaves assignments intact when the agent delete fails inside the transaction", async () => {
    const t = await task("assigned");
    const i = await idea("elaborating", "agent_instance", instanceUuid, { elaborationStatus: "validating" });
    // Fail the agent delete on the transaction client only.
    state.db = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== "$transaction") return Reflect.get(target, prop, receiver);
        return (fn: (tx: unknown) => Promise<unknown>) => target.$transaction((tx) => fn(new Proxy(tx, {
          get(txTarget, txProp, txReceiver) {
            if (txProp !== "agent") return Reflect.get(txTarget, txProp, txReceiver);
            const agent = Reflect.get(txTarget, txProp, txReceiver) as object;
            return new Proxy(agent, {
              get(a, p, r) {
                if (p === "delete") return async () => { throw new Error("simulated delete failure"); };
                return Reflect.get(a, p, r);
              },
            });
          },
        })));
      },
    });

    await expect(deleteAgent(companyUuid, agentUuid, userUuid)).rejects.toThrow("simulated delete failure");
    state.db = db;

    expect(await db.task.findUniqueOrThrow({ where: { uuid: t.uuid } })).toMatchObject({
      status: "assigned", assigneeType: "agent", assigneeUuid: agentUuid,
    });
    expect(await db.idea.findUniqueOrThrow({ where: { uuid: i.uuid } })).toMatchObject({
      status: "elaborating", elaborationStatus: "validating", assigneeType: "agent_instance", assigneeUuid: instanceUuid,
    });
    expect(await db.activity.count({ where: { companyUuid } })).toBe(0);
    expect(await db.agent.findUnique({ where: { uuid: agentUuid } })).not.toBeNull();
    expect(events.emitChange).not.toHaveBeenCalled();
  });

  it("is company-scoped: deleting from another company finds nothing and touches nothing", async () => {
    const t = await task("in_progress");

    expect(await deleteAgent(foreignCompanyUuid, agentUuid, userUuid)).toBeNull();

    expect(await db.task.findUniqueOrThrow({ where: { uuid: t.uuid } })).toMatchObject({
      status: "in_progress", assigneeUuid: agentUuid,
    });
    expect(await db.agent.findUnique({ where: { uuid: agentUuid } })).not.toBeNull();
  });
});
