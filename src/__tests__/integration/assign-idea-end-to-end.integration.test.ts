// src/__tests__/integration/assign-idea-end-to-end.integration.test.ts
//
// Integration (pseudo-e2e) test for add-assign-idea-mcp-tool — the checkpoint that
// converges the backend tool (chorus_pm_assign_idea, task 1) and the reworked
// idea_claimed wake provenance (task 2). It drives the REAL chain
//
//     chorus_pm_assign_idea (MCP tool handler)
//       → idea.service.assignIdea            (persists assignee + status transition)
//       → activity.service.createActivity    (writes the actor-bearing `assigned` Activity)
//       → [emitted activity event]
//       → notification-listener.handleActivity  (idea:assigned → idea_claimed recipients)
//       → notification.service.createBatch    (persists the wake notifications)
//       → notification-turn.createTurnAndResolveTarget (records the DaemonSessionTurn wake)
//
// over the shared in-memory fixture prisma (agentInstanceFixture), so the tool, the
// two idea.service assignment arms, the activity write, the notification recipient
// resolution (incl. agent_instance → owning agent), the preference gate, and the wake
// turn creation all run REAL against ONE store. Only external side effects are mocked:
//   - @/lib/prisma                          → the in-memory store
//   - @/lib/event-bus                       → emit is captured (to re-feed the listener),
//                                             emitChange is inert (no SSE), on is a no-op
//   - @/services/daemon-instruction.service → deliverTurnPing (no control-channel ping)
//   - @/services/orchestrator.service       → resolveResourceOrchestrator (attribution not
//                                             under test; keeps formatNotifications clean)
//
// WHY re-feed the captured activity event into handleActivity directly (rather than let
// the eventBus fan it out): the real listener subscribes via a FIRE-AND-FORGET
// eventBus.on handler that is never awaited, so relying on it would be non-deterministic.
// Capturing the exact payload activity.service emits and awaiting handleActivity on it is
// the deterministic equivalent (the same pattern the notification-listener unit test uses)
// while still exercising the real production payload → real recipient resolution.
//
// COVERAGE MAP (per task ACs):
//   AC#1 (this file): tool→service→activity→notification-recipient for agent, agent_instance,
//        and user targets — assignee/status/Activity(actorType agent), recipient resolution
//        (instance→owning agent), silent takeover, ineligible-target rejection.
//   AC#2 (this file): idea_claimed IS preference-gated (PREF_FIELD_MAP.ideaClaimed) — a test
//        proves that an assignee whose ideaClaimed pref is OFF is dropped BEFORE createBatch,
//        so NO notification AND NO wake turn is born for them (default-on delivers). See the
//        "notification-preference gating" describe + the file summary for the finding.
//   AC#3 (deferred to cli/__tests__/wake-orchestration.test.mjs): the woken idea_claimed
//        prompt names the assigner and never instructs chorus_claim_idea — asserted there for
//        both agent and user actors; not duplicated here (a `.mjs` daemon-prompt test cannot
//        be driven from this TS harness without value).
//   AC#4 (live human step): real daemon-backed wake delivery is not headless-automatable and
//        is documented as a manual verification step on the idea.

import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  agentInstanceStore,
  resetAgentInstanceStore,
  buildMockPrisma,
} from "@/__tests__/fixtures/agentInstanceFixture";

// vi.mock factories hoist above imports, so their captured refs must come from vi.hoisted.
const { hoistedPrisma, emittedActivity } = vi.hoisted(() => ({
  hoistedPrisma: { current: null as unknown },
  emittedActivity: [] as Array<Record<string, unknown>>,
}));

const mockPrisma = buildMockPrisma();
hoistedPrisma.current = mockPrisma;

