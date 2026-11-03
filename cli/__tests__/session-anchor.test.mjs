import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { parseScopedAnchor, executionKey } from "../session-anchor.mjs";
import { Waker } from "../waker.mjs";
import { WakeQueue } from "../wake-queue.mjs";
import { ClaudeSpawner } from "../claude-spawner.mjs";
import { createControlHandler } from "../control-handler.mjs";

const attribution = { rootIdeaUuid: "root", directIdeaUuid: "direct" };
const silent = { info() {}, warn() {}, error() {} };
const notification = (sessionId, entityUuid = "T") => ({
  uuid: `notification-${sessionId}`, sessionId, entityType: "task", entityUuid,
  action: "task_assigned", projectUuid: "project", entityTitle: "Task",
});

function makeWaker(spawner, overrides = {}) {
  return new Waker({
    creds: { url: "https://chorus.test", apiKey: "cho_test", agentUuid: "agent" },
    lineage: { resolve: async () => attribution },
    spawner, cwd: "/work", logger: silent,
    writeMcpConfigFn: () => ({ path: "/tmp/config.json", cleanup() {} }),
    isNewSessionFn: () => true,
    advanceTurn: vi.fn(async () => ({ ok: true })),
    ...overrides,
  });
}

function controlledSpawner() {
  const runs = [];
  const spawner = { wake: vi.fn((params) => new Promise((resolve) => {
    const child = { pid: runs.length + 100 };
    params.onChild(child);
    runs.push({ ...params, child, finish: (exitCode = 0) => resolve({
      sessionId: params.sessionId, exitCode, isNew: true,
    }) });
  })) };
  return { spawner, runs };
}

