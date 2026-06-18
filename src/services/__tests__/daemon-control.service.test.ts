import { describe, it, expect, vi, beforeEach } from "vitest";

// ===== Prisma mock =====
// Only the daemonConnection table is touched by this service (owner resolution).
// A `notification` table is mocked too SOLELY so the test can assert it is NEVER
// touched — a control command must not be persisted as a Notification row.
const mockPrisma = vi.hoisted(() => ({
  daemonConnection: {
    findFirst: vi.fn(),
  },
  notification: {
    create: vi.fn(),
    createMany: vi.fn(),
  },
}));
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));

// Mock the EventBus so the unit test does not pull the real event-bus → redis →
// logger chain and can assert the publish emit shape + count directly. The real
// `controlEventName` is kept (it is a pure string helper, the routing contract).
const mockEventBus = vi.hoisted(() => ({ emit: vi.fn() }));
vi.mock("@/lib/event-bus", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/event-bus")>();
  return { ...actual, eventBus: mockEventBus };
});

import {
  CONTROL_COMMANDS,
  CONTROL_ENTITY_TYPES,
  resolveConnectionOwner,
  dispatchControl,
  authorizeConnectionControl,
} from "@/services/daemon-control.service";
import { controlEventName } from "@/lib/event-bus";

// ===== Helpers =====
const companyUuid = "company-0000-0000-0000-000000000001";
const otherCompanyUuid = "company-0000-0000-0000-000000000002";
const agentUuid = "agent-0000-0000-0000-000000000001";
const ownerUuid = "owner-0000-0000-0000-000000000001";
const connectionUuid = "conn-0000-0000-0000-000000000001";
const t1 = "task-0000-0000-0000-000000000001";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("daemon-control.service constants", () => {
  it("accepts the `interrupt` and `resume` control verbs (both ride the reverse channel)", () => {
    expect([...CONTROL_COMMANDS]).toEqual(["interrupt", "resume"]);
  });

  it("targets the execution registry's resource space", () => {
    expect([...CONTROL_ENTITY_TYPES]).toEqual(["task", "idea", "proposal", "document"]);
  });

  it("the control command is NOT a wake action (control is off the wake path)", async () => {
    // A control command must not be a member of the daemon's WAKE_ACTIONS — a
    // wake-action would make the daemon spawn a NEW Claude to "handle the
    // interrupt", the exact opposite of killing the running one. Read the daemon's
    // actual WAKE_ACTIONS set (the source of truth) via a runtime import so this
    // assertion tracks the real set, not a copy. The specifier is built at runtime
    // so the cross-boundary .mjs import is resolved by the test runner, not tsc.
    const promptsPath = `${"../"}../../../cli/prompts.mjs`;
    const { WAKE_ACTIONS } = (await import(promptsPath)) as {
      WAKE_ACTIONS: Set<string>;
    };
    for (const command of CONTROL_COMMANDS) {
      expect(WAKE_ACTIONS.has(command)).toBe(false);
    }
    expect(WAKE_ACTIONS.has("interrupt")).toBe(false);
    expect(WAKE_ACTIONS.has("control")).toBe(false);
  });
});

describe("resolveConnectionOwner (non-disclosure, company-scoped)", () => {
  it("resolves a connection within the company to its agent + owner", async () => {
    mockPrisma.daemonConnection.findFirst.mockResolvedValue({
      agentUuid,
      agent: { ownerUuid },
    });

    const result = await resolveConnectionOwner(companyUuid, connectionUuid);

    expect(result).toEqual({ agentUuid, ownerUuid });
    // The lookup is company-scoped: companyUuid is part of the WHERE so a
    // connection in another company never resolves.
    const where = mockPrisma.daemonConnection.findFirst.mock.calls[0][0].where;
    expect(where).toEqual({ uuid: connectionUuid, companyUuid });
  });

  it("returns null for a connection absent within the caller's company (→ route 404, non-disclosure)", async () => {
    // A connection in another company / non-existent → the company-scoped query
    // matches nothing → null. Indistinguishable from "does not exist".
    mockPrisma.daemonConnection.findFirst.mockResolvedValue(null);

    const result = await resolveConnectionOwner(otherCompanyUuid, connectionUuid);

    expect(result).toBeNull();
  });

  it("projects ownerUuid=null for an unowned/system agent (only task:admin can then authorize)", async () => {
    mockPrisma.daemonConnection.findFirst.mockResolvedValue({
      agentUuid,
      agent: { ownerUuid: null },
    });

    const result = await resolveConnectionOwner(companyUuid, connectionUuid);

    expect(result).toEqual({ agentUuid, ownerUuid: null });
  });

  it("projects ownerUuid=null when the agent relation cannot be resolved", async () => {
    mockPrisma.daemonConnection.findFirst.mockResolvedValue({
      agentUuid,
      agent: null,
    });

    const result = await resolveConnectionOwner(companyUuid, connectionUuid);

    expect(result).toEqual({ agentUuid, ownerUuid: null });
  });

  it("does NOT swallow a query failure (a READ — propagates so the route surfaces a 500)", async () => {
    mockPrisma.daemonConnection.findFirst.mockRejectedValue(new Error("db down"));
    await expect(resolveConnectionOwner(companyUuid, connectionUuid)).rejects.toThrow("db down");
  });
});