vi.mock("@/lib/prisma", () => ({
  get prisma() {
    return hoistedPrisma.current;
  },
}));
// emit("activity", …) is captured so the test can re-feed the exact payload to the
// listener; emitChange (assignIdea's `updated` event) is inert; on is a no-op so the
// listener's module-load subscription does not throw.
vi.mock("@/lib/event-bus", () => ({
  eventBus: {
    emit: vi.fn((name: string, payload: Record<string, unknown>) => {
      if (name === "activity") emittedActivity.push(payload);
    }),
    emitChange: vi.fn(),
    on: vi.fn(),
  },
  transcriptEventName: (sessionUuid: string) => `transcript:${sessionUuid}`,
}));
vi.mock("@/services/daemon-instruction.service", () => ({
  deliverTurnPing: vi.fn(),
}));
vi.mock("@/services/orchestrator.service", () => ({
  resolveResourceOrchestrator: vi.fn().mockResolvedValue(null),
}));

import { registerPmTools } from "@/mcp/tools/pm";
import { handleActivity } from "@/services/notification-listener";
import type { AgentAuthContext } from "@/types/auth";

// ===== Scenario identifiers =====

const COMPANY = "co-assign-e2e";
const PROJECT = "proj-assign-e2e";
const OWNER = "user-owner-e2e";
const CALLER = "agent-admin-claude"; // the assigner (idea:admin)
const PM_AGENT = "agent-pm-bot"; // eligible target (idea:write)
const RO_AGENT = "agent-readonly-bot"; // ineligible target (idea:read only)
const CREATOR = "user-creator-e2e"; // idea creator (always an idea_claimed recipient)
const TARGET_USER = "user-bob-e2e"; // eligible user target (same company)
const INSTANCE = "instance-pm-host1"; // durable instance owned by PM_AGENT
const CONN = "conn-pm-host1";
const CONFLICTING_INSTANCE = "instance-pm-host2";
const CONFLICTING_CONN = "conn-pm-host2";
const IDEA = "idea-assign-e2e";

// The caller's AuthContext — idea:admin is what registers chorus_pm_assign_idea.
const auth: AgentAuthContext = {
  type: "agent",
  companyUuid: COMPANY,
  actorUuid: CALLER,
  ownerUuid: OWNER,
  roles: ["admin_agent"],
  permissions: ["idea:admin", "idea:write", "idea:read"],
  agentName: "Admin Claude",
};

