import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// Real daemon live/backfill gates + real entity/effective-role resolution. Only
// database/transport adapters are faked; neither access function is stubbed.
const fixture = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require("events") as typeof import("events");
  const bus = new EventEmitter();
  const state = {
    groupRole: "editor" as string | null,
    localRole: null as string | null,
    ownerUuid: "owner" as string | null,
    taskExists: true,
    notifications: [] as Array<{ entityUuid: string; projectUuid: string }>,
  };
  const sessions = [
    { uuid: "task-session", sessionId: "standalone-task", directIdeaUuid: null, runtimeCwd: "/private/task", companyUuid: "company", agentUuid: "agent", originConnectionUuid: "connection" },
    { uuid: "comment-session", sessionId: "project-comment", directIdeaUuid: null, runtimeCwd: "/private/comment", companyUuid: "company", agentUuid: "agent", originConnectionUuid: "connection" },
    { uuid: "adhoc-session", sessionId: "adhoc-key", directIdeaUuid: null, runtimeCwd: null, companyUuid: "company", agentUuid: "agent", originConnectionUuid: "connection" },
  ];
  const turns = [
    { uuid: "task-turn", sessionUuid: "task-session", seq: 1, trigger: "task_assigned", promptText: null, operationPayload: null, status: "pending", session: sessions[0] },
    { uuid: "comment-turn", sessionUuid: "comment-session", seq: 1, trigger: "mentioned", promptText: null, operationPayload: null, status: "pending", session: sessions[1] },
    { uuid: "adhoc-turn", sessionUuid: "adhoc-session", seq: 1, trigger: "human_instruction", promptText: "Hello", operationPayload: null, status: "pending", session: sessions[2] },
  ];
  const sessionMatches = (session: typeof sessions[number], where: Record<string, unknown>) =>
    Object.entries(where).every(([key, value]) => session[key as keyof typeof session] === value);
  const prisma = {
    task: { findFirst: vi.fn(async ({ where }: { where: { uuid: string; companyUuid: string } }) =>
      state.taskExists && where.companyUuid === "company" && where.uuid === "standalone-task" ? { projectUuid: "private-project" } : null) },
    comment: { findFirst: vi.fn(async ({ where }: { where: { uuid: string; companyUuid: string } }) =>
      where.companyUuid === "company" && where.uuid === "project-comment" ? { targetType: "task", targetUuid: "standalone-task" } : null) },
    idea: { findFirst: vi.fn(async () => null) },
    proposal: { findFirst: vi.fn(async () => null) },
    document: { findFirst: vi.fn(async () => null) },
    project: { findFirst: vi.fn(async ({ where }: { where: { uuid: string; companyUuid: string } }) =>
      where.companyUuid === "company" && where.uuid === "private-project"
        ? { uuid: "private-project", companyUuid: "company", visibility: "private", groupUuid: "private-group" } : null) },
    agent: { findFirst: vi.fn(async ({ where }: { where: { uuid: string; companyUuid: string } }) =>
      where.companyUuid === "company" && where.uuid === "agent" ? { ownerUuid: state.ownerUuid } : null) },
    projectMember: {
      findUnique: vi.fn(async ({ where }: { where: { companyUuid: string } }) =>
        where.companyUuid === "company" && state.localRole ? { role: state.localRole } : null),
      findFirst: vi.fn(async () => state.localRole === "admin" ? { userUuid: state.ownerUuid, role: "admin" } : null),
    },
    projectGroup: { findFirst: vi.fn(async () => ({ uuid: "private-group", companyUuid: "company" })) },
    user: { findFirst: vi.fn(async () => null) },
    projectGroupMember: { findFirst: vi.fn() },
    notification: { findFirst: vi.fn(async ({ where }: { where: { companyUuid: string; recipientUuid: string; entityUuid: string } }) =>
      where.companyUuid === "company" && where.recipientUuid === "agent"
        ? state.notifications.find((n) => n.entityUuid === where.entityUuid && n.projectUuid !== "") ?? null : null) },
    daemonSessionTurn: {
      findFirst: vi.fn(async ({ where }: { where: { uuid?: string; sessionUuid?: string; trigger?: { not: string }; session: Record<string, unknown> } }) =>
        turns.find((t) =>
          (where.uuid ? t.uuid === where.uuid : t.sessionUuid === where.sessionUuid && t.trigger !== where.trigger?.not) &&
          sessionMatches(t.session, where.session)) ?? null),
      findMany: vi.fn(async ({ where }: { where: { status: string; session: Record<string, unknown> } }) =>
        turns.filter((t) => t.status === where.status && sessionMatches(t.session, where.session))),
    },
  };
  return { bus, state, sessions, turns, prisma };
});
vi.mock("@/lib/prisma", () => ({ prisma: fixture.prisma }));
vi.mock("@/lib/event-bus", () => ({ eventBus: fixture.bus, controlEventName: (uuid: string) => `control:${uuid}` }));
vi.mock("@/lib/auth", () => ({ getAuthContext: vi.fn(async () => ({ type: "agent", actorUuid: "agent", companyUuid: "company", ownerUuid: "owner" })) }));
vi.mock("@/services/daemon-connection.service", () => ({
  STALE_THRESHOLD_MS: 90_000, parseSelfReport: () => ({}),
  registerConnection: async () => ({ uuid: "connection", connectedAt: new Date() }),
  isConnectionConflict: () => false, touchConnection: vi.fn(), markDisconnected: vi.fn(),
}));
vi.mock("@/services/daemon-execution.service", () => ({
  reconcileOffline: async () => 0, publishExecutionChange: async () => undefined,
}));
import { canAgentReceiveTurn, getPendingTurnsForConnection } from "@/services/daemon-session.service";
import { GET } from "@/app/api/events/notifications/route";

