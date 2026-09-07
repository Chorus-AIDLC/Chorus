// src/services/__tests__/wake-carry-waker-session-anchor.integration.test.ts
//
// INTEGRATION CHECKPOINT for the wake-carry-waker-session-anchor feature (T1 server +
// T2 daemon prompt, combined). Each end is already pinned in isolation by a per-task suite:
//   - orchestrator.service.test.ts        → resolveWakerSessionAnchor online/offline/absent
//   - notification.service.test.ts        → formatNotifications wires the anchor into the
//                                            NotificationResponse projection (mocking the resolver)
//   - cli/prompts.test.mjs                → wakerSessionGuidance renders / omits the line
//
// What no single unit test proves is the SEAM the per-task reviews could not see: that a
// real agent-caused idea/task wake, run through the REAL server projection with the REAL
// anchor resolver, yields a NotificationResponse whose `wakerSession` then drives the REAL
// daemon prompt builder to emit the advisory line — and that an offline waker collapses the
// whole chain to notify-only (null anchor → no line). The per-task suites each mock the hop
// on the other side of their own boundary, so a drift between the server field shape and the
// prompt builder's read of it would stay green there but fail HERE.
//
// This test imports the ACTUAL modules together and walks ONE flow across the server→daemon
// boundary:
//   list() → formatNotifications() → resolveWakerSessionAnchor()  [server, TS]
//         → NotificationResponse.wakerSession
//         → buildPrompt / buildBatchPrompt                        [daemon client, cli/*.mjs]
//
// Only the leaf dependencies are stubbed (prisma rows, the live connection registry, the
// task→idea lineage resolver, and the wake-turn bridge that list() never calls). The anchor
// resolver (orchestrator.service) and the notification projection (notification.service) run
// for real, as does the daemon prompt builder.

import { describe, it, expect, beforeEach, vi } from "vitest";

// ===== Prisma mock (leaf rows only) =====
// resolveWakerSessionAnchor reads daemonSession.findFirst; resolveResourceOrchestrator reads
// idea/task.findFirst; list() reads notification.findMany + count. Everything else is real.
const mockPrisma = vi.hoisted(() => ({
  notification: {
    findMany: vi.fn(),
    count: vi.fn(),
  },
  daemonSession: {
    findFirst: vi.fn(),
  },
  idea: {
    findFirst: vi.fn(),
  },
  task: {
    findFirst: vi.fn(),
  },
}));
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));

// list() never emits, but notification.service imports the bus at module top.
vi.mock("@/lib/event-bus", () => ({ eventBus: { emit: vi.fn(), emitChange: vi.fn() } }));

// The wake-turn bridge is imported by notification.service but NOT reached on the list()
// read path — stub it so importing the service does not drag in the daemon turn stack.
vi.mock("@/services/notification-turn", () => ({
  createTurnAndResolveTarget: vi.fn().mockResolvedValue({
    turn: null,
    targetConnectionUuid: null,
    suppressWake: false,
  }),
}));

// A Task has no `ideaUuid` column; formatNotifications resolves a TASK wake's DIRECT
// containing idea through this shared resolver. Stubbed so the lineage walk itself (covered
// elsewhere) is out of scope — we only need it to hand back the task's direct idea uuid.
const mockResolveDirectIdeaUuid = vi.hoisted(() => vi.fn());
vi.mock("@/services/daemon-session.service", () => ({
  resolveDirectIdeaUuid: mockResolveDirectIdeaUuid,
}));

// The live connection registry read that resolveWakerSessionAnchor uses to confirm the
// waker's session origin is ONLINE. This is the ONLY dependency of the real anchor resolver
// we stub — the resolver's own logic (session lookup + online-origin match) runs for real.
const mockListConnectionsForAgent = vi.hoisted(() => vi.fn());
vi.mock("@/services/daemon-connection.service", () => ({
  listConnectionsForAgent: mockListConnectionsForAgent,
}));

// NOTE: @/services/orchestrator.service is intentionally NOT mocked — resolveWakerSessionAnchor
// runs for real. That is the whole point of this integration checkpoint.

import { list, type NotificationResponse } from "@/services/notification.service";
// The daemon client lives in cli/ as plain .mjs; Vitest imports it directly (the existing
// elaboration-verify-wake.integration.test.ts proves the module is importable from a TS test).
import { buildPrompt, buildBatchPrompt } from "../../../cli/prompts.mjs";

// ===== Fixtures =====
const companyUuid = "company-0000-0000-0000-000000000001";
const recipientAgentUuid = "agent-woken-0000-0000-000000000001"; // the peer being woken
const wakerAgentUuid = "agent-waker-0000-0000-000000000001"; // the actor who woke it
const ONLINE_IDEA = "idea-online-0000-0000-000000000001";
const OFFLINE_IDEA = "idea-offline-0000-0000-000000000001";
const TASK_UUID = "task-0000-0000-0000-000000000001";

