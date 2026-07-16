// src/__tests__/integration/agent-instance-addressing.integration.test.ts
//
// Integration (pseudo-e2e) lifecycle test for add-agent-instance-addressing — the
// regression safety net the requester explicitly mandated for this large change
// (Tech Design "Test plan → Integration" + the instance-addressed-assignment spec
// scenarios). It validates the INTEGRATION of every prior task in the DAG (T1 entity,
// T2 helpers, T3 daemon-connection, T4 site collapse, T5 idea/task persistence, T6
// wake lineage, T7 mention, T8 API/MCP, T9 UI, T11 column drop) by driving the REAL
// services over the shared in-memory fixture-Prisma (no real DB).
//
// HARNESS (mirrors src/__tests__/integration/cascade-move.integration.test.ts):
//   buildMockPrisma() fixture + vi.hoisted() holder refs + vi.mock() wiring. The
//   stub is the GENERIC in-memory engine in agentInstanceFixture.ts (the cascade
//   fixture's matcher only handles moveIdea's operators; the wake chokepoint needs
//   relations / select / orderBy / compound keys). Only TWO modules are mocked:
//     - @/lib/prisma                          → the in-memory store
//     - @/lib/event-bus                       → no-op emit/emitChange (no SSE)
//     - @/services/daemon-instruction.service → no-op deliverTurnPing (no ping)
//   Everything else under test runs REAL: idea.service, task.service, lineage.service,
//   uuid-resolver (the assignee helpers), idea-tracker.service, daemon-connection.service,
//   daemon-session.service, and notification-turn.createTurnAndResolveTarget.
//
// WHY drive createTurnAndResolveTarget for the wake assertions: resolvePinnedTarget /
// selectOriginConnection are NOT exported, but the chokepoint composes them and surfaces
// the OBSERVABLE wake outcome — `targetConnectionUuid` (the resolved DIRECTED connection)
// and `suppressWake` — so asserting on those exercises the full real pin→inherit→degrade
// resolution rather than re-implementing it.
//
// Lifecycle covered (per task ACs):
//   1. Seed agent X (two online instances A, B) + agent Y (one online instance).
//   2. Assign the idea to instance A → idea.assigneeType = "agent_instance".
//   3. The derived task (agent X, no override) wake resolves to instance A (inherited).
//   4. A cross-agent task (agent Y) in the SAME idea resolves to Y, NOT instance A.
//   5. Take instance A offline → the task wake is NOTIFY-ONLY (HARD pin, owner choice B):
//      NO turn, suppressWake TRUE, NEVER re-routed to agent-X online-first (B).
//   6. Re-assign the idea to instance B → the wake resolves to B.
//   7. Revert the idea to plain agent → the wake resolves online-first (no pin).
//   8. Throughout, the agent's ideaTracker NEVER drops the instance-pinned idea.
//   9. Elaboration-resolve (elaboration_verified) wake on the A-pinned idea targets A.
//  10. Focused regression: a naive flat {assigneeType:"agent",assigneeUuid:actor} query
//      MISSES the agent_instance idea — documenting WHY buildAssigneeMatch exists.

import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  agentInstanceStore,
  resetAgentInstanceStore,
  buildMockPrisma,
  seedAgentInstanceScenario,
  takeInstanceOffline,
  bringInstanceOnline,
  agentAuth,
  type AgentInstanceScenario,
} from "@/__tests__/fixtures/agentInstanceFixture";

// vi.mock factories are hoisted above all imports, so the references inside them
// must come from vi.hoisted() (the cascade-move test does the same).
const { hoistedPrisma } = vi.hoisted(() => ({
  hoistedPrisma: { current: null as unknown },
}));

const mockPrisma = buildMockPrisma();
hoistedPrisma.current = mockPrisma;