describe("dispatchControl (the single publish seam — q8=a)", () => {
  it("emits exactly once on the per-connection control channel with the control event shape", () => {
    dispatchControl({
      companyUuid,
      targetConnectionUuid: connectionUuid,
      command: "interrupt",
      entityType: "task",
      entityUuid: t1,
    });

    expect(mockEventBus.emit).toHaveBeenCalledTimes(1);
    const [channel, payload] = mockEventBus.emit.mock.calls[0];
    // Keyed per connection — NOT per agent — so only the daemon stream holding
    // the subprocess receives it.
    expect(channel).toBe(controlEventName(connectionUuid));
    expect(channel).toBe(`control:${connectionUuid}`);
    expect(payload).toEqual({
      type: "control",
      command: "interrupt",
      targetConnectionUuid: connectionUuid,
      entityType: "task",
      entityUuid: t1,
    });
  });

  it("NEVER persists a Notification row (control is off the wake path)", () => {
    dispatchControl({
      companyUuid,
      targetConnectionUuid: connectionUuid,
      command: "interrupt",
      entityType: "task",
      entityUuid: t1,
    });

    expect(mockPrisma.notification.create).not.toHaveBeenCalled();
    expect(mockPrisma.notification.createMany).not.toHaveBeenCalled();
  });

  it("does not carry companyUuid into the wire payload (the daemon stream is already company-scoped)", () => {
    dispatchControl({
      companyUuid,
      targetConnectionUuid: connectionUuid,
      command: "interrupt",
      entityType: "idea",
      entityUuid: "idea-x",
    });
    const [, payload] = mockEventBus.emit.mock.calls[0];
    expect(payload).not.toHaveProperty("companyUuid");
  });
});

// ===== authorizeConnectionControl (shared authz for control / report-interrupt / resume) =====
describe("authorizeConnectionControl", () => {
  it("not_found when the connection does not resolve in-company (404 non-disclosure)", async () => {
    mockPrisma.daemonConnection.findFirst.mockResolvedValue(null);
    const res = await authorizeConnectionControl({
      companyUuid,
      actorUuid: ownerUuid,
      hasTaskAdmin: false,
      connectionUuid,
    });
    expect(res).toEqual({ ok: false, reason: "not_found" });
  });

  it("ok when the caller IS the connection agent's owner", async () => {
    mockPrisma.daemonConnection.findFirst.mockResolvedValue({
      agentUuid,
      agent: { ownerUuid },
    });
    const res = await authorizeConnectionControl({
      companyUuid,
      actorUuid: ownerUuid,
      hasTaskAdmin: false,
      connectionUuid,
    });
    expect(res).toEqual({ ok: true, target: { agentUuid, ownerUuid } });
  });

  it("ok when the caller is not the owner but holds task:admin", async () => {
    mockPrisma.daemonConnection.findFirst.mockResolvedValue({
      agentUuid,
      agent: { ownerUuid },
    });
    const res = await authorizeConnectionControl({
      companyUuid,
      actorUuid: "someone-else",
      hasTaskAdmin: true,
      connectionUuid,
    });
    expect(res.ok).toBe(true);
  });

  it("forbidden when the caller is neither the owner nor task:admin", async () => {
    mockPrisma.daemonConnection.findFirst.mockResolvedValue({
      agentUuid,
      agent: { ownerUuid },
    });
    const res = await authorizeConnectionControl({
      companyUuid,
      actorUuid: "someone-else",
      hasTaskAdmin: false,
      connectionUuid,
    });
    expect(res).toEqual({ ok: false, reason: "forbidden" });
  });

  it("forbidden when the agent has no owner and the caller lacks task:admin", async () => {
    mockPrisma.daemonConnection.findFirst.mockResolvedValue({
      agentUuid,
      agent: { ownerUuid: null },
    });
    const res = await authorizeConnectionControl({
      companyUuid,
      actorUuid: ownerUuid,
      hasTaskAdmin: false,
      connectionUuid,
    });
    expect(res).toEqual({ ok: false, reason: "forbidden" });
  });
});

// ===== dispatchControl supports the resume verb too =====
describe("dispatchControl resume", () => {
  it("emits a resume control event on the per-connection channel", () => {
    dispatchControl({
      companyUuid,
      targetConnectionUuid: connectionUuid,
      command: "resume",
      entityType: "task",
      entityUuid: t1,
    });
    expect(mockEventBus.emit).toHaveBeenCalledTimes(1);
    const [channel, event] = mockEventBus.emit.mock.calls[0];
    expect(channel).toBe(controlEventName(connectionUuid));
    expect(event).toMatchObject({ type: "control", command: "resume", entityType: "task", entityUuid: t1 });
  });
});