type ToolHandler = (params: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;
const toolHandlers: Record<string, ToolHandler> = {};
const fakeMcpServer = {
  registerTool: (name: string, _meta: unknown, handler: ToolHandler) => {
    toolHandlers[name] = handler;
  },
};

// Seed a fresh scenario: caller + eligible/ineligible agents, one online instance for
// the PM agent, a creator user, an eligible user target, and one OPEN idea created by the
// creator. Each field the exercised services read/write is present.
function seed(ideaOverrides: Partial<(typeof agentInstanceStore.ideas)[number]> = {}) {
  const now = new Date();
  agentInstanceStore.projects.push({ uuid: PROJECT, companyUuid: COMPANY, name: "Assign E2E Project" });
  agentInstanceStore.users.push(
    { uuid: OWNER, companyUuid: COMPANY, name: "Owner", email: "owner@example.com" },
    { uuid: CREATOR, companyUuid: COMPANY, name: "Creator", email: "creator@example.com" },
    { uuid: TARGET_USER, companyUuid: COMPANY, name: "Bob", email: "bob@example.com" },
  );
  agentInstanceStore.agents.push(
    { uuid: CALLER, companyUuid: COMPANY, name: "Admin Claude", ownerUuid: OWNER, roles: ["admin_agent"], permissions: [] },
    // Eligible: holds idea:write directly (permission gate, not preset name).
    { uuid: PM_AGENT, companyUuid: COMPANY, name: "PM Bot", ownerUuid: OWNER, roles: [], permissions: ["idea:read", "idea:write"] },
    // Ineligible: idea:read only.
    { uuid: RO_AGENT, companyUuid: COMPANY, name: "ReadOnly Bot", ownerUuid: OWNER, roles: [], permissions: ["idea:read"] },
  );
  agentInstanceStore.agentInstances.push({
    uuid: INSTANCE,
    companyUuid: COMPANY,
    agentUuid: PM_AGENT,
    host: "host-1",
    cwd: "/work/pm",
    createdAt: now,
    updatedAt: now,
  });
  agentInstanceStore.daemonConnections.push({
    uuid: CONN,
    companyUuid: COMPANY,
    agentUuid: PM_AGENT,
    clientType: "claude-code",
    clientVersion: "0.16.3",
    host: "host-1",
    cwd: "/work/pm",
    startedAt: now,
    status: "online",
    connectedAt: now,
    lastSeenAt: now,
    disconnectedAt: null,
    agentInstanceUuid: INSTANCE,
  });
  agentInstanceStore.ideas.push({
    uuid: IDEA,
    companyUuid: COMPANY,
    projectUuid: PROJECT,
    title: "Ship the widget",
    content: "body",
    attachments: null,
    status: "open",
    elaborationStatus: null,
    elaborationDepth: null,
    parentUuid: null,
    assigneeType: null,
    assigneeUuid: null,
    cwdSource: null,
    cwdHost: null,
    runtimeCwd: null,
    assignedAt: null,
    assignedByUuid: null,
    createdByUuid: CREATOR,
    createdByType: "user",
    createdAt: now,
    updatedAt: now,
    ...ideaOverrides,
  });
}

// Drive the real tool, then re-feed the emitted `assigned` activity into the real
// listener. Returns the tool result plus the (single) captured activity event.
async function assignAndNotify(params: Record<string, unknown>) {
  const activityCount = emittedActivity.length;
  const result = await toolHandlers["chorus_pm_assign_idea"](params);
  // The tool emits exactly one "activity" event on success (createActivity). On a
  // rejection (idea/target invalid) none is emitted — handleActivity is then skipped.
  const activityEvent = emittedActivity.slice(activityCount).find(
    (e) => e.targetType === "idea" && e.targetUuid === params.ideaUuid && e.action === "assigned",
  );
  if (activityEvent) {
    await handleActivity(activityEvent as unknown as Parameters<typeof handleActivity>[0]);
  }
  return { result, activityEvent };
}

function ideaRow() {
  return agentInstanceStore.ideas.find((i) => i.uuid === IDEA)!;
}
function assignedActivities() {
  return agentInstanceStore.activities.filter(
    (a) => a.targetType === "idea" && a.targetUuid === IDEA && a.action === "assigned",
  );
}
function ideaClaimedNotifications() {
  return agentInstanceStore.notifications.filter(
    (n) => n.entityUuid === IDEA && n.action === "idea_claimed",
  );
}

beforeEach(() => {
  resetAgentInstanceStore();
  emittedActivity.length = 0;
  // Do NOT vi.clearAllMocks() — that would wipe the fixture prisma model fn impls.
  for (const k of Object.keys(toolHandlers)) delete toolHandlers[k];
  registerPmTools(
    fakeMcpServer as unknown as Parameters<typeof registerPmTools>[0],
    auth,
  );
});

// =====================================================================================
// AC#1 — agent target
// =====================================================================================

describe("assign_idea end-to-end — agent target (AC#1)", () => {
  it("updates assignee/status, writes an actor-bearing `assigned` Activity, and resolves the wake recipient to the assignee agent", async () => {
    seed();
    const { result, activityEvent } = await assignAndNotify({
      ideaUuid: IDEA,
      assigneeType: "agent",
      assigneeUuid: PM_AGENT,
    });

    // (a) tool succeeded.
    expect(result.isError).toBeFalsy();

    // (b) idea row persisted: plain-agent assignment, open → elaborating.
    const idea = ideaRow();
    expect(idea.assigneeType).toBe("agent");
    expect(idea.assigneeUuid).toBe(PM_AGENT);
    expect(idea.status).toBe("elaborating");
    // Tool response mirrors the persisted state.
    const payload = JSON.parse(result.content[0].text);
    expect(payload.status).toBe("elaborating");
    expect(payload.assignee).toEqual({ type: "agent", uuid: PM_AGENT });

    // (c) the actor-bearing `assigned` Activity — the wake trigger — was persisted.
    const acts = assignedActivities();
    expect(acts).toHaveLength(1);
    expect(acts[0].actorType).toBe("agent");
    expect(acts[0].actorUuid).toBe(CALLER);
    expect(acts[0].value).toMatchObject({ assigneeType: "agent", assigneeUuid: PM_AGENT });
    // The emitted event carries the same actor provenance the listener consumes.
    expect(activityEvent).toMatchObject({ action: "assigned", actorType: "agent", actorUuid: CALLER });

    // (d) notification recipient resolution: the assignee AGENT is a recipient.
    const agentNotif = ideaClaimedNotifications().find((n) => n.recipientType === "agent");
    expect(agentNotif).toBeDefined();
    expect(agentNotif!.recipientUuid).toBe(PM_AGENT);
    // The human creator is also notified; the actor (assigner) is never self-notified.
    expect(ideaClaimedNotifications().some((n) => n.recipientType === "user" && n.recipientUuid === CREATOR)).toBe(true);
    expect(ideaClaimedNotifications().every((n) => n.recipientUuid !== CALLER)).toBe(true);

    // (e) the wake turn is born on the assignee agent's session (daemon-side delivery
    // is the deferred live step, but the turn creation is exercised here).
    expect(agentInstanceStore.daemonSessionTurns.length).toBeGreaterThan(0);
    const session = agentInstanceStore.daemonSessions.find(
      (s) => s.uuid === agentInstanceStore.daemonSessionTurns[0].sessionUuid,
    );
    expect(session?.agentUuid).toBe(PM_AGENT);
  });

  it("rejects an ineligible target agent (no idea:write) — no assignment, no Activity, no notification", async () => {
    seed();
    const { result, activityEvent } = await assignAndNotify({
      ideaUuid: IDEA,
      assigneeType: "agent",
      assigneeUuid: RO_AGENT,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/idea:write/);
    // Nothing downstream happened.
    expect(activityEvent).toBeUndefined();
    const idea = ideaRow();
    expect(idea.assigneeType).toBeNull();
    expect(idea.status).toBe("open");
    expect(assignedActivities()).toHaveLength(0);
    expect(ideaClaimedNotifications()).toHaveLength(0);
    expect(agentInstanceStore.daemonSessionTurns).toHaveLength(0);
  });
});

// =====================================================================================
// AC#1 — agent_instance pin (instance → owning agent recipient resolution)
// =====================================================================================

describe("assign_idea end-to-end — agent_instance pin (AC#1)", () => {
  it("persists the idea as agent_instance and resolves the wake recipient to the OWNING agent (never the instance uuid)", async () => {
    seed();
    const { result } = await assignAndNotify({
      ideaUuid: IDEA,
      assigneeType: "agent",
      assigneeUuid: PM_AGENT,
      instanceUuid: INSTANCE,
    });

    expect(result.isError).toBeFalsy();

    // (a) idea row is an agent_instance assignment pointing at the instance uuid.
    const idea = ideaRow();
    expect(idea.assigneeType).toBe("agent_instance");
    expect(idea.assigneeUuid).toBe(INSTANCE);
    expect(idea.status).toBe("elaborating");

    // (b) Activity value carries the pinned instance uuid (attribution parity with UI).
    const acts = assignedActivities();
    expect(acts).toHaveLength(1);
    expect(acts[0].value).toMatchObject({
      assigneeType: "agent",
      assigneeUuid: PM_AGENT,
      instanceUuid: INSTANCE,
    });

    // (c) CRITICAL: the wake recipient is the OWNING agent, not the instance uuid — an
    // agent daemon recipient would never match an AgentInstance.uuid (silent-drop guard).
    const agentNotif = ideaClaimedNotifications().find((n) => n.recipientType === "agent");
    expect(agentNotif).toBeDefined();
    expect(agentNotif!.recipientUuid).toBe(PM_AGENT);
    expect(ideaClaimedNotifications().every((n) => n.recipientUuid !== INSTANCE)).toBe(true);

    // (d) the pinned wake is directed to the instance's online connection.
    expect(agentInstanceStore.daemonSessionTurns.length).toBeGreaterThan(0);
    const session = agentInstanceStore.daemonSessions.find(
      (s) => s.uuid === agentInstanceStore.daemonSessionTurns[0].sessionUuid,
    );
    expect(session?.originConnectionUuid).toBe(CONN);
    expect(session?.agentUuid).toBe(PM_AGENT);
  });

  it("materializes the owner project-fixed target, overrides a conflicting explicit instance, and directs the wake to the fixed connection", async () => {
    seed();
    const now = new Date();
    agentInstanceStore.agentInstances.push({
      uuid: CONFLICTING_INSTANCE,
      companyUuid: COMPANY,
      agentUuid: PM_AGENT,
      host: "host-2",
      cwd: "/work/other",
      createdAt: now,
      updatedAt: now,
    });
    agentInstanceStore.daemonConnections.push({
      uuid: CONFLICTING_CONN,
      companyUuid: COMPANY,
      agentUuid: PM_AGENT,
      clientType: "claude-code",
      clientVersion: "0.17.0",
      host: "host-2",
      cwd: "/work/other",
      startedAt: now,
      status: "online",
      connectedAt: now,
      lastSeenAt: now,
      disconnectedAt: null,
      agentInstanceUuid: CONFLICTING_INSTANCE,
    });
    agentInstanceStore.projectAgentCwdPreferences.push({
      uuid: "pref-fixed-pm",
      companyUuid: COMPANY,
      userUuid: OWNER,
      projectUuid: PROJECT,
      agentUuid: PM_AGENT,
      host: "host-1",
      cwd: "/work/pm",
      anchorAgentInstanceUuid: INSTANCE,
    });

    const { result } = await assignAndNotify({
      ideaUuid: IDEA,
      assigneeType: "agent",
      assigneeUuid: PM_AGENT,
      instanceUuid: CONFLICTING_INSTANCE,
    });

    expect(result.isError).toBeFalsy();
    expect(ideaRow()).toMatchObject({
      assigneeType: "agent_instance",
      assigneeUuid: INSTANCE,
      cwdSource: "project_fixed",
      cwdHost: "host-1",
      runtimeCwd: "/work/pm",
    });
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      assignee: { type: "agent_instance", uuid: INSTANCE },
      target: {
        instanceUuid: INSTANCE,
        resolvedCwdSource: "project_fixed",
        resolvedCwdHost: "host-1",
        resolvedRuntimeCwd: "/work/pm",
      },
    });
    expect(assignedActivities()[0].value).toMatchObject({
      instanceUuid: INSTANCE,
      resolvedCwdSource: "project_fixed",
      resolvedCwdHost: "host-1",
      resolvedRuntimeCwd: "/work/pm",
    });
    const turn = agentInstanceStore.daemonSessionTurns.at(-1)!;
    const session = agentInstanceStore.daemonSessions.find(
      (candidate) => candidate.uuid === turn.sessionUuid,
    );
    expect(session?.originConnectionUuid).toBe(CONN);
  });

  it("same-agent plain-to-project-fixed reassignment persists the pin without another activity or daemon turn", async () => {
    seed();
    const first = await assignAndNotify({
      ideaUuid: IDEA,
      assigneeType: "agent",
      assigneeUuid: PM_AGENT,
    });
    expect(first.result.isError).toBeFalsy();
    expect(ideaRow()).toMatchObject({
      assigneeType: "agent",
      assigneeUuid: PM_AGENT,
    });

    agentInstanceStore.projectAgentCwdPreferences.push({
      uuid: "pref-fixed-after-plain",
      companyUuid: COMPANY,
      userUuid: OWNER,
      projectUuid: PROJECT,
      agentUuid: PM_AGENT,
      host: "host-1",
      cwd: "/work/pm",
      anchorAgentInstanceUuid: INSTANCE,
    });
    const second = await assignAndNotify({
      ideaUuid: IDEA,
      assigneeType: "agent",
      assigneeUuid: PM_AGENT,
    });

    expect(second.result.isError).toBeFalsy();
    expect(ideaRow()).toMatchObject({
      assigneeType: "agent_instance",
      assigneeUuid: INSTANCE,
      cwdSource: "project_fixed",
      cwdHost: "host-1",
      runtimeCwd: "/work/pm",
    });
    expect(JSON.parse(second.result.content[0].text).wakeRequested).toBe(false);
    expect(assignedActivities()).toHaveLength(1);
    expect(agentInstanceStore.daemonSessionTurns).toHaveLength(1);
  });
});