vi.mock("@/lib/prisma", () => ({
  get prisma() {
    return hoistedPrisma.current;
  },
}));
// No SSE in the test — emit / emitChange are inert.
vi.mock("@/lib/event-bus", () => ({
  eventBus: { emit: vi.fn(), emitChange: vi.fn() },
  transcriptEventName: (sessionUuid: string) => `transcript:${sessionUuid}`,
}));
// No control-channel ping — the directed-delivery seam is asserted via the
// returned targetConnectionUuid, not via the (fire-and-forget) ping itself.
vi.mock("@/services/daemon-instruction.service", () => ({
  deliverTurnPing: vi.fn(),
}));

import { claimIdea, assignIdea } from "@/services/idea.service";
import { buildIdeaTracker } from "@/services/idea-tracker.service";
import {
  buildAssigneeMatch,
  resolveAssigneeAgentUuid,
} from "@/lib/uuid-resolver";
import { listInstancesForAgent } from "@/services/daemon-connection.service";
import { createTurnAndResolveTarget } from "@/services/notification-turn";

// ===== Wake helpers =====
//
// A `task_assigned` wake on the inherit-task entity (autonomous dispatch). The
// pin comes purely from assignment lineage — the task's own assignee (none here)
// then the root idea's assignee under the same-agent guard.
function taskWake(scenario: AgentInstanceScenario, taskUuid: string, recipientUuid: string) {
  return {
    companyUuid: scenario.companyUuid,
    recipientType: "agent",
    recipientUuid,
    entityType: "task",
    entityUuid: taskUuid,
    action: "task_assigned",
  };
}

// An idea-anchored `elaboration_verified` wake (the Verify-Elaborate → write-the-
// proposal handoff). Reads the idea's own assignee through the root-idea step.
function elaborationVerifiedWake(scenario: AgentInstanceScenario, recipientUuid: string) {
  return {
    companyUuid: scenario.companyUuid,
    recipientType: "agent",
    recipientUuid,
    entityType: "idea",
    entityUuid: scenario.ideaUuid,
    action: "elaboration_verified",
  };
}

// Assert that the agent's idea tracker still contains the pinned idea.
async function trackerHasIdea(actorUuid: string, ideaUuid: string): Promise<boolean> {
  const tracker = await buildIdeaTracker(agentAuth(actorUuid));
  return Object.values(tracker).some((proj) =>
    proj.ideas.some((i) => i.uuid === ideaUuid),
  );
}

beforeEach(() => {
  resetAgentInstanceStore();
  // Do NOT vi.clearAllMocks() — that would wipe the prisma model fn impls.
});

// =====================================================================================