// The waker's live-connection display name is DELIBERATELY different from the notification's
// denormalized actorName below. resolveWakerSessionAnchor sources the anchor's agentName from
// the connection registry, so seeing "Waker Agent" (not the actorName) in the rendered line
// proves the name flowed through the real resolver, not a copy of the event actor.
const CONNECTION_AGENT_NAME = "Waker Agent";
const ACTOR_NAME = "PM Agent";

// The exact opening of wakerSessionGuidance (cli/prompts.mjs) — unique to the advisory line,
// so it never collides with the per-action @mention markup (which also names the agent).
const advisoryLine = (agentName: string, agentUuid: string) =>
  `@[${agentName}](agent:${agentUuid}) woke you and has a live session open on this resource.`;

const ADVISORY_ONLINE = advisoryLine(CONNECTION_AGENT_NAME, wakerAgentUuid);

type RawRecord = ReturnType<typeof makeRecord>;
function makeRecord(overrides: Record<string, unknown> = {}) {
  return {
    companyUuid,
    uuid: "notif-0000-0000-0000-000000000001",
    projectUuid: "project-0000-0000-0000-000000000001",
    projectName: "Test Project",
    recipientType: "agent",
    recipientUuid: recipientAgentUuid,
    entityType: "idea",
    entityUuid: ONLINE_IDEA,
    entityTitle: "Shared idea",
    action: "mentioned",
    message: "take a look",
    actorType: "agent",
    actorUuid: wakerAgentUuid,
    actorName: ACTOR_NAME,
    readAt: null as Date | null,
    archivedAt: null as Date | null,
    createdAt: new Date("2026-09-07T00:00:00Z"),
    instructionText: null as string | null,
    ...overrides,
  };
}

// Run the crafted raw rows through the REAL read projection (list → formatNotifications →
// resolveWakerSessionAnchor) and return the formatted NotificationResponses.
async function project(records: RawRecord[]): Promise<NotificationResponse[]> {
  mockPrisma.notification.findMany.mockResolvedValue(records);
  const { notifications } = await list({
    companyUuid,
    recipientType: "agent",
    recipientUuid: recipientAgentUuid,
  });
  return notifications;
}

// Mirror the daemon event-router seam: thread the projection fields (including the derived
// `wakerSession`) into the prompt builder's input shape.
function toWakeInput(r: NotificationResponse) {
  return {
    uuid: r.uuid,
    projectUuid: r.projectUuid,
    entityType: r.entityType,
    entityUuid: r.entityUuid,
    entityTitle: r.entityTitle,
    action: r.action,
    message: r.message,
    actorType: r.actorType,
    actorUuid: r.actorUuid,
    actorName: r.actorName,
    orchestrator: r.orchestrator,
    wakerSession: r.wakerSession,
    instructionText: r.instructionText ?? undefined,
  };
}

function occurrences(haystack: string, needle: string): number {
  let count = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    count += 1;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return count;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Two counts per list() call (total + unread) — a constant is fine.
  mockPrisma.notification.count.mockResolvedValue(1);
  // No assignment provenance → resolveResourceOrchestrator returns null (orchestrator is a
  // separate sibling; this test isolates the waker anchor).
  mockPrisma.idea.findFirst.mockResolvedValue(null);
  mockPrisma.task.findFirst.mockResolvedValue(null);
  // Idea-anchored DaemonSession lookup, keyed by the idea business key (sessionId === ideaUuid):
  //   ONLINE_IDEA  → session whose origin connection is online
  //   OFFLINE_IDEA → session exists but its origin connection is offline (the realistic
  //                  "waker went offline" case → notify-only)
  mockPrisma.daemonSession.findFirst.mockImplementation(
    async (args: { where: { sessionId: string } }) => {
      const sessionId = args.where.sessionId;
      if (sessionId === ONLINE_IDEA) return { originConnectionUuid: "conn-online" };
      if (sessionId === OFFLINE_IDEA) return { originConnectionUuid: "conn-offline" };
      return null;
    },
  );
  // The live connection registry: one online, one offline connection for the waker.
  mockListConnectionsForAgent.mockResolvedValue([
    { uuid: "conn-online", effectiveStatus: "online", agentName: CONNECTION_AGENT_NAME },
    { uuid: "conn-offline", effectiveStatus: "offline", agentName: CONNECTION_AGENT_NAME },
  ]);
  // Default task→idea resolution (only reached by the TASK-entity case).
  mockResolveDirectIdeaUuid.mockResolvedValue(ONLINE_IDEA);
});