// =====================================================================================
// AC#1 — user target
// =====================================================================================

describe("assign_idea end-to-end — user target (AC#1)", () => {
  it("assigns to a same-company user, writes the Activity, notifies the user, and wakes NO daemon", async () => {
    seed();
    const { result } = await assignAndNotify({
      ideaUuid: IDEA,
      assigneeType: "user",
      assigneeUuid: TARGET_USER,
    });

    expect(result.isError).toBeFalsy();

    // (a) idea row is a user assignment, open → elaborating.
    const idea = ideaRow();
    expect(idea.assigneeType).toBe("user");
    expect(idea.assigneeUuid).toBe(TARGET_USER);
    expect(idea.status).toBe("elaborating");

    // (b) Activity persisted with actorType agent + the user assignee.
    const acts = assignedActivities();
    expect(acts).toHaveLength(1);
    expect(acts[0].actorType).toBe("agent");
    expect(acts[0].value).toMatchObject({ assigneeType: "user", assigneeUuid: TARGET_USER });

    // (c) the assignee USER is notified; recipients are all users (no agent daemon).
    const userNotif = ideaClaimedNotifications().find((n) => n.recipientUuid === TARGET_USER);
    expect(userNotif).toBeDefined();
    expect(userNotif!.recipientType).toBe("user");
    expect(ideaClaimedNotifications().every((n) => n.recipientType === "user")).toBe(true);

    // (d) no daemon wake — a user recipient never owns a daemon session
    // (createTurnAndResolveTarget early-returns for a non-agent recipient).
    expect(agentInstanceStore.daemonSessionTurns).toHaveLength(0);
  });
});

