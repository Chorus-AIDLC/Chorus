import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDaemon } from "../daemon.mjs";

const silent = { info() {}, warn() {}, error() {} };
const sessionId = "11111111-1111-4111-8111-111111111111";
const attribution = { key: `idea:${sessionId}`, directIdeaUuid: sessionId, rootIdeaUuid: sessionId };
const cleanups = [];
let home;

async function flush() {
  for (let count = 0; count < 150; count++) await Promise.resolve();
}

function row(turnUuid) {
  const notification = {
    uuid: `notification-${turnUuid}`, action: "mentioned", entityType: "idea", entityUuid: sessionId,
    entityTitle: "Admission regression", message: `instruction-${turnUuid}`, actorName: "Tester",
  };
  return {
    turnUuid, sessionId, directIdeaUuid: sessionId, trigger: "mentioned", wakeRecoveryProtocol: 1,
    wakeContext: { version: 1, notificationUuid: notification.uuid, notification },
  };
}

function event(turn) {
  return { type: "new_notification", notificationUuid: turn.wakeContext.notificationUuid, ...turn };
}

function fixture({ lost = false, late = false, holdFirst = false } = {}) {
  const rows = new Map();
  const reports = [];
  let listener;
  let finishFirst;
  let lateResponse;
  let firstAdmission = true;
  let deny = false;
  let pendingStatus = 200;
  const response = (data = {}, status = 200) => new Response(JSON.stringify({ success: status === 200, data }), { status });
  const fetchImpl = vi.fn(async (url, options = {}) => {
    if (url.includes("/pending-turns")) {
      if (pendingStatus !== 200) return response({}, pendingStatus);
      const connectionUuid = new URL(url).searchParams.get("connectionUuid");
      return response({ turns: [...rows.values()].filter((entry) => entry.status === "pending" && entry.access && entry.connectionUuid === connectionUuid).map((entry) => entry.turn) });
    }
    if (!url.includes("/turn-advance")) return response();
    const report = JSON.parse(options.body);
    reports.push(report);
    const members = report.turnUuids.map((turnUuid) => rows.get(turnUuid));
    if (members.some((entry) => !entry || entry.connectionUuid !== report.connectionUuid)) return response({}, 409);
    if (report.status === "running") {
      if (members.every((entry) => entry.admissionUuid === report.admissionUuid) && members[0].status === "running") {
        return response({ turn: { uuid: report.turnUuid } });
      }
      if (members.some((entry) => !entry.access)) return response({}, 404);
      if (deny || members.some((entry) => entry.status !== "pending")) return response({}, 409);
      members.forEach((entry, index) => {
        entry.status = index === 0 ? "running" : "merged";
        entry.admissionUuid = report.admissionUuid;
      });
      if (firstAdmission && (lost || late)) {
        firstAdmission = false;
        if (late) return new Promise((resolve) => { lateResponse = () => resolve(response({ turn: { uuid: report.turnUuid } })); });
        throw new TypeError("Synthetic lost response after commit");
      }
    } else if (members[0].admissionUuid === report.admissionUuid) {
      members[0].status = report.status;
    }
    return response({ turn: { uuid: report.turnUuid } });
  });
  const spawner = { wake: vi.fn(async ({ onChild }) => {
    onChild({ pid: 4242 });
    if (holdFirst && spawner.wake.mock.calls.length === 1) {
      return new Promise((resolve) => { finishFirst = () => resolve({ sessionId, exitCode: 0 }); });
    }
    return { sessionId, exitCode: 0 };
  }) };
  const daemon = buildDaemon({ url: "https://isolated.invalid", apiKey: "synthetic" }, {
    cwd: home, browseRoots: [home], logger: silent, maxConcurrency: 1, fetchImpl,
    mcpClient: { callTool: vi.fn(async () => null) }, lineage: { resolve: async () => attribution },
    spawner, killer: vi.fn(async () => {}),
    makeSseListener: (options) => { listener = options; return { disconnect() {} }; },
  });
  const connection = daemon.connections[0];
  for (const waker of connection.runtimeWakers.values()) {
    waker.isNewSessionFn = () => true;
    waker.writeMcpConfigFn = () => ({ path: "/synthetic/mcp.json", cleanup() {} });
    waker.hooks = { onSessionStart() {}, onSessionEnd: async () => ({}) };
  }
  cleanups.push(() => {
    connection.recovery.stop();
    connection.queue.stop();
    for (const waker of connection.runtimeWakers.values()) waker.stop();
  });
  listener.onConnectionId("connection-old");
  return {
    ...connection, listener, spawner, reports, rows, fetchImpl,
    add(turnUuid, overrides = {}) {
      const turn = row(turnUuid);
      rows.set(turnUuid, { turn, status: "pending", access: true, connectionUuid: "connection-old", ...overrides });
      return turn;
    },
    finishFirst: () => finishFirst(),
    resolveLate: () => lateResponse?.(),
    setDeny: (value) => { deny = value; },
    setPendingStatus: (value) => { pendingStatus = value; },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  home = mkdtempSync(join(tmpdir(), "chorus-admission-regression-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  await flush();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe("assembled daemon admission recovery", () => {
  it("preserves the committed-running token and spawns once after same-ID reconnect", async () => {
    const setup = fixture({ lost: true });
    const turn = setup.add("lost");
    await setup.listener.onEvent(event(turn));
    await flush();
    expect(setup.rows.get("lost").status).toBe("running");
    expect(setup.spawner.wake).not.toHaveBeenCalled();
    setup.listener.onReconnect();
    setup.listener.onConnectionId("connection-old");
    expect((await setup.router.dispatch(event(turn))).status).toBe("duplicate");
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    const admissions = setup.reports.filter((report) => report.status === "running");
    expect(admissions).toHaveLength(2);
    expect(admissions[1]).toEqual(admissions[0]);
    expect(setup.spawner.wake).toHaveBeenCalledTimes(1);
    expect(setup.rows.get("lost").status).toBe("ended");
    expect(setup.reports.some((report) => report.status === "interrupted")).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(setup.spawner.wake).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("cancels changed-ID admission using the old reporter identity (late=%s)", async (late) => {
    const setup = fixture({ lost: !late, late });
    await setup.listener.onEvent(event(setup.add("old")));
    await flush();
    expect(setup.rows.get("old").status).toBe("running");
    setup.listener.onReconnect();
    setup.listener.onConnectionId("connection-new");
    await flush();
    setup.resolveLate();
    await flush();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(setup.spawner.wake).not.toHaveBeenCalled();
    const cleanup = setup.reports.filter((report) => report.status === "interrupted");
    expect(cleanup.length).toBeGreaterThan(0);
    for (const report of cleanup) expect(report).toMatchObject({
      connectionUuid: "connection-old", admissionUuid: setup.reports[0].admissionUuid, turnUuid: "old", interruptedReason: "shutdown",
    });
    const next = setup.add("new", { connectionUuid: "connection-new" });
    await setup.listener.onEvent(event(next));
    await flush();
    expect(setup.spawner.wake).toHaveBeenCalledTimes(1);
    expect(setup.reports.at(-1)).toMatchObject({ connectionUuid: "connection-new", turnUuid: "new", status: "ended" });
  });

  it.each(["terminal", "no-access", "running-owner"])("recovers only pending authorized survivors after a denied batch (%s member)", async (denied) => {
    const setup = fixture({ holdFirst: true });
    await setup.listener.onEvent(event(setup.add("blocker")));
    await flush();
    const excluded = setup.add("excluded");
    const survivor = setup.add("survivor");
    await setup.listener.onEvent(event(excluded));
    await setup.listener.onEvent(event(survivor));
    if (denied === "terminal") setup.rows.get("excluded").status = "ended";
    else if (denied === "running-owner") Object.assign(setup.rows.get("excluded"), { status: "running", admissionUuid: "other-owner" });
    else setup.rows.get("excluded").access = false;
    setup.finishFirst();
    await flush();
    expect(setup.spawner.wake).toHaveBeenCalledTimes(1);
    expect((await setup.router.dispatchPendingTurn(survivor)).status).toBe("duplicate");
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(setup.spawner.wake).toHaveBeenCalledTimes(2);
    const admissions = setup.reports.filter((report) => report.status === "running");
    expect(admissions.map((report) => report.turnUuids)).toEqual([["blocker"], ["excluded", "survivor"], ["survivor"]]);
    expect(admissions[2].admissionUuid).not.toBe(admissions[1].admissionUuid);
    const prompt = setup.spawner.wake.mock.calls[1][0].prompt;
    expect(prompt).toContain("instruction-survivor");
    expect(prompt).not.toContain("instruction-excluded");
    expect(setup.rows.get("survivor").status).toBe("ended");
    await setup.listener.onEvent(event(excluded));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(setup.spawner.wake).toHaveBeenCalledTimes(2);
    expect(setup.reports.some((report) => report.status === "interrupted")).toBe(false);
    if (denied === "running-owner") expect(setup.rows.get("excluded")).toMatchObject({ status: "running", admissionUuid: "other-owner" });
  });

  it("never retries an unchanged denied batch, but reconciles when the authoritative set shrinks", async () => {
    const setup = fixture({ holdFirst: true });
    await setup.listener.onEvent(event(setup.add("blocker")));
    await flush();
    await setup.listener.onEvent(event(setup.add("first")));
    await setup.listener.onEvent(event(setup.add("second")));
    setup.setDeny(true);
    setup.finishFirst();
    await flush();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(setup.reports.filter((report) => report.status === "running")).toHaveLength(2);
    expect(setup.fetchImpl.mock.calls.filter(([url]) => url.includes("/pending-turns")).length).toBeLessThanOrEqual(5);
    expect(setup.spawner.wake).toHaveBeenCalledTimes(1);
    setup.setDeny(false);
    setup.rows.get("first").status = "ended";
    setup.recovery.reconcile();
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(setup.spawner.wake).toHaveBeenCalledTimes(2);
    expect(setup.reports.at(-1)).toMatchObject({ turnUuid: "second", status: "ended" });
  });

  it("does not release batch ownership on a failed pending GET", async () => {
    const setup = fixture({ holdFirst: true });
    await setup.listener.onEvent(event(setup.add("blocker")));
    await flush();
    await setup.listener.onEvent(event(setup.add("terminal")));
    await setup.listener.onEvent(event(setup.add("survivor")));
    setup.rows.get("terminal").status = "ended";
    setup.setPendingStatus(503);
    setup.finishFirst();
    await flush();
    await vi.advanceTimersByTimeAsync(1);
    expect(setup.spawner.wake).toHaveBeenCalledTimes(1);
    setup.setPendingStatus(200);
    await vi.advanceTimersByTimeAsync(30_000);
    await flush();
    expect(setup.spawner.wake).toHaveBeenCalledTimes(2);
  });

  it.each(["conflict", "shutdown"])("cancels uncertain admission on %s without spawning", async (reason) => {
    const setup = fixture({ lost: true });
    await setup.listener.onEvent(event(setup.add("uncertain")));
    await flush();
    if (reason === "conflict") setup.listener.onConflict({});
    else for (const waker of setup.runtimeWakers.values()) waker.stop();
    await flush();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(setup.spawner.wake).not.toHaveBeenCalled();
    expect(setup.reports.at(-1)).toMatchObject({
      connectionUuid: "connection-old", turnUuid: "uncertain", admissionUuid: setup.reports[0].admissionUuid,
      status: "interrupted", interruptedReason: "shutdown",
    });
  });

  it.each(["ended", "no-access", "permanent-conflict", "running-owner"])("does not execute or hot-loop a singleton denial: %s", async (reason) => {
    const setup = fixture();
    const turn = setup.add("denied", { status: reason === "ended" ? "ended" : "pending", access: reason !== "no-access" });
    if (reason === "running-owner") Object.assign(setup.rows.get("denied"), { status: "running", admissionUuid: "other-owner" });
    setup.setDeny(reason === "permanent-conflict");
    await setup.listener.onEvent(event(turn));
    await flush();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(setup.spawner.wake).not.toHaveBeenCalled();
    expect(setup.reports).toHaveLength(1);
  });

  it("does not let stale batch ownership release a newer accepted delivery", async () => {
    const setup = fixture({ holdFirst: true });
    await setup.listener.onEvent(event(setup.add("blocker")));
    await flush();
    const survivor = setup.add("survivor");
    await setup.listener.onEvent(event(survivor));
    const previousOwner = setup.router.acceptedAdmissions.get("turn:survivor");
    setup.router.releaseAccepted(["survivor"], { survivor: previousOwner });
    await setup.router.dispatchPendingTurn(survivor);
    setup.router.rejectAdmission({
      connectionUuid: "connection-old", admissionUuid: "stale-batch", turnUuids: ["terminal", "survivor"],
      deliveryAdmissions: { survivor: previousOwner },
    });
    setup.router.reconcilePendingTurns([survivor]);
    expect((await setup.router.dispatch(event(survivor))).status).toBe("duplicate");
    setup.finishFirst();
    await flush();
  });
});
