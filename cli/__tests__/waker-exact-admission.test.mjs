import { afterEach, describe, expect, it, vi } from "vitest";
import { Waker } from "../waker.mjs";
import { EventRouter } from "../event-router.mjs";
import { WakeQueue } from "../wake-queue.mjs";
import { WAKE_ACTIONS } from "../prompts.mjs";
import { createControlHandler } from "../control-handler.mjs";

const silent = { info() {}, warn() {}, error() {} };
const sessionId = "11111111-1111-4111-8111-111111111111";
const attribution = { key: `idea:${sessionId}`, directIdeaUuid: sessionId, rootIdeaUuid: sessionId };

function notification(turnUuid) {
  return { action: "mentioned", entityType: "idea", entityUuid: sessionId,
    uuid: `notification-${turnUuid}`, turnUuid, wakeRecoveryProtocol: 1,
    entityTitle: "Isolated test", message: "Review this change", actorName: "Tester" };
}

function harness(advanceTurn) {
  const spawner = { wake: vi.fn(async ({ onChild }) => {
    onChild({ pid: 42 });
    return { sessionId, exitCode: 0 };
  }) };
  const hooks = { onSessionStart: vi.fn(), onSessionEnd: vi.fn(async () => ({})) };
  const killer = vi.fn(async () => {});
  const waker = new Waker({
    creds: { url: "https://isolated.invalid", apiKey: "synthetic" },
    lineage: { resolve: async () => attribution }, spawner, advanceTurn, hooks,
    logger: silent, cwd: "/isolated", killer,
    isNewSessionFn: () => true, writeMcpConfigFn: () => ({ path: "/fake/config", cleanup() {} }),
  });
  return { waker, spawner, hooks, killer };
}

const drainMicrotasks = async () => {
  for (let index = 0; index < 20; index++) await Promise.resolve();
};

afterEach(() => vi.useRealTimers());