// =====================================================================================
// AC#1 — silent takeover & status preservation
// =====================================================================================

describe("assign_idea end-to-end — takeover & status (AC#1)", () => {
  it("silently takes over an idea already assigned to another agent (no pre-check, no error)", async () => {
    // Idea already assigned to the read-only agent and mid-elaboration.
    seed({ status: "elaborating", assigneeType: "agent", assigneeUuid: RO_AGENT });
    const { result } = await assignAndNotify({
      ideaUuid: IDEA,
      assigneeType: "agent",
      assigneeUuid: PM_AGENT,
    });

    expect(result.isError).toBeFalsy();
    const idea = ideaRow();
    // Takeover: the new assignee replaces the prior one.
    expect(idea.assigneeType).toBe("agent");
    expect(idea.assigneeUuid).toBe(PM_AGENT);
    // The wake targets the NEW assignee.
    const agentNotif = ideaClaimedNotifications().find((n) => n.recipientType === "agent");
    expect(agentNotif!.recipientUuid).toBe(PM_AGENT);
  });

  it("preserves a non-open status (elaborated) — backfill-safe, no open→elaborating override", async () => {
    seed({ status: "elaborated" });
    const { result } = await assignAndNotify({
      ideaUuid: IDEA,
      assigneeType: "agent",
      assigneeUuid: PM_AGENT,
    });

    expect(result.isError).toBeFalsy();
    expect(ideaRow().status).toBe("elaborated");
    expect(JSON.parse(result.content[0].text).status).toBe("elaborated");
  });
});

