import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { setTimeout as realDelay } from "node:timers/promises";

const { bus, db, services } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require("events") as typeof import("events");
  const bus = new EventEmitter();
  bus.setMaxListeners(0);
  return {
    bus,
    db: { user: { findFirst: vi.fn() }, apiKey: { findUnique: vi.fn(), update: vi.fn() } },
    services: { access: vi.fn(), snapshot: vi.fn(), turn: vi.fn(), touch: vi.fn(), disconnected: vi.fn() },
  };
});
vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/event-bus", () => ({ eventBus: bus, controlEventName: (uuid: string) => `control:${uuid}` }));
vi.mock("@/services/project-access.service", () => ({
  accessibleProjectUuids: async () => ["public"],
  canActorAccessProject: (...args: unknown[]) => services.access(...args),
  membershipPrincipal: (auth: { type: string; actorUuid: string; ownerUuid?: string }) => auth.type === "user" ? auth.actorUuid : auth.ownerUuid,
  resolveEntityProjectUuid: async () => "public",
  filterExecutionViewsByAccess: async (_auth: unknown, rows: unknown[]) => rows,
}));
vi.mock("@/services/project-group-access.service", () => ({ accessibleGroupUuids: async () => [], getGroupAccess: async () => ({ group: {} }) }));
vi.mock("@/services/project-group-implicit-admin.service", () => ({ firstCompanyUser: async () => null, invalidateImplicitGroupAdminCache: vi.fn() }));
const connection = { uuid: "connection", connectedAt: new Date("2026-10-15T00:00:00Z") };
vi.mock("@/services/daemon-connection.service", () => ({
  parseSelfReport: () => ({}), registerConnection: async () => ({ uuid: "connection", connectedAt: new Date("2026-10-15T00:00:00Z") }),
  isConnectionConflict: () => false, touchConnection: (...args: unknown[]) => services.touch(...args),
  markDisconnected: (...args: unknown[]) => services.disconnected(...args), STALE_THRESHOLD_MS: 90_000,
}));
vi.mock("@/services/daemon-execution.service", () => ({
  listVisibleConnectionUuids: async () => ["connection"], executionEventName: (uuid: string) => `execution:${uuid}`,
  reconcileOffline: async () => 0, publishExecutionChange: async () => {},
}));
vi.mock("@/services/daemon-session.service", () => ({
  isSessionVisibleToCaller: async () => true, transcriptEventName: (uuid: string) => `transcript:${uuid}`,
  listVisibleRunningSessionActivities: (...args: unknown[]) => services.snapshot(...args),
  SESSION_ACTIVITY_EVENT_NAME: "session_activity", reconcileOrphanTurns: async () => 0,
  canAgentReceiveTurn: (...args: unknown[]) => services.turn(...args), getWakeRecoveryDelivery: async () => null,
}));

// Deliberately real auth, JWT verification, owner validation, and DB state helper.
// Only persistence/project/daemon services are in-memory; no env file or DB is touched.
import { GET as events } from "../route";
import { GET as notifications } from "../notifications/route";
import { createUserAccessToken } from "@/lib/user-session";

const companyUuid = "company";
const userUuid = "human";
let account: {
  uuid: string; companyUuid: string; email: string; name: string; authType: string;
  status: string; deletedAt: Date | null; sessionVersion: number; workspaceAdmin: boolean;
  company: { localAuthEnabled: boolean; oidcEnabled: boolean };
};
let key: { uuid: string; revokedAt: Date | null; expiresAt: Date | null; agent: {
  uuid: string; name: string; companyUuid: string; ownerUuid: string | null; roles: string[]; permissions: string[];
} };
let stops: (() => void)[];
// Real JWT verification uses asynchronous WebCrypto, not only promise jobs.
// This imported timer is independent of fake heartbeat timers.
async function flush() { await realDelay(10); }

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("NEXTAUTH_SECRET", "isolated-sse-regression-secret");
  bus.removeAllListeners();
  stops = [];
  account = { uuid: userUuid, companyUuid, email: "test@example.test", name: "Test", authType: "local", status: "active", deletedAt: null, sessionVersion: 4, workspaceAdmin: false, company: { localAuthEnabled: true, oidcEnabled: false } };
  key = { uuid: "key", revokedAt: null, expiresAt: null, agent: { uuid: "agent", name: "Agent", companyUuid, ownerUuid: userUuid, roles: ["developer_agent"], permissions: [] } };
  db.user.findFirst.mockImplementation(async () => structuredClone(account));
  db.apiKey.findUnique.mockImplementation(async () => structuredClone(key));
  db.apiKey.update.mockResolvedValue({});
  services.access.mockResolvedValue(true);
  services.turn.mockResolvedValue(true);
  services.snapshot.mockResolvedValue([]);
});
afterEach(() => {
  for (const stop of stops) stop();
  vi.useRealTimers(); vi.unstubAllEnvs();
});