beforeEach(() => {
  vi.clearAllMocks();
  fixture.bus.removeAllListeners();
  fixture.turns.length = 3;
  Object.assign(fixture.state, { groupRole: "editor", localRole: null, ownerUuid: "owner", taskExists: true, notifications: [] });
  fixture.prisma.projectGroupMember.findFirst.mockImplementation(async ({ where }: { where: { role?: string } }) =>
    fixture.state.groupRole && (!where.role || where.role === fixture.state.groupRole)
      ? { role: fixture.state.groupRole } : null);
});
const pending = () => getPendingTurnsForConnection({ companyUuid: "company", agentUuid: "agent", connectionUuid: "connection" });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
async function stream() {
  const abort = new AbortController();
  const response = await GET(new NextRequest("http://localhost/api/events/notifications", { signal: abort.signal }));
  const reader = response.body!.getReader();
  const chunks: string[] = [];
  void (async () => {
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(decoder.decode(value));
    }
  })();
  await flush();
  return { abort, text: () => chunks.join("") };
}
const ping = (turnUuid: string) => fixture.bus.emit("control:connection", {
  type: "control", command: "deliver_turn", targetConnectionUuid: "connection", turnUuid, runtimeCwd: "/private/work",
});

describe.each(["task-turn", "comment-turn"])("%s standalone project provenance", (turnUuid) => {
  it("checks real inherited owner access for live and reconnect delivery without an idea", async () => {
    expect(await canAgentReceiveTurn("company", "agent", turnUuid)).toBe(true);
    expect((await pending()).map((t) => t.turnUuid)).toContain(turnUuid);
    expect(fixture.prisma.projectGroupMember.findFirst).toHaveBeenCalledWith({
      where: { companyUuid: "company", groupUuid: "private-group", userUuid: "owner" }, select: { role: true },
    });
  });

  it("withholds live and backfill turn/cwd after the last group grant is removed", async () => {
    fixture.state.groupRole = null;
    expect(await canAgentReceiveTurn("company", "agent", turnUuid)).toBe(false);
    expect((await pending()).map((t) => t.turnUuid)).not.toContain(turnUuid);
    expect(await pending()).toEqual([expect.objectContaining({ turnUuid: "adhoc-turn", runtimeCwd: null })]);
  });

  it("keeps the independent local Viewer grant after group revocation", async () => {
    fixture.state.groupRole = null;
    fixture.state.localRole = "viewer";
    expect(await canAgentReceiveTurn("company", "agent", turnUuid)).toBe(true);
    expect((await pending()).map((t) => t.turnUuid)).toContain(turnUuid);
  });

  it("protects a human-instruction continuation on the same standalone entity session", async () => {
    const source = fixture.turns.find((turn) => turn.uuid === turnUuid)!;
    const followup = { ...source, uuid: `${turnUuid}-followup`, seq: 2, trigger: "human_instruction", promptText: "Private follow-up" };
    fixture.turns.push(followup);
    fixture.state.groupRole = null;
    expect(await canAgentReceiveTurn("company", "agent", followup.uuid)).toBe(false);
    expect((await pending()).map((t) => t.turnUuid)).not.toContain(followup.uuid);
    fixture.state.localRole = "viewer";
    expect(await canAgentReceiveTurn("company", "agent", followup.uuid)).toBe(true);
    expect((await pending()).map((t) => t.turnUuid)).toContain(followup.uuid);
  });

  it("does not expose a deleted entity's follow-up as ad-hoc even without a notification record", async () => {
    const source = fixture.turns.find((turn) => turn.uuid === turnUuid)!;
    const followup = { ...source, uuid: `${turnUuid}-followup`, seq: 2, trigger: "human_instruction", promptText: "Private follow-up" };
    fixture.turns.push(followup);
    fixture.state.taskExists = false;
    expect(await canAgentReceiveTurn("company", "agent", followup.uuid)).toBe(false);
    expect((await pending()).map((t) => t.turnUuid)).not.toContain(followup.uuid);
  });

  it("does not deliver delayed control events to a revoked owner-backed agent", async () => {
    const live = await stream();
    try {
      fixture.state.groupRole = null;
      ping(turnUuid);
      await flush();
      expect(live.text()).not.toContain(turnUuid);
      expect(live.text()).not.toContain("/private/work");
    } finally { live.abort.abort(); }
  });

  it("rechecks an in-flight grant snapshot when revocation races the serial delivery gate", async () => {
    const live = await stream();
    let release!: () => void;
    fixture.prisma.projectGroupMember.findFirst.mockImplementationOnce(() => new Promise((resolve) => {
      release = () => resolve({ role: "editor" });
    }));
    try {
      ping(turnUuid);
      await flush();
      fixture.state.groupRole = null;
      fixture.bus.emit("project_access_changed", { companyUuid: "company", projectUuid: "private-project", userUuids: ["owner"] });
      release();
      await flush();
      expect(live.text()).not.toContain(turnUuid);
      expect(fixture.prisma.projectGroupMember.findFirst).toHaveBeenCalledTimes(4);
    } finally { live.abort.abort(); }
  });
});