describe("exact wake admission ownership", () => {
  it.each(["in-flight", "backoff"])("honors a per-session interrupt during %s admission without a delayed launch", async (phase) => {
    vi.useFakeTimers();
    let release;
    const advanceTurn = vi.fn(async report => {
      if (report.status !== "running") return { ok: false, status: 409 };
      if (phase === "backoff") return { ok: false, status: 503 };
      return new Promise(resolve => { release = () => resolve({ ok: true, data: { turnUuid: report.turnUuid } }); });
    });
    const { waker, spawner } = harness(advanceTurn);
    const wake = waker.wake(notification("original"), attribution.key, attribution);
    await drainMicrotasks();
    const control = createControlHandler({ waker, advanceTurn, getConnectionUuid: () => "connection", logger: silent });
    control({ type: "control", command: "interrupt", targetConnectionUuid: "connection", entityType: "idea", entityUuid: sessionId });
    release?.();
    await wake;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(spawner.wake).not.toHaveBeenCalled();
    const running = advanceTurn.mock.calls[0][0];
    expect(advanceTurn.mock.calls.at(-1)[0]).toMatchObject({ turnUuid: "original", turnUuids: ["original"], admissionUuid: running.admissionUuid, wakeRecoveryProtocol: 1, status: "interrupted", interruptedReason: "user" });
    advanceTurn.mockImplementation(async report => ({ ok: true, data: { turnUuid: report.turnUuid } }));
    await waker.wake({ ...notification("unrelated"), entityUuid: "other-session", sessionId: "other-session" }, "idea:other-session", { key: "idea:other-session", directIdeaUuid: "other-session", rootIdeaUuid: "other-session" });
    expect(spawner.wake).toHaveBeenCalledTimes(1);
  });
  it("keeps exact members when prompt-only legacy events share the batch", async () => {
    const advanceTurn = vi.fn(async report => ({ ok: true, data: { turnUuid: report.turnUuid } }));
    const { waker, spawner } = harness(advanceTurn);
    const legacy = { ...notification("legacy"), turnUuid: undefined, wakeRecoveryProtocol: undefined };
    await waker.wakeBatch([legacy, notification("exact")], attribution.key, attribution);
    expect(spawner.wake).toHaveBeenCalledTimes(1);
    expect(advanceTurn.mock.calls[0][0]).toMatchObject({ wakeRecoveryProtocol: 1, turnUuid: "exact", turnUuids: ["exact"] });
  });
  it.each([1, 2])("retains a %s-member batch after precommit 503 and starts once after admission", async (count) => {
    vi.useFakeTimers();
    const reports = [];
    let runningAttempts = 0;
    const advanceTurn = vi.fn(async (report) => {
      reports.push(report);
      if (report.status === "running" && ++runningAttempts === 1) return { ok: false, status: 503 };
      return { ok: true, data: { turnUuid: report.turnUuid } };
    });
    const { waker, spawner, hooks } = harness(advanceTurn);
    const batch = Array.from({ length: count }, (_, index) => notification(`turn-${index + 2}`));
    batch[0].admissionUuid = "queued-admission-token";
    const wake = waker.wakeBatch(batch, attribution.key, attribution);
    await drainMicrotasks();
    expect(runningAttempts).toBe(1);
    expect(spawner.wake).not.toHaveBeenCalled();
    expect(hooks.onSessionStart).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    await wake;
    expect(runningAttempts).toBe(2);
    expect(spawner.wake).toHaveBeenCalledTimes(1);
    const expected = { turnUuid: "turn-2", turnUuids: batch.map((item) => item.turnUuid),
      admissionUuid: "queued-admission-token", wakeRecoveryProtocol: 1, sessionId };
    expect(hooks.onSessionStart).toHaveBeenCalledWith(expect.objectContaining({ turnUuid: "turn-2" }));
    expect(hooks.onSessionEnd).toHaveBeenCalledWith(expect.objectContaining({ turnUuid: "turn-2" }));
    expect(reports).toHaveLength(3);
    for (const report of reports) {
      expect(report).toMatchObject(expected);
      expect(report).not.toHaveProperty("coalescedCount");
    }
    expect(reports.map((report) => report.status)).toEqual(["running", "running", "ended"]);
  });

  it.each([1, 2])("replays the same %s-member admission after commit with lost response", async (count) => {
    vi.useFakeTimers();
    let committed = null;
    let commits = 0;
    const advanceTurn = vi.fn(async (report) => {
      if (report.status !== "running") return { ok: true, data: { turnUuid: report.turnUuid } };
      const identity = { admissionUuid: report.admissionUuid, turnUuid: report.turnUuid, turnUuids: report.turnUuids };
      if (!committed) {
        committed = identity;
        commits++;
        throw Object.assign(new Error("response lost"), { cause: { code: "ECONNRESET" } });
      }
      expect(identity).toEqual(committed);
      return { ok: true, data: { turnUuid: committed.turnUuid } };
    });
    const { waker, spawner } = harness(advanceTurn);
    const batch = Array.from({ length: count }, (_, index) => notification(`turn-${index + 2}`));
    const wake = waker.wakeBatch(batch, attribution.key, attribution);
    await drainMicrotasks();
    expect(commits).toBe(1);
    expect(spawner.wake).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    await wake;
    expect(commits).toBe(1);
    expect(spawner.wake).toHaveBeenCalledTimes(1);
    expect(advanceTurn.mock.calls.at(-1)[0]).toMatchObject({ ...committed, status: "ended" });
  });

  it.each([401, 403, 404, 409, 422])("refuses permanent %s admission without a model or unrelated settlement", async (status) => {
    const advanceTurn = vi.fn(async () => ({ ok: false, status }));
    const { waker, spawner } = harness(advanceTurn);
    await waker.wake(notification("turn-2"), attribution.key, attribution);
    expect(advanceTurn).toHaveBeenCalledTimes(1);
    expect(spawner.wake).not.toHaveBeenCalled();
  });

  it("retains responsibility past the fast retry budget, caps delays and rejects false success", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const advanceTurn = vi.fn(async (report) => {
      if (report.status !== "running" || ++attempts >= 8) return { ok: true, data: { turnUuid: report.turnUuid } };
      return attempts === 1 ? { ok: true, data: { turnUuid: "wrong-turn" } } : undefined;
    });
    const { waker, spawner } = harness(advanceTurn);
    const wake = waker.wake(notification("turn-2"), attribution.key, attribution);
    await drainMicrotasks();
    for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
      expect(spawner.wake).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(delay);
    }
    await wake;
    expect(attempts).toBe(8);
    expect(spawner.wake).toHaveBeenCalledTimes(1);
    expect(new Set(advanceTurn.mock.calls.map(([report]) => report.admissionUuid)).size).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("deadlines unknown admission responses and retries the same exact identity", async () => {
    vi.useFakeTimers();
    let firstSignal;
    const advanceTurn = vi.fn(async (report) => ({ ok: true, data: { turnUuid: report.turnUuid } }))
      .mockImplementationOnce((report) => {
        firstSignal = report.signal;
        return new Promise(() => {});
      });
    const { waker, spawner } = harness(advanceTurn);
    const wake = waker.wake(notification("turn-2"), attribution.key, attribution);
    await drainMicrotasks();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(firstSignal.aborted).toBe(true);
    expect(spawner.wake).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    await wake;
    expect(spawner.wake).toHaveBeenCalledTimes(1);
    expect(advanceTurn.mock.calls[0][0].admissionUuid).toBe(advanceTurn.mock.calls[1][0].admissionUuid);
  });

  it.each(["backoff", "unknown-response"])("stop during %s settles with the same token without spawning", async (phase) => {
    vi.useFakeTimers();
    let lateResponse;
    const advanceTurn = vi.fn(async (report) => {
      if (report.status === "interrupted") return { ok: true, data: { turnUuid: report.turnUuid } };
      if (phase === "backoff") return { ok: false, status: 503 };
      return new Promise((resolve) => { lateResponse = resolve; });
    });
    const { waker, spawner } = harness(advanceTurn);
    const wake = waker.wakeBatch([notification("turn-2"), notification("turn-3")], attribution.key, attribution);
    await drainMicrotasks();
    waker.stop();
    await wake;
    const [running, interrupted] = advanceTurn.mock.calls.map(([report]) => report);
    expect(interrupted).toMatchObject({ status: "interrupted", interruptedReason: "shutdown",
      turnUuid: running.turnUuid, turnUuids: running.turnUuids, admissionUuid: running.admissionUuid, wakeRecoveryProtocol: 1 });
    lateResponse?.({ ok: true, data: { turnUuid: "turn-2" } });
    await vi.advanceTimersByTimeAsync(60_000);
    await waker.wake(notification("turn-4"), attribution.key, attribution);
    expect(advanceTurn).toHaveBeenCalledTimes(phase === "unknown-response" ? 3 : 2);
    expect(advanceTurn.mock.calls.at(-1)[0]).toMatchObject({ status: "interrupted", admissionUuid: running.admissionUuid, turnUuid: running.turnUuid });
    expect(spawner.wake).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("connection replacement cancels only the old admission and admits new work", async () => {
    vi.useFakeTimers();
    const advanceTurn = vi.fn(async (report) => report.status === "running" && report.turnUuid === "turn-old"
      ? { ok: false, status: 503 } : { ok: true, data: { turnUuid: report.turnUuid } });
    const { waker, spawner } = harness(advanceTurn);
    const oldWake = waker.wake(notification("turn-old"), attribution.key, attribution);
    await drainMicrotasks();
    waker.cancelPendingAdmissions();
    await oldWake;
    expect(spawner.wake).not.toHaveBeenCalled();
    await waker.wake(notification("turn-new"), attribution.key, attribution);
    expect(spawner.wake).toHaveBeenCalledTimes(1);
    expect(advanceTurn.mock.calls.at(-1)[0]).toMatchObject({ turnUuid: "turn-new", status: "ended" });
  });

  it("connection replacement leaves an already-running model alone", async () => {
    const advanceTurn = vi.fn(async (report) => ({ ok: true, data: { turnUuid: report.turnUuid } }));
    const { waker, spawner, killer } = harness(advanceTurn);
    let finish;
    spawner.wake.mockImplementationOnce(async ({ onChild }) => {
      onChild({ pid: 42 });
      return new Promise((resolve) => { finish = resolve; });
    });
    const wake = waker.wake(notification("turn-2"), attribution.key, attribution);
    await drainMicrotasks();
    expect(spawner.wake).toHaveBeenCalledTimes(1);
    waker.cancelPendingAdmissions();
    expect(killer).not.toHaveBeenCalled();
    finish({ sessionId, exitCode: 0 });
    await wake;
    expect(advanceTurn.mock.calls.at(-1)[0]).toMatchObject({ turnUuid: "turn-2", status: "ended" });
  });

  it("duplicate delivery during admission cannot release the slot or launch a second owner", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const advanceTurn = vi.fn(async (report) => report.status === "running" && ++attempts === 1
      ? { ok: false, status: 503 } : { ok: true, data: { turnUuid: report.turnUuid } });
    const { waker, spawner } = harness(advanceTurn);
    const queue = new WakeQueue({ runBatch: (key, items) => waker.wakeBatch(items.map((item) => item.notification), key, items[0].attribution) });
    const router = new EventRouter({ mcpClient: {}, waker, queue, wakeActions: WAKE_ACTIONS, logger: silent });
    const detail = notification("turn-2");
    const context = { version: 1, notificationUuid: detail.uuid, notification: detail };
    const event = { type: "new_notification", notificationUuid: detail.uuid, turnUuid: detail.turnUuid, wakeContext: context };
    expect((await router.dispatch(event)).status).toBe("accepted");
    await drainMicrotasks();
    expect(spawner.wake).not.toHaveBeenCalled();
    expect((await router.dispatch(event)).status).toBe("duplicate");
    expect((await router.dispatchPendingTurn({ turnUuid: detail.turnUuid, sessionId, trigger: "mentioned", wakeContext: context })).status).toBe("duplicate");
    expect(queue.activeCount).toBe(1);
    expect(queue.pendingKeyCount).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    await queue.drain();
    expect(spawner.wake).toHaveBeenCalledTimes(1);
    expect(attempts).toBe(2);
  });
});