async function connect(route: typeof events, principal: "cookie" | "bearer" | "sso" | "owned-agent" | "unowned-agent") {
  let headers: Record<string, string>;
  if (principal.endsWith("agent")) {
    if (principal === "unowned-agent") key.agent.ownerUuid = null;
    headers = { authorization: "Bearer cho_sse_test" };
  } else {
    if (principal === "sso") { account.authType = "oidc"; account.company.localAuthEnabled = false; account.company.oidcEnabled = true; }
    const token = await createUserAccessToken({ type: "user", userUuid, companyUuid, email: account.email, oidcSub: "subject", ...(principal === "sso" ? {} : { authType: "local" as const, sessionVersion: account.sessionVersion }) });
    headers = principal === "bearer" ? { authorization: `Bearer ${token}` } : { cookie: `user_session=${token}` };
  }
  const abort = new AbortController();
  stops.push(() => abort.abort());
  const request = new NextRequest("http://localhost/api/events?sessionUuid=session", { headers, signal: abort.signal });
  const response = await route(request);
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  const chunks: string[] = [];
  let ended = false;
  let onChunk: (() => void) | undefined;
  void (async () => { for (;;) { const { done, value } = await reader.read(); if (done) { ended = true; return; } chunks.push(new TextDecoder().decode(value)); onChunk?.(); } })();
  await flush();
  chunks.length = 0; // Ignore legitimate connect/registration handshakes.
  return { request, reader, chunks, ended: () => ended, onData: (callback: () => void) => { onChunk = callback; }, actorUuid: principal.endsWith("agent") ? "agent" : userUuid, type: principal.endsWith("agent") ? "agent" : "user" };
}
function emitProtected(stream: { actorUuid: string; type: string }) {
  const event = { companyUuid, projectUuid: "public", entityType: "task", entityUuid: "task", action: "updated", message: "confidential" };
  bus.emit("change", event);
  bus.emit("presence", event);
  bus.emit(`notification:${stream.type}:${stream.actorUuid}`, { type: "new_notification", ...event });
  bus.emit(`notification:${stream.type}:${stream.actorUuid}`, { type: "new_notification", message: "confidential unscoped" });
  bus.emit("execution:connection", { companyUuid, executions: [{ title: "confidential execution" }] });
  bus.emit("transcript:session", { companyUuid, text: "confidential transcript" });
  bus.emit("session_activity", { companyUuid, agentUuid: "agent", agentOwnerUuid: userUuid, directIdeaUuid: null, message: "confidential activity" });
  bus.emit("control:connection", { type: "control", command: "interrupt", message: "confidential control" });
  bus.emit("control:connection", { type: "control", command: "deliver_turn", turnUuid: "confidential turn" });
}

