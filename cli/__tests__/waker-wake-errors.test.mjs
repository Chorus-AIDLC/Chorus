import { describe, it, expect, vi } from "vitest";
import { Waker } from "../waker.mjs";
import { ClaudeSpawner, SESSION_CONFLICT_FAILURE } from "../claude-spawner.mjs";
import { createTurnReporter } from "../turn-reporter.mjs";
import { createWakeError } from "../wake-error.mjs";

const IDEA = "11111111-1111-4111-8111-111111111111";
const ROOT = "99999999-9999-4999-8999-999999999999";
const TURN = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const NEXT = "44444444-4444-4444-8444-444444444444";
const silent = { info() {}, warn() {}, error() {} };
const creds = { url: "https://chorus.test", apiKey: "synthetic-main-key" };
const notification = {
  uuid: "notification", projectUuid: "project", action: "task_assigned",
  entityType: "task", entityUuid: "task", entityTitle: "Task",
  actorType: "user", actorUuid: "user", actorName: "Owner", message: "",
};
const operation = {
  ...notification, action: "research_requested", entityType: "idea", entityUuid: IDEA,
  turnUuid: TURN, sessionId: IDEA, directIdeaUuid: IDEA,
  operationPayload: { version: 1, kind: "research", ideaUuid: IDEA },
};
const attribution = { key: `idea:${IDEA}`, directIdeaUuid: IDEA, rootIdeaUuid: ROOT };
const diagnostic = (source = "claude", kind = "startup", exitCode = null) =>
  createWakeError({ source, kind, message: "Synthetic backend failed", details: "Failure details", exitCode });
const usage = {
  inputTokens: 3, outputTokens: 5, cacheCreationTokens: null,
  cacheReadTokens: null, model: null, source: "claude_code",
};

function failedSpawner({ child = false, source = "claude", exitCode = null, error = diagnostic(source) } = {}) {
  return {
    wakeErrorSource: source,
    wake: vi.fn(async ({ sessionId, onChild }) => {
      if (child) onChild({ pid: 123 });
      return { sessionId, isNew: true, exitCode, ...(error ? { wakeError: error } : {}) };
    }),
  };
}

// Exercise the real Waker -> explicit reporter fields -> REST serialization.
// The HTTP fixture models selected/sibling/other/next rows, and rejects a
// terminal report unless it carries the selected row's exact correlation.
function harness(overrides = {}) {
  const requests = [], order = [];
  const rows = new Map([[TURN, { status: "pending" }], [OTHER, { status: "running" }], [NEXT, { status: "pending" }]]);
  const siblings = overrides.siblings ?? [];
  for (const uuid of siblings) rows.set(uuid, { status: "pending" });
  const logger = { ...silent, warn: vi.fn() };
  const fetchImpl = vi.fn(async (_url, init) => {
    const report = JSON.parse(init.body);
    requests.push(report);
    order.push(report.status);
    if (report.status === "running") {
      if (overrides.admission) return overrides.admission(report, rows);
      expect(report.turnUuid === undefined || report.turnUuid === TURN).toBe(true);
      rows.get(TURN).status = "running";
      for (const uuid of siblings.slice(0, (report.coalescedCount ?? 1) - 1)) rows.get(uuid).status = "merged";
      return { ok: true, status: 200, json: async () => ({ data: { turn: { uuid: TURN } } }) };
    }
    expect(report.turnUuid).toBe(TURN);
    Object.assign(rows.get(TURN), report);
    return { ok: true, status: 200 };
  });
  const hooks = overrides.hooks ?? {
    onSessionStart: vi.fn(async () => {}),
    onSessionEnd: vi.fn(async () => { order.push("flush"); return {}; }),
  };
  const cfg = { path: "/unused.json", cleanup: vi.fn() };
  const spawner = overrides.spawner ?? failedSpawner();
  const advanceTurn = overrides.advanceTurn ?? createTurnReporter({
    ...creds, getConnectionUuid: () => "connection", fetchImpl, logger,
  });
  const waker = new Waker({
    creds, spawner, logger, hooks, advanceTurn, cwd: "/work",
    lineage: { resolve: async () => attribution },
    isNewSessionFn: () => true, writeMcpConfigFn: () => cfg,
    reportInterrupt: vi.fn(async () => {}),
    ...overrides.waker,
  });
  return { waker, requests, rows, spawner, logger, hooks, cfg, order, fetchImpl };
}

function assertUnrelatedRows(h) {
  expect(h.rows.get(OTHER)).toEqual({ status: "running" });
  expect(h.rows.get(NEXT)).toEqual({ status: "pending" });
}