describe("scoped session anchors", () => {
  it.each([
    ["task:T", { kind: "task", entityType: "task", entityUuid: "T" }],
    ["review:task:T", { kind: "review", entityType: "task", entityUuid: "T" }],
    ["review:proposal:P", { kind: "review", entityType: "proposal", entityUuid: "P" }],
    ["review:idea:I", { kind: "review", entityType: "idea", entityUuid: "I" }],
    ["11111111-1111-4111-8111-111111111111", null],
    [undefined, null], [null, null], ["", null], ["task:", null],
    ["review:document:D", null], ["review:task:", null], ["task:T:extra", null],
    ["task: T", null], ["task:T\n", null],
  ])("parses %j", (value, expected) => expect(parseScopedAnchor(value)).toEqual(expected));

  it.each(["task:T", "review:task:T", "review:proposal:P", "review:idea:I"])("keys scoped %s separately", async (sessionId) => {
    const waker = makeWaker({});
    expect(await waker.keyFor(notification(sessionId))).toEqual({ ...attribution, key: `session:${sessionId}` });
  });

  it.each([undefined, "11111111-1111-4111-8111-111111111111", "", "invalid"])("preserves legacy keys for %j", async (sessionId) => {
    const waker = makeWaker({});
    expect(await waker.keyFor(notification(sessionId))).toEqual({ ...attribution, key: "idea:direct" });
    waker.lineage.resolve = async () => ({ rootIdeaUuid: null, directIdeaUuid: null });
    expect((await waker.keyFor(notification(sessionId))).key).toBe("entity:task:T");
    waker.markQueued(notification(sessionId), "idea:direct", attribution);
    expect(waker.buildExecutionSnapshot()[0].sessionId).toBe("");
  });

  it("uses different real ClaudeSpawner argv sessions for task assignment and review mention", async () => {
    const spawnImpl = vi.fn(() => {
      const child = new EventEmitter();
      child.stdin = Object.assign(new EventEmitter(), { write() {}, end() {} });
      child.stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
      child.stderr = Object.assign(new EventEmitter(), { setEncoding() {} });
      queueMicrotask(() => child.emit("close", 0));
      return child;
    });
    const spawner = new ClaudeSpawner({ claudePath: "/usr/bin/claude", spawnImpl, logger: silent, permissionMode: "yolo", creds: { agentUuid: "agent" } });
    const seen = new Set();
    const waker = makeWaker(spawner, { isNewSessionFn: (sessionId) => {
      const fresh = !seen.has(sessionId);
      seen.add(sessionId);
      return fresh;
    } });
    for (const sessionId of ["task:T", "review:task:T"]) {
      const wake = { ...notification(sessionId), action: sessionId.startsWith("review:") ? "mentioned" : "task_assigned" };
      const resolved = await waker.keyFor(wake);
      await waker.wake(wake, resolved.key, resolved);
    }
    expect(spawnImpl).toHaveBeenCalledTimes(2);
    const args = spawnImpl.mock.calls.map((call) => call[1]);
    expect(args[0]).toContain("--session-id");
    expect(args[1]).toContain("--session-id");
    expect(args[1]).not.toContain("--resume");
    expect(args[0][args[0].indexOf("--session-id") + 1]).not.toBe(args[1][args[1].indexOf("--session-id") + 1]);
    expect(spawnImpl.mock.calls.map((call) => call[2].cwd)).toEqual(["/work", "/work"]);
  });

  it("runs sibling tasks concurrently but serializes and coalesces same-anchor wakes", async () => {
    const { spawner, runs } = controlledSpawner();
    const waker = makeWaker(spawner);
    const queue = new WakeQueue({ maxConcurrency: 2, runBatch: (key, items) => waker.wakeBatch(items, key, attribution) });
    for (const sessionId of ["task:T1", "task:T2", "task:T1", "task:T1"]) {
      const wake = notification(sessionId);
      const { key } = await waker.keyFor(wake);
      waker.markQueued(wake, key, attribution);
      queue.enqueue(key, wake);
    }
    await vi.waitFor(() => expect(runs).toHaveLength(2));
    expect(waker.buildExecutionSnapshot().map((row) => row.sessionId).sort()).toEqual(["task:T1", "task:T2"]);
    runs[0].finish();
    await vi.waitFor(() => expect(runs).toHaveLength(3));
    expect(waker.advanceTurn.mock.calls.map(([report]) => report)).toContainEqual(expect.objectContaining({
      sessionId: "task:T1", entityType: "task", entityUuid: "T1", coalescedCount: 2, status: "running",
    }));
    expect(waker.buildExecutionSnapshot().every((row) => row.entityType === "task")).toBe(true);
    runs[1].finish();
    runs[2].finish();
    await queue.drain();
    expect(waker.executions.size).toBe(0);
  });

  it("keeps same-entity task/review entries separate and targets interrupts exactly", async () => {
    const { spawner, runs } = controlledSpawner();
    const reportInterrupt = vi.fn();
    const waker = makeWaker(spawner, { reportInterrupt });
    const pending = [];
    for (const sessionId of ["task:T", "review:task:T", "task:T2"]) {
      const wake = notification(sessionId);
      const resolved = await waker.keyFor(wake);
      pending.push(waker.wake(wake, resolved.key, resolved));
    }
    await vi.waitFor(() => expect(runs).toHaveLength(3));
    expect(waker.executions.size).toBe(3);
    expect(waker.buildExecutionSnapshot().map((row) => row.sessionId)).toEqual(["task:T", "review:task:T", "task:T2"]);
    const killer = vi.fn(async (child) => runs.find((run) => run.child === child).finish(130));
    const onControl = createControlHandler({ waker, killer, getConnectionUuid: () => "connection" });
    const control = { type: "control", command: "interrupt", targetConnectionUuid: "connection", entityType: "task", entityUuid: "T" };
    onControl(control);
    onControl({ ...control, entityType: "idea", entityUuid: "direct" });
    expect(killer).not.toHaveBeenCalled();
    onControl({ ...control, sessionId: "review:task:T" });
    expect(killer).toHaveBeenCalledTimes(1);
    expect(killer.mock.calls[0][0]).toBe(runs[1].child);
    await pending[1];
    expect(reportInterrupt).toHaveBeenCalledWith("task", "T", "user", "review:task:T");
    expect(waker.executions.has(executionKey("task", "T", "task:T"))).toBe(true);
    onControl({ ...control, sessionId: "task:T" });
    await pending[0];
    expect(waker.buildExecutionSnapshot()).toEqual([expect.objectContaining({ sessionId: "task:T2", status: "running" })]);
    runs[2].finish();
    await Promise.all(pending);
  });

  it("scoped resume forwards its session and a missing child settles only that session", () => {
    const redispatchResume = vi.fn();
    const advanceTurn = vi.fn();
    const onControl = createControlHandler({ waker: { executions: new Map() }, getConnectionUuid: () => "connection", redispatchResume, advanceTurn });
    const control = { type: "control", targetConnectionUuid: "connection", entityType: "task", entityUuid: "T", sessionId: "review:task:T" };
    onControl({ ...control, command: "resume" });
    expect(redispatchResume).toHaveBeenCalledWith("task", "T", undefined, undefined, null, "review:task:T");
    onControl({ ...control, command: "interrupt" });
    expect(advanceTurn).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "review:task:T", status: "interrupted" }));
  });

  it("keeps coalesced review entities and legacy Idea executions independently controllable", async () => {
    const { spawner, runs } = controlledSpawner();
    const waker = makeWaker(spawner);
    const review = { ...notification("review:idea:direct"), action: "mentioned" };
    const legacy = { ...notification("direct", "direct"), entityType: "idea", action: "mentioned" };
    const reviewKey = await waker.keyFor(review);
    const legacyKey = await waker.keyFor(legacy);
    const reviewPending = waker.wakeBatch([review, review], reviewKey.key, reviewKey);
    const legacyPending = waker.wake(legacy, legacyKey.key, legacyKey);
    await vi.waitFor(() => expect(runs).toHaveLength(2));
    expect(waker.buildExecutionSnapshot()).toEqual([
      expect.objectContaining({ entityType: "idea", entityUuid: "direct", sessionId: "review:idea:direct" }),
      expect.objectContaining({ entityType: "idea", entityUuid: "direct", sessionId: "" }),
    ]);
    const killer = vi.fn(async (child) => runs.find((run) => run.child === child).finish(130));
    const onControl = createControlHandler({ waker, killer, getConnectionUuid: () => "connection" });
    onControl({ type: "control", command: "interrupt", targetConnectionUuid: "connection", entityType: "idea", entityUuid: "direct" });
    expect(killer.mock.calls[0][0]).toBe(runs[1].child);
    await legacyPending;
    expect(waker.buildExecutionSnapshot()).toEqual([expect.objectContaining({ sessionId: "review:idea:direct", status: "running" })]);
    runs[0].finish();
    await reviewPending;
  });
});