for (const [label, route] of [["events", events], ["notifications", notifications]] as const) {
  describe(`${label}: authoritative live auth revocation`, () => {
    it("cleans up cancellation during initial authentication without using uninitialized teardown", async () => {
      const abort = new AbortController();
      db.apiKey.findUnique.mockImplementationOnce(async () => { abort.abort(); return structuredClone(key); });
      const response = await route(new NextRequest("http://localhost/api/events", {
        headers: { authorization: "Bearer cho_sse_test" }, signal: abort.signal,
      }));
      expect(response.status).toBe(200);
      expect((await response.body!.getReader().read()).done).toBe(true);
      await flush();
      expect(services.disconnected).toHaveBeenCalledExactlyOnceWith(companyUuid, connection);
      expect(bus.eventNames()).toEqual([]);
    });
    for (const principal of ["cookie", "bearer", "owned-agent"] as const) {
      it.each(["disabled", "deleted", "missing", ...(principal === "owned-agent" ? [] : ["reset", "generation"])])(`${principal}: no protected delivery after committed %s broadcast`, async (mutation) => {
        const stream = await connect(route, principal);
        if (mutation === "disabled") account.status = "disabled";
        if (mutation === "deleted") { account.status = "deleted"; account.deletedAt = new Date(); }
        if (mutation === "missing") db.user.findFirst.mockResolvedValue(null);
        if (mutation === "reset" || mutation === "generation") account.sessionVersion++;
        expect((await route(stream.request)).status).toBe(401);
        bus.emit("account_access_changed", { companyUuid, userUuid });
        emitProtected(stream);
        await flush();
        expect(stream.chunks).toEqual([]);
        expect(stream.ended()).toBe(true);
        expect(bus.eventNames()).toEqual([]);
        expect(services.disconnected).toHaveBeenCalledExactlyOnceWith(companyUuid, connection);
      });
    }
    it.each(["cookie", "owned-agent"] as const)("closes quiet revoked %s stream on heartbeat without refreshing liveness", async principal => {
      vi.useFakeTimers();
      const stream = await connect(route, principal);
      account.status = "disabled";
      await vi.advanceTimersByTimeAsync(30_000);
      await flush();
      expect(stream.chunks).toEqual([]);
      expect(stream.ended()).toBe(true);
      expect(services.touch).not.toHaveBeenCalled();
      expect(bus.eventNames()).toEqual([]);
    });
    it.each(["sso", "unowned-agent"] as const)("preserves valid %s protected delivery and heartbeat", async principal => {
      vi.useFakeTimers();
      const stream = await connect(route, principal);
      if (principal === "unowned-agent") account.status = "disabled"; // unrelated user is not its owner
      emitProtected(stream);
      await flush();
      expect(stream.chunks.join("")).toContain("confidential");
      await vi.advanceTimersByTimeAsync(30_000);
      await flush();
      expect(stream.chunks.join("")).toContain(": heartbeat");
      expect(stream.ended()).toBe(false);
      expect(services.touch).toHaveBeenCalled();
    });
    it("invalidates queued delivery when a committed generation change is broadcast", async () => {
      const stream = await connect(route, "cookie");
      stream.onData(() => { account.sessionVersion++; bus.emit("account_access_changed", { companyUuid, userUuid }); });
      emitProtected(stream);
      await flush();
      expect(stream.chunks).toHaveLength(1);
      expect(stream.ended()).toBe(true);
      expect(bus.eventNames()).toEqual([]);
    });
    it("abort during a pending auth check prevents enqueue and queued work", async () => {
      const stream = await connect(route, "owned-agent");
      let release!: (value: typeof account) => void;
      db.user.findFirst.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
      bus.emit("account_access_changed", { companyUuid, userUuid });
      emitProtected(stream);
      await flush();
      stops[0]();
      release(structuredClone(account));
      await flush();
      expect(stream.chunks).toEqual([]);
      expect(bus.eventNames()).toEqual([]);
      expect(services.disconnected).toHaveBeenCalledTimes(1);
    });
    it.each(["revoked-key", "expired-key", "changed-owner"])("closes an owned-agent stream on %s", async mutation => {
      const stream = await connect(route, "owned-agent");
      if (mutation === "revoked-key") key.revokedAt = new Date();
      if (mutation === "expired-key") key.expiresAt = new Date(0);
      if (mutation === "changed-owner") key.agent.ownerUuid = "different-owner";
      bus.emit("account_access_changed", { companyUuid, keyUuid: key.uuid });
      emitProtected(stream);
      await flush();
      expect(stream.chunks).toEqual([]);
      expect(stream.ended()).toBe(true);
      expect(bus.eventNames()).toEqual([]);
    });
    it("does not revoke an otherwise eligible owner's key on password-only reset", async () => {
      const stream = await connect(route, "owned-agent");
      account.sessionVersion++;
      bus.emit("account_access_changed", { companyUuid, userUuid });
      emitProtected(stream);
      await flush();
      expect(stream.chunks.join("")).toContain("confidential");
      expect(stream.ended()).toBe(false);
    });
    it("fails closed on authoritative DB failure", async () => {
      const stream = await connect(route, "cookie");
      db.user.findFirst.mockRejectedValue(new Error("isolated DB failure"));
      bus.emit("account_access_changed", { companyUuid, userUuid });
      emitProtected(stream);
      await flush();
      expect(stream.chunks).toEqual([]);
      expect(stream.ended()).toBe(true);
      expect(bus.eventNames()).toEqual([]);
    });
    it.each(["cookie", "owned-agent"] as const)("ordinary %s message bursts do not reread auth or write key usage", async principal => {
      const stream = await connect(route, principal);
      const reads = db.user.findFirst.mock.calls.length;
      const keyReads = db.apiKey.findUnique.mock.calls.length;
      const writes = db.apiKey.update.mock.calls.length;
      for (let i = 0; i < 20; i++) emitProtected(stream);
      await flush();
      expect(stream.chunks.join("")).toContain("confidential");
      expect(db.user.findFirst).toHaveBeenCalledTimes(reads);
      expect(db.apiKey.findUnique).toHaveBeenCalledTimes(keyReads);
      expect(db.apiKey.update).toHaveBeenCalledTimes(writes);
    });
    it("missed cross-instance invalidation is detected by bounded lease renewal", async () => {
      vi.useFakeTimers();
      const stream = await connect(route, "cookie");
      account.status = "disabled"; // another instance committed; Redis delivery lost
      await vi.advanceTimersByTimeAsync(30_000);
      emitProtected(stream);
      await flush();
      expect(stream.chunks).toEqual([]);
      expect(stream.ended()).toBe(true);
    });
    it("a delayed old broadcast preserves a newly minted current session", async () => {
      account.sessionVersion++;
      const stream = await connect(route, "cookie");
      bus.emit("account_access_changed", { companyUuid, userUuid });
      emitProtected(stream);
      await flush();
      expect(stream.chunks.join("")).toContain("confidential");
      expect(stream.ended()).toBe(false);
    });
    it("reader cancellation removes listeners and disconnects exactly once", async () => {
      const stream = await connect(route, "cookie");
      await stream.reader.cancel();
      stops[0]();
      expect(bus.eventNames()).toEqual([]);
      expect(services.disconnected).toHaveBeenCalledTimes(1);
    });
  });
}