// =====================================================================================
// AC#2 — notification-preference gating (the reviewer's concern)
// =====================================================================================
//
// FINDING (verified by these tests): the idea-assignment daemon wake IS
// preference-gated. `idea:assigned` maps to the `idea_claimed` notification type,
// which IS present in notification-listener PREF_FIELD_MAP (→ `ideaClaimed`). So in
// handleActivity, an assignee whose `ideaClaimed` pref is OFF is dropped BEFORE
// notification.service.createBatch runs — and createBatch is where the wake turn is
// born. Net: an agent that turned `ideaClaimed` off would receive NEITHER a
// notification NOR an assignment wake. This CONTRASTS with the sibling human
// stage-advance agent wakes (elaboration_verified / start_development /
// yolo_requested), which are deliberately EXCLUDED from PREF_FIELD_MAP so their
// agent wake is never preference-gated. The default is safe (`ideaClaimed` defaults
// to true in the Prisma schema, and an auto-created pref row is fully enabled), so
// the common case delivers — but the gating is a real asymmetry, documented here and
// in the idea comment, NOT changed (out of scope for this test task).
describe("assign_idea end-to-end — idea_claimed preference gating (AC#2)", () => {
  it("with the default (ideaClaimed on) the assignee agent IS notified AND woken", async () => {
    seed();
    await assignAndNotify({ ideaUuid: IDEA, assigneeType: "agent", assigneeUuid: PM_AGENT });

    // A default pref row was auto-created (fully enabled) → the assignee is a recipient.
    const agentNotif = ideaClaimedNotifications().find((n) => n.recipientUuid === PM_AGENT);
    expect(agentNotif).toBeDefined();
    expect(agentInstanceStore.daemonSessionTurns.length).toBeGreaterThan(0);
  });

  it("with the assignee's ideaClaimed pref OFF, the assignee is dropped — NO notification, NO wake turn (pref gate suppresses the assignment wake)", async () => {
    seed();
    // The assignee agent explicitly disabled idea_claimed notifications.
    agentInstanceStore.notificationPreferences.push({
      uuid: "pref-pm-off",
      companyUuid: COMPANY,
      ownerType: "agent",
      ownerUuid: PM_AGENT,
      taskAssigned: true,
      taskStatusChanged: true,
      taskVerified: true,
      taskReopened: true,
      proposalSubmitted: true,
      proposalApproved: true,
      proposalRejected: true,
      ideaClaimed: false, // <-- the gate under test
      commentAdded: true,
      elaborationRequested: true,
      elaborationAnswered: true,
      mentioned: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const { result } = await assignAndNotify({
      ideaUuid: IDEA,
      assigneeType: "agent",
      assigneeUuid: PM_AGENT,
    });

    // The assignment itself still succeeds + persists (the pref only gates the wake).
    expect(result.isError).toBeFalsy();
    expect(ideaRow().assigneeUuid).toBe(PM_AGENT);
    // But the assignee agent got NEITHER a notification NOR a wake turn.
    expect(ideaClaimedNotifications().some((n) => n.recipientUuid === PM_AGENT)).toBe(false);
    expect(agentInstanceStore.daemonSessionTurns).toHaveLength(0);
    // The human creator (default pref) is still notified — only the gated agent is dropped.
    expect(ideaClaimedNotifications().some((n) => n.recipientType === "user" && n.recipientUuid === CREATOR)).toBe(true);
  });
});

// =====================================================================================
// Idea lookup guard
// =====================================================================================

describe("assign_idea end-to-end — idea lookup", () => {
  it("returns not-found for an idea absent in this company — no downstream effects", async () => {
    seed();
    const { result, activityEvent } = await assignAndNotify({
      ideaUuid: "does-not-exist",
      assigneeType: "agent",
      assigneeUuid: PM_AGENT,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not found/i);
    expect(activityEvent).toBeUndefined();
    expect(assignedActivities()).toHaveLength(0);
    expect(agentInstanceStore.notifications).toHaveLength(0);
  });
});