describe("AgentInstance addressing — pin → inherit → degrade → re-pin lifecycle (integration)", () => {
  it("AC#1+#2+#3: assign idea to instance A → derived task (agent X, no override) wake inherits A", async () => {
    const s = seedAgentInstanceScenario();

    // (2) Assign the idea to instance A via the REAL service (the optional
    // instanceUuid promotes the persisted assignment to agent_instance).
    const assigned = await assignIdea({
      ideaUuid: s.ideaUuid,
      companyUuid: s.companyUuid,
      assigneeType: "agent",
      assigneeUuid: s.agentX,
      instanceUuid: s.instanceA,
    });

    // The idea row is now an agent_instance assignment pointing at instance A.
    const ideaRow = agentInstanceStore.ideas.find((i) => i.uuid === s.ideaUuid)!;
    expect(ideaRow.assigneeType).toBe("agent_instance");
    expect(ideaRow.assigneeUuid).toBe(s.instanceA);
    // The formatted response surfaces the instance place + owning agent.
    expect(assigned.assignee?.type).toBe("agent_instance");
    expect(assigned.assignee?.instance).toEqual({
      agentUuid: s.agentX,
      host: s.hostA,
      cwd: s.cwdA,
    });

    // (3) The derived task is assigned to plain agent X (no per-task override).
    // Its wake inherits the root idea's instance A under the same-agent guard.
    const result = await createTurnAndResolveTarget(taskWake(s, s.taskInherit, s.agentX));
    // Directed to instance A's online connection.
    expect(result.targetConnectionUuid).toBe(s.connA);
    expect(result.suppressWake).toBe(false);
    expect(result.turn).not.toBeNull();
  });

  it("AC#1: a per-task override beats the inherited idea instance (task pinned to B → B)", async () => {
    const s = seedAgentInstanceScenario();
    await assignIdea({
      ideaUuid: s.ideaUuid,
      companyUuid: s.companyUuid,
      assigneeType: "agent",
      assigneeUuid: s.agentX,
      instanceUuid: s.instanceA, // idea pinned to A
    });

    // The override task is itself pinned to instance B. The task override wins
    // over the inherited idea instance A.
    const result = await createTurnAndResolveTarget(taskWake(s, s.taskOverride, s.agentX));
    expect(result.targetConnectionUuid).toBe(s.connB);
    expect(result.suppressWake).toBe(false);
  });

  it("AC#1: a cross-agent task (agent Y) in the same A-pinned idea does NOT inherit A (same-agent guard)", async () => {
    const s = seedAgentInstanceScenario();
    await assignIdea({
      ideaUuid: s.ideaUuid,
      companyUuid: s.companyUuid,
      assigneeType: "agent",
      assigneeUuid: s.agentX,
      instanceUuid: s.instanceA,
    });

    // The cross-agent task is assigned to agent Y. The root idea's instance A
    // belongs to agent X, so the same-agent guard blocks inheritance: the wake
    // resolves against agent Y's OWN online-first connection, NOT instance A.
    //
    // This is LOAD-BEARING: agent Y's instance is seeded at the SAME (host, cwd)
    // place as instance A (differing only by owning agent). If the guard were
    // removed and Y inherited A's place, selectOriginConnection would find Y's
    // ONLINE connection at that exact place and return DIRECTED (targetConnectionUuid
    // === connY). Because the guard holds, the pin yields nothing for Y and the
    // selection is online_first → null directed target.
    const result = await createTurnAndResolveTarget(taskWake(s, s.taskCross, s.agentY));
    // online_first selection for agent Y → its own connection, NOT directed.
    expect(result.targetConnectionUuid).toBeNull(); // a broken guard would make this connY
    expect(result.suppressWake).toBe(false);
    expect(result.turn).not.toBeNull();
    // The turn's session is owned by agent Y's connection — never instance A/connA.
    const session = agentInstanceStore.daemonSessions.find(
      (ss) => ss.uuid === result.turn!.sessionUuid,
    )!;
    expect(session.originConnectionUuid).toBe(s.connY);
    expect(session.agentUuid).toBe(s.agentY);
  });

  it("AC#1 (HARD offline): instance A offline → the inherit-task wake is notify-only (suppressWake), NOT re-routed to B", async () => {
    const s = seedAgentInstanceScenario();
    await assignIdea({
      ideaUuid: s.ideaUuid,
      companyUuid: s.companyUuid,
      assigneeType: "agent",
      assigneeUuid: s.agentX,
      instanceUuid: s.instanceA,
    });

    // Sanity: A is online before we flip it.
    let instances = await listInstancesForAgent(s.companyUuid, s.agentX);
    expect(instances.find((i) => i.uuid === s.instanceA)?.online).toBe(true);

    // Take instance A offline (its only connection goes offline).
    takeInstanceOffline(s.connA);
    instances = await listInstancesForAgent(s.companyUuid, s.agentX);
    expect(instances.find((i) => i.uuid === s.instanceA)?.online).toBe(false);
    // Instance B is still online — but a HARD pin must NOT re-route to it.
    expect(instances.find((i) => i.uuid === s.instanceB)?.online).toBe(true);

    // The wake is a HARD pin now (inherited idea instance, owner choice B). An offline
    // HARD pin is NOTIFY-ONLY: NO turn, suppressWake TRUE, and it is NEVER re-routed to
    // the agent's online-first connection (B). This INVERTS the former SOFT degrade.
    const result = await createTurnAndResolveTarget(taskWake(s, s.taskInherit, s.agentX));
    expect(result.suppressWake).toBe(true); // offline-pin suppression on every connection
    expect(result.targetConnectionUuid).toBeNull();
    expect(result.turn).toBeNull(); // no turn created — never re-routed to B
  });

  it("AC#1 (reconnect retains the pin): instance A comes back online → the wake targets A again, never degraded to online-first", async () => {
    // The HARD pin is never degraded to a plain agent when offline (owner choice B): the
    // assignment row keeps pointing at instance A. So when A reconnects, re-resolving the
    // same wake DIRECTS it back to A (connA) — proving the pin was RETAINED, not un-pinned.
    const s = seedAgentInstanceScenario();
    await assignIdea({
      ideaUuid: s.ideaUuid,
      companyUuid: s.companyUuid,
      assigneeType: "agent",
      assigneeUuid: s.agentX,
      instanceUuid: s.instanceA,
    });

    // A goes offline: the wake is notify-only, never re-routed to B.
    takeInstanceOffline(s.connA);
    const offlineResult = await createTurnAndResolveTarget(taskWake(s, s.taskInherit, s.agentX));
    expect(offlineResult.turn).toBeNull();
    expect(offlineResult.suppressWake).toBe(true);

    // A reconnects. The assignment still pins instance A (never degraded), so the
    // re-resolved wake is DIRECTED back to A — NOT online-first (which would pick B).
    bringInstanceOnline(s.connA);
    const result = await createTurnAndResolveTarget(taskWake(s, s.taskInherit, s.agentX));
    expect(result.targetConnectionUuid).toBe(s.connA);
    expect(result.suppressWake).toBe(false);
    expect(result.turn).not.toBeNull();
    const session = agentInstanceStore.daemonSessions.find(
      (ss) => ss.uuid === result.turn!.sessionUuid,
    )!;
    expect(session.originConnectionUuid).toBe(s.connA);
  });

  it("AC#1 (re-pin): re-assign the idea to instance B → the inherit-task wake resolves to B", async () => {
    const s = seedAgentInstanceScenario();
    await assignIdea({
      ideaUuid: s.ideaUuid,
      companyUuid: s.companyUuid,
      assigneeType: "agent",
      assigneeUuid: s.agentX,
      instanceUuid: s.instanceA,
    });

    // Re-assign the SAME idea to instance B (instance → instance re-pin).
    const reassigned = await assignIdea({
      ideaUuid: s.ideaUuid,
      companyUuid: s.companyUuid,
      assigneeType: "agent",
      assigneeUuid: s.agentX,
      instanceUuid: s.instanceB,
    });
    expect(reassigned.assignee?.type).toBe("agent_instance");
    const ideaRow = agentInstanceStore.ideas.find((i) => i.uuid === s.ideaUuid)!;
    expect(ideaRow.assigneeUuid).toBe(s.instanceB);

    // The inherit task now resolves to instance B's connection.
    const result = await createTurnAndResolveTarget(taskWake(s, s.taskInherit, s.agentX));
    expect(result.targetConnectionUuid).toBe(s.connB);
    expect(result.suppressWake).toBe(false);
  });

  it("AC#1 (revert): revert the idea to plain agent → the inherit-task wake resolves online-first (no pin)", async () => {
    const s = seedAgentInstanceScenario();
    await assignIdea({
      ideaUuid: s.ideaUuid,
      companyUuid: s.companyUuid,
      assigneeType: "agent",
      assigneeUuid: s.agentX,
      instanceUuid: s.instanceA,
    });

    // Revert: re-assign with NO instanceUuid → the assignment falls back to the
    // plain agent (assigneeType="agent"), so there is no instance to inherit.
    const reverted = await assignIdea({
      ideaUuid: s.ideaUuid,
      companyUuid: s.companyUuid,
      assigneeType: "agent",
      assigneeUuid: s.agentX,
      // instanceUuid omitted → revert to plain agent
    });
    expect(reverted.assignee?.type).toBe("agent");
    const ideaRow = agentInstanceStore.ideas.find((i) => i.uuid === s.ideaUuid)!;
    expect(ideaRow.assigneeType).toBe("agent");
    expect(ideaRow.assigneeUuid).toBe(s.agentX);

    // With no pin to inherit, the wake goes online-first (no directed target,
    // no suppression). A turn is still created on the agent's first online conn.
    const result = await createTurnAndResolveTarget(taskWake(s, s.taskInherit, s.agentX));
    expect(result.targetConnectionUuid).toBeNull();
    expect(result.suppressWake).toBe(false);
    expect(result.turn).not.toBeNull();
  });

  it("AC#2 (no silent drop): the instance-pinned idea is NEVER dropped from the agent's ideaTracker across the lifecycle", async () => {
    const s = seedAgentInstanceScenario();

    // Plain-agent assignment first — tracker includes it (baseline).
    await assignIdea({
      ideaUuid: s.ideaUuid,
      companyUuid: s.companyUuid,
      assigneeType: "agent",
      assigneeUuid: s.agentX,
    });
    expect(await trackerHasIdea(s.agentX, s.ideaUuid)).toBe(true);

    // Pin to instance A — assigneeUuid is now an INSTANCE uuid. A naive flat
    // {assigneeType:"agent",assigneeUuid:agentX} query would now drop it; the
    // real tracker (buildAssigneeMatch) must keep it.
    await assignIdea({
      ideaUuid: s.ideaUuid,
      companyUuid: s.companyUuid,
      assigneeType: "agent",
      assigneeUuid: s.agentX,
      instanceUuid: s.instanceA,
    });
    expect(await trackerHasIdea(s.agentX, s.ideaUuid)).toBe(true);

    // Re-pin to instance B — still present.
    await assignIdea({
      ideaUuid: s.ideaUuid,
      companyUuid: s.companyUuid,
      assigneeType: "agent",
      assigneeUuid: s.agentX,
      instanceUuid: s.instanceB,
    });
    expect(await trackerHasIdea(s.agentX, s.ideaUuid)).toBe(true);

    // Take instance B offline (degrade) — the assignment row is unchanged, so the
    // idea is STILL on the agent's plate (presence is a wake concern, not a
    // tracker concern: the idea must never disappear just because the cwd is down).
    takeInstanceOffline(s.connB);
    expect(await trackerHasIdea(s.agentX, s.ideaUuid)).toBe(true);

    // Revert to plain agent — still present (now matched by the plain agent arm).
    await assignIdea({
      ideaUuid: s.ideaUuid,
      companyUuid: s.companyUuid,
      assigneeType: "agent",
      assigneeUuid: s.agentX,
    });
    expect(await trackerHasIdea(s.agentX, s.ideaUuid)).toBe(true);
  });

  it("AC#3: an elaboration_verified wake on the A-pinned idea targets instance A", async () => {
    const s = seedAgentInstanceScenario();
    // claimIdea (not assign) to exercise the claim path's instance pin too.
    await claimIdea({
      ideaUuid: s.ideaUuid,
      companyUuid: s.companyUuid,
      assigneeType: "agent",
      assigneeUuid: s.agentX,
      instanceUuid: s.instanceA,
    });

    // The Verify-Elaborate handoff wake (write-the-proposal) is idea-anchored.
    // Because the idea is instance-pinned, the root-idea HARD pin leads and the
    // wake is DIRECTED to instance A — ahead of (and instead of) the lower-priority
    // session-origin heuristic.
    const result = await createTurnAndResolveTarget(elaborationVerifiedWake(s, s.agentX));
    expect(result.targetConnectionUuid).toBe(s.connA);
    expect(result.suppressWake).toBe(false);
    expect(result.turn).not.toBeNull();
  });

  it("AC#3 (HARD offline): elaboration_verified on an A-pinned idea whose A is offline is notify-only, NOT re-routed to B", async () => {
    const s = seedAgentInstanceScenario();
    await claimIdea({
      ideaUuid: s.ideaUuid,
      companyUuid: s.companyUuid,
      assigneeType: "agent",
      assigneeUuid: s.agentX,
      instanceUuid: s.instanceA,
    });
    takeInstanceOffline(s.connA);

    // Idea HARD pin → A offline → offline_pin (notify-only, suppressWake TRUE). The pin
    // resolves to `offline_pin` BEFORE the session-origin heuristic (which only fires on
    // online_first), so the wake is NEVER re-routed to agent-X online-first (B). NO turn.
    // This INVERTS the former SOFT degrade.
    const result = await createTurnAndResolveTarget(elaborationVerifiedWake(s, s.agentX));
    expect(result.suppressWake).toBe(true);
    expect(result.targetConnectionUuid).toBeNull();
    expect(result.turn).toBeNull();
  });
});