it("notifications: revocation while project authorization is pending drops queued notification/control deliveries", async () => {
  const stream = await connect(notifications, "owned-agent");
  let release!: (allowed: boolean) => void;
  services.access.mockImplementationOnce(() => new Promise<boolean>(resolve => { release = resolve; }));
  bus.emit("notification:agent:agent", { type: "new_notification", projectUuid: "public", message: "confidential queued" });
  await flush();
  account.status = "disabled";
  bus.emit("account_access_changed", { companyUuid, userUuid });
  bus.emit("control:connection", { type: "control", command: "interrupt", message: "confidential control" });
  release(true);
  await flush();
  expect(stream.chunks).toEqual([]);
  expect(stream.ended()).toBe(true);
  expect(bus.eventNames()).toEqual([]);
});

it("events: generation invalidation during initial snapshot drops replay and buffered activity", async () => {
  let release!: (rows: unknown[]) => void;
  services.snapshot.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const stream = await connect(events, "cookie");
  bus.emit("session_activity", { companyUuid, agentUuid: "agent", agentOwnerUuid: userUuid, directIdeaUuid: null, message: "confidential buffered" });
  await flush();
  account.sessionVersion++;
  bus.emit("account_access_changed", { companyUuid, userUuid });
  release([{ companyUuid, directIdeaUuid: null, message: "confidential replay" }]);
  await flush();
  expect(stream.chunks).toEqual([]);
  expect(stream.ended()).toBe(true);
  expect(bus.eventNames()).toEqual([]);
});