describe("unanchored session classification", () => {
  it("preserves genuinely projectless ad-hoc human instructions in both paths", async () => {
    fixture.state.groupRole = null;
    expect(await canAgentReceiveTurn("company", "agent", "adhoc-turn")).toBe(true);
    expect((await pending()).map((t) => t.turnUuid)).toEqual(["adhoc-turn"]);
  });

  it("does not reinterpret deleted standalone task/comment wakes as projectless", async () => {
    fixture.state.taskExists = false;
    expect(await canAgentReceiveTurn("company", "agent", "task-turn")).toBe(false);
    expect(await canAgentReceiveTurn("company", "agent", "comment-turn")).toBe(false);
    expect((await pending()).map((t) => t.turnUuid)).toEqual(["adhoc-turn"]);
  });

  it("withholds a deleted project's human-instruction continuation using existing notification provenance", async () => {
    fixture.state.notifications.push({ entityUuid: "adhoc-key", projectUuid: "private-project" });
    expect(await canAgentReceiveTurn("company", "agent", "adhoc-turn")).toBe(false);
    expect((await pending()).map((t) => t.turnUuid)).not.toContain("adhoc-turn");
  });

  it("an ownerless agent cannot receive unanchored private task/comment turns", async () => {
    fixture.state.ownerUuid = null;
    expect(await canAgentReceiveTurn("company", "agent", "task-turn")).toBe(false);
    expect(await canAgentReceiveTurn("company", "agent", "comment-turn")).toBe(false);
    expect((await pending()).map((t) => t.turnUuid)).toEqual(["adhoc-turn"]);
  });
});