// =====================================================================================
// Focused regression guard (AC#4): documents WHY buildAssigneeMatch exists.
// =====================================================================================

describe("AgentInstance addressing — regression guard: a flat {assigneeType:'agent'} query misses agent_instance ideas", () => {
  it("AC#4: a naive flat {assigneeType:'agent',assigneeUuid:actor} query MISSES the agent_instance idea; buildAssigneeMatch + resolveAssigneeAgentUuid catch it", async () => {
    const s = seedAgentInstanceScenario();
    await assignIdea({
      ideaUuid: s.ideaUuid,
      companyUuid: s.companyUuid,
      assigneeType: "agent",
      assigneeUuid: s.agentX,
      instanceUuid: s.instanceA,
    });

    // The idea row's assigneeUuid is the INSTANCE uuid, not the agent uuid.
    const ideaRow = agentInstanceStore.ideas.find((i) => i.uuid === s.ideaUuid)!;
    expect(ideaRow.assigneeType).toBe("agent_instance");
    expect(ideaRow.assigneeUuid).toBe(s.instanceA);
    expect(ideaRow.assigneeUuid).not.toBe(s.agentX);

    // (a) The NAIVE flat query — what every pre-change "assigned to this agent"
    // filter looked like — can NEVER match the agent_instance row: it compares the
    // instance uuid against the agent uuid. Run it against the live store to prove
    // it drops the idea.
    const naiveMatches = (await mockPrisma.idea.findMany({
      where: {
        companyUuid: s.companyUuid,
        assigneeType: "agent",
        assigneeUuid: s.agentX,
      },
    })) as Array<{ uuid: string }>;
    expect(naiveMatches.find((i) => i.uuid === s.ideaUuid)).toBeUndefined();

    // (b) The SHARED helper builds an OR that ALSO targets the agent's instance
    // uuids — so the same store query DOES match the idea.
    const assigneeMatch = await buildAssigneeMatch(agentAuth(s.agentX));
    // The agent_instance arm targets instance uuids (NOT the actor uuid).
    const instanceArm = assigneeMatch.find((c) => c.assigneeType === "agent_instance");
    expect(instanceArm).toBeDefined();
    expect(instanceArm!.assigneeUuid).toEqual({ in: expect.arrayContaining([s.instanceA, s.instanceB]) });
    // No arm uses a flat agent-uuid equality for the instance type.
    expect(instanceArm!.assigneeUuid).not.toBe(s.agentX);

    const helperMatches = (await mockPrisma.idea.findMany({
      where: { companyUuid: s.companyUuid, OR: assigneeMatch },
    })) as Array<{ uuid: string }>;
    expect(helperMatches.find((i) => i.uuid === s.ideaUuid)).toBeDefined();

    // (c) And the canonical agent uuid behind the assignment resolves to agent X.
    const resolvedAgent = await resolveAssigneeAgentUuid(
      s.companyUuid,
      ideaRow.assigneeType,
      ideaRow.assigneeUuid,
    );
    expect(resolvedAgent).toBe(s.agentX);
  });
});