describe("wake-carry-waker-session-anchor — server projection → daemon prompt (AC1)", () => {
  it("agent-caused idea wake with an ONLINE waker → NotificationResponse.wakerSession → advisory line", async () => {
    const [resp] = await project([makeRecord()]);

    // (a) The REAL resolver derived the anchor from the session + online connection, and the
    //     REAL projection carried it — agentName came from the connection registry, NOT actorName.
    expect(resp.wakerSession).toEqual({
      agentUuid: wakerAgentUuid,
      agentName: CONNECTION_AGENT_NAME,
      ideaUuid: ONLINE_IDEA,
    });
    expect(resp.actorName).toBe(ACTOR_NAME); // still the event actor's own denormalized name

    // (b) The REAL daemon prompt builder, fed that projection, renders the advisory line
    //     naming @[name](agent:uuid).
    const prompt = buildPrompt(toWakeInput(resp));
    expect(prompt).not.toBeNull();
    expect(prompt).toContain(ADVISORY_ONLINE);
    // The advisory names the waker via the connection-sourced name (proves the anchor drove it,
    // not the actor @mention which uses the actorName).
    expect(prompt).toContain(`@[${CONNECTION_AGENT_NAME}](agent:${wakerAgentUuid})`);
  });

  it("agent-caused TASK wake resolves its direct idea, then renders the same advisory line", async () => {
    const [resp] = await project([
      makeRecord({ entityType: "task", entityUuid: TASK_UUID }),
    ]);

    // The task's DIRECT containing idea was resolved and used as the anchor's ideaUuid.
    expect(mockResolveDirectIdeaUuid).toHaveBeenCalledWith(companyUuid, "task", TASK_UUID);
    expect(resp.wakerSession).toEqual({
      agentUuid: wakerAgentUuid,
      agentName: CONNECTION_AGENT_NAME,
      ideaUuid: ONLINE_IDEA,
    });

    const prompt = buildPrompt(toWakeInput(resp));
    expect(prompt).toContain(ADVISORY_ONLINE);
  });

  it("OFFLINE waker → NotificationResponse.wakerSession is null → NO advisory line (notify-only)", async () => {
    const [resp] = await project([makeRecord({ entityUuid: OFFLINE_IDEA })]);

    // The session exists but its origin connection is offline → the resolver returns null and
    // the projection carries no anchor.
    expect(resp.wakerSession).toBeNull();

    const prompt = buildPrompt(toWakeInput(resp));
    expect(prompt).not.toBeNull();
    // The unique advisory sentence is absent. (The per-action @mention markup may still name
    // the actor — that is NOT the anchor line, so we assert on the advisory's unique wording.)
    expect(prompt).not.toContain("woke you and has a live session open on this resource");
  });

  it("user-actor wake never resolves an anchor (no waker session, no line)", async () => {
    const [resp] = await project([
      makeRecord({ actorType: "user", actorUuid: "user-1", actorName: "Alice" }),
    ]);

    expect(resp.wakerSession).toBeNull();
    expect(mockPrisma.daemonSession.findFirst).not.toHaveBeenCalled();
    const prompt = buildPrompt(toWakeInput(resp));
    expect(prompt).not.toContain("woke you and has a live session");
  });
});

describe("wake-carry-waker-session-anchor — coalesced batch prompt (AC1, buildBatchPrompt)", () => {
  it("mixed batch: the ONLINE event's block carries the advisory line, the OFFLINE event's block does not", async () => {
    // Two agent-caused wakes on two DIFFERENT ideas (so buildBatchPrompt keeps them as two
    // blocks): one online waker, one offline. This is the feature's target scenario — a busy
    // worker draining a backlog — and the reviewer's expansion of T2 into buildBatchPrompt.
    const responses = await project([
      makeRecord({ uuid: "notif-online", entityUuid: ONLINE_IDEA }),
      makeRecord({ uuid: "notif-offline", entityUuid: OFFLINE_IDEA }),
    ]);
    const [online, offline] = responses;
    expect(online.wakerSession).not.toBeNull();
    expect(offline.wakerSession).toBeNull();

    const batch = buildBatchPrompt(responses.map(toWakeInput));
    expect(batch).not.toBeNull();

    // Multi-event path (size > 1): the backlog preamble and two labeled event blocks appear.
    expect(batch).toContain("queued Chorus events");
    expect(batch).toContain("### Event 1");
    expect(batch).toContain("### Event 2");

    // The advisory line appears EXACTLY ONCE — only in the online waker's block; the offline
    // event contributes no anchor line.
    expect(occurrences(batch as string, ADVISORY_ONLINE)).toBe(1);
    expect(occurrences(batch as string, "woke you and has a live session open on this resource")).toBe(1);
  });

  it("size-1 renderable batch is byte-identical to buildPrompt and still carries the anchor", async () => {
    const [resp] = await project([makeRecord()]);
    const single = buildPrompt(toWakeInput(resp));
    const batch = buildBatchPrompt([toWakeInput(resp)]);
    // buildBatchPrompt delegates a lone renderable event to buildPrompt verbatim.
    expect(batch).toBe(single);
    expect(batch).toContain(ADVISORY_ONLINE);
  });
});