describe("CLI wake failure reporting", () => {
  it.each(["claude", "codex", "pi", "kiro", "dsh"])("settles %s no-child startup on its admitted UUID through the actual reporter", async (source) => {
    const h = harness({ spawner: failedSpawner({ source }) });
    await h.waker.wake(notification, attribution.key, attribution);
    expect(h.order).toEqual(["running", "flush", "interrupted"]);
    expect(h.requests[1]).toMatchObject({ turnUuid: TURN, interruptedReason: "crash", wakeError: diagnostic(source) });
    expect(h.requests[1]).not.toHaveProperty("transcriptRelayError");
    assertUnrelatedRows(h);
    expect(h.cfg.cleanup).toHaveBeenCalledOnce();
    expect(h.waker.executions.size).toBe(0);
  });

  it("reports an actual Claude synchronous spawn failure before onChild", async () => {
    const spawnImpl = vi.fn(() => { throw new Error("Synthetic executable unavailable"); });
    const spawner = new ClaudeSpawner({ claudePath: "/fake/claude", spawnImpl, creds, logger: silent });
    const h = harness({ spawner });
    await h.waker.wake(notification, attribution.key, attribution);
    expect(spawnImpl).toHaveBeenCalledOnce();
    expect(h.requests[1]).toMatchObject({
      status: "interrupted", turnUuid: TURN,
      wakeError: { source: "claude", kind: "startup", message: expect.stringContaining("Cannot spawn claude:") },
    });
    assertUnrelatedRows(h);
  });

  it.each(["setup", "cwd", "cwd-no-code", "spawn", "after-child"])("sanitizes %s exceptions and settles the same ordinary turn", async (stage) => {
    const spawner = failedSpawner({ source: "kiro" });
    spawner.env = { CUSTOM_PASSWORD: 'synthetic"password\\value' };
    spawner.creds = { apiKey: "synthetic-callback-key" };
    const fail = () => {
      throw Object.assign(new Error(`\u001b[31mFailure ${JSON.stringify(spawner.env.CUSTOM_PASSWORD)} ${spawner.creds.apiKey}\u001b[0m`),
        stage === "cwd" ? { code: "ENOENT" } : {});
    };
    const options = stage === "setup" ? { writeMcpConfigFn: fail }
      : stage.startsWith("cwd") ? { validateRuntimeCwd: fail } : {};
    if (stage === "spawn" || stage === "after-child") spawner.wake.mockImplementation(async ({ onChild }) => {
      if (stage === "after-child") onChild({ pid: 123 });
      fail();
    });
    const h = harness({ spawner, waker: options });
    await h.waker.wake({ ...notification, ...(stage.startsWith("cwd") ? { runtimeCwd: "/missing" } : {}) }, attribution.key, attribution);
    expect(h.requests.map((r) => r.status)).toEqual(["running", "interrupted"]);
    expect(h.requests[1]).toMatchObject({
      turnUuid: TURN, interruptedReason: stage.startsWith("cwd") ? "invalid_path" : "crash",
      wakeError: { kind: "startup", source: "kiro" },
    });
    const error = h.requests[1].wakeError;
    expect(Object.keys(error).sort()).toEqual(["details", "exitCode", "kind", "message", "signal", "source"]);
    expect(error.message).toContain("[redacted]");
    expect(error.message).not.toContain("synthetic");
    expect(error.message).not.toContain("\u001b");
    expect(h.requests[1]).not.toHaveProperty("transcriptRelayError");
    assertUnrelatedRows(h);
  });

  it.each(["no-child", "child", "setup", "cwd"])("never sends a FIFO terminal when %s admission fails or has no UUID", async (stage) => {
    for (const outcome of [
      { ok: false, status: 409 },
      { ok: false, status: null, data: { turnUuid: OTHER } },
      { ok: true }, { ok: true, data: { turnUuid: "" } }, undefined,
    ]) {
      const advanceTurn = vi.fn(async () => outcome);
      const spawner = failedSpawner({ child: stage === "child" });
      const fail = () => { throw new Error("setup failed"); };
      const h = harness({ spawner, advanceTurn, waker: stage === "setup"
        ? { writeMcpConfigFn: fail } : stage === "cwd" ? { validateRuntimeCwd: fail } : {} });
      await h.waker.wake({ ...notification, ...(stage === "cwd" ? { runtimeCwd: "/missing" } : {}) }, attribution.key, attribution);
      expect(advanceTurn).toHaveBeenCalledOnce();
      expect(advanceTurn.mock.lastCall[0].status).toBe("running");
      expect(h.logger.warn.mock.calls.flat().join("\n")).toMatch(/terminal report skipped.*no turn UUID/);
      assertUnrelatedRows(h);
    }
  });

  it("does not use terminal FIFO after an HTTP admission response is lost", async () => {
    const h = harness({ admission: async (_report, rows) => {
      rows.get(TURN).status = "running";
      throw new Error("Synthetic response lost after commit");
    } });
    await h.waker.wake(notification, attribution.key, attribution);
    expect(h.requests.map((r) => r.status)).toEqual(["running"]);
    expect(h.rows.get(TURN)).toEqual({ status: "running" });
    assertUnrelatedRows(h);
  });

  it.each(["startup", "setup"])("keeps coalesced %s siblings merged and excludes a synthetic resume", async (stage) => {
    const sibling = "55555555-5555-4555-8555-555555555555";
    const h = harness({ siblings: [sibling], waker: stage === "setup"
      ? { writeMcpConfigFn: () => { throw new Error("setup failed"); } } : {} });
    await h.waker.wakeBatch([
      notification, { ...notification, uuid: "notification-2", entityUuid: "task-2" },
      { ...notification, action: "resource_resumed", entityUuid: "task-3" },
    ], attribution.key, attribution);
    expect(h.requests[0]).toMatchObject({ status: "running", coalescedCount: 2, entityType: "idea", entityUuid: IDEA });
    expect(h.rows.get(sibling)).toEqual({ status: "merged" });
    expect(h.rows.get(TURN)).toMatchObject({ status: "interrupted", wakeError: { kind: "startup" } });
    expect(h.requests[1]).not.toHaveProperty("coalescedCount");
    assertUnrelatedRows(h);
  });

  it("a nonnull diagnostic fails raw exit zero and retains relay failure, usage and backend identity independently", async () => {
    const error = diagnostic("codex", "execution", 0);
    const spawner = failedSpawner({ child: true, source: "codex", exitCode: 0, error });
    spawner.wake.mockImplementation(async ({ sessionId, onChild }) => {
      onChild({ pid: 123 });
      return { sessionId, backendSessionId: "backend-thread", exitCode: 0, isNew: true, wakeError: error };
    });
    const h = harness({ spawner, hooks: { onSessionEnd: async () => ({ relayError: "Synthetic transcript upload failed", usage }) } });
    await h.waker.wake(notification, attribution.key, attribution);
    expect(h.requests[1]).toMatchObject({
      turnUuid: TURN, status: "interrupted", interruptedReason: "crash", wakeError: error,
      transcriptRelayError: "Synthetic transcript upload failed", usage, backendSessionId: "backend-thread",
    });
    expect(h.waker.reportInterrupt).toHaveBeenCalledWith("task", "task", "crash");
    assertUnrelatedRows(h);
  });

  it.each(["user", "shutdown", "both"])("suppresses startup/execution diagnostics for %s even when raw exit is zero", async (mode) => {
    for (const child of [true, false]) {
      const h = harness({ spawner: failedSpawner({ child, exitCode: 0 }) });
      if (mode !== "shutdown") h.waker.markInterrupting("task", "task");
      if (mode !== "user") h.waker.shuttingDown = true;
      await h.waker.wake(notification, attribution.key, attribution);
      expect(h.requests[1]).toMatchObject({ status: "interrupted", interruptedReason: mode === "shutdown" ? "shutdown" : "user" });
      expect(h.requests[1]).not.toHaveProperty("wakeError");
    }
  });

  it("honors user cancellation arriving while the admission response is delayed", async () => {
    let admit;
    const advanceTurn = vi.fn((p) => p.status === "running"
      ? new Promise((resolve) => { admit = resolve; }) : Promise.resolve({ ok: true }));
    const h = harness({ advanceTurn });
    const running = h.waker.wake(notification, attribution.key, attribution);
    await vi.waitFor(() => expect(admit).toBeTypeOf("function"));
    h.waker.markInterrupting("task", "task");
    admit({ ok: true, data: { turnUuid: TURN } });
    await running;
    expect(advanceTurn.mock.lastCall[0]).toMatchObject({ turnUuid: TURN, interruptedReason: "user" });
    expect(advanceTurn.mock.lastCall[0]).not.toHaveProperty("wakeError");
  });

  it.each([true, false])("reports only the final Claude conflict fallback outcome (success=%s)", async (success) => {
    const firstError = diagnostic();
    const finalError = diagnostic("claude", "execution", 3);
    const spawner = failedSpawner();
    spawner.wake.mockImplementationOnce(async ({ sessionId, onChild }) => {
      onChild({ pid: 123 });
      return { sessionId, isNew: true, exitCode: 1, failureClassification: SESSION_CONFLICT_FAILURE, wakeError: firstError };
    }).mockImplementationOnce(async ({ sessionId, onChild }) => {
      onChild({ pid: 124 });
      return { sessionId, isNew: false, exitCode: success ? 0 : 3, ...(success ? {} : { wakeError: finalError }) };
    });
    const h = harness({ spawner });
    await h.waker.wake(notification, attribution.key, attribution);
    expect(spawner.wake.mock.calls.map(([p]) => p.isNew)).toEqual([true, false]);
    expect(h.requests.map((r) => r.status)).toEqual(["running", success ? "ended" : "interrupted"]);
    if (success) expect(h.requests[1]).not.toHaveProperty("wakeError");
    else expect(h.requests[1].wakeError).toEqual(finalError);
  });

  it("warning-only success omits the diagnostic", async () => {
    const h = harness({ spawner: failedSpawner({ child: true, exitCode: 0, error: null }) });
    await h.waker.wake(notification, attribution.key, attribution);
    expect(h.requests[1]).toMatchObject({ status: "ended", turnUuid: TURN });
    expect(h.requests[1]).not.toHaveProperty("wakeError");
  });

  it.each(["setup", "cwd", "spawn", "no-child"])("dedicated %s launch failure reports only its exact operation UUID", async (stage) => {
    const fail = () => { throw new Error("Synthetic launch failed"); };
    const spawner = failedSpawner();
    if (stage === "spawn") spawner.wake.mockImplementation(fail);
    const h = harness({ spawner, waker: stage === "setup" ? { writeMcpConfigFn: fail }
      : stage === "cwd" ? { validateRuntimeCwd: fail } : {} });
    await h.waker.wake({ ...operation, ...(stage === "cwd" ? { runtimeCwd: "/missing" } : {}) }, attribution.key, attribution);
    expect(h.requests.every((p) => p.turnUuid === TURN)).toBe(true);
    expect(h.requests[0].status).toBe(stage === "cwd" ? "interrupted" : "running");
    if (stage !== "cwd") expect(h.requests[0].coalescedCount).toBe(1);
    expect(h.requests.at(-1)).toMatchObject({
      status: "interrupted", interruptedReason: stage === "cwd" ? "invalid_path" : "crash",
      wakeError: { kind: "startup", source: "claude" },
    });
    expect(h.requests.at(-1)).not.toHaveProperty("transcriptRelayError");
    assertUnrelatedRows(h);
  });

  it.each([404, 409])("rejected operation admission (%s) never spawns or aborts another consumer", async (status) => {
    const h = harness({ admission: async () => ({ ok: false, status }) });
    await h.waker.wake(operation, attribution.key, attribution);
    expect(h.spawner.wake).not.toHaveBeenCalled();
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]).toMatchObject({ status: "running", turnUuid: TURN, coalescedCount: 1 });
    assertUnrelatedRows(h);
  });

  it("missing operation admission UUID retires only the original request with a launch diagnostic", async () => {
    const h = harness({ admission: async () => ({ ok: true, status: 200, json: async () => ({ data: {} }) }) });
    await h.waker.wake(operation, attribution.key, attribution);
    expect(h.spawner.wake).not.toHaveBeenCalled();
    expect(h.requests[1]).toMatchObject({
      turnUuid: TURN, status: "interrupted", interruptedReason: "crash",
      wakeError: { kind: "startup", message: "Operation launch admission unavailable; no subprocess started" },
    });
    expect(h.requests[1]).not.toHaveProperty("transcriptRelayError");
    assertUnrelatedRows(h);
  });

  it.each(["user", "shutdown"])("operation no-child %s cancellation has no launch diagnostic", async (reason) => {
    const spawner = failedSpawner();
    const h = harness({ spawner });
    spawner.wake.mockImplementation(async ({ sessionId }) => {
      if (reason === "user") h.waker.markInterrupting("idea", IDEA);
      else h.waker.shuttingDown = true;
      return { sessionId, exitCode: null, wakeError: diagnostic() };
    });
    await h.waker.wake(operation, attribution.key, attribution);
    expect(h.requests[1]).toMatchObject({ turnUuid: TURN, interruptedReason: reason });
    expect(h.requests[1]).not.toHaveProperty("wakeError");
  });
});
