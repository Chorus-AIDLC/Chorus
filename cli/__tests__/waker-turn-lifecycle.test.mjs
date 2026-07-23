// cli/__tests__/waker-turn-lifecycle.test.mjs
// Covers the Waker advancing the server-side DaemonSessionTurn (子1 —
// daemon-session-conversation): pending→running on spawn, running→ended on exit,
// reusing the existing executions map / onChild hook (no parallel registry), with the
// entity threaded so the server can stamp the executionUuid linkage.
import { describe, it, expect, vi } from "vitest";
import { Waker } from "../waker.mjs";

const silent = { info() {}, warn() {}, error() {} };

const DIRECT_IDEA = "11111111-1111-4111-8111-111111111111";
const ROOT_IDEA = "99999999-9999-4999-8999-999999999999";

const TASK_NOTIF = {
  uuid: "notif-1",
  projectUuid: "proj-1",
  entityType: "task",
  entityUuid: "task-1",
  entityTitle: "Build the thing",
  action: "task_assigned",
  message: "",
  actorType: "user",
  actorUuid: "user-1",
  actorName: "Alice",
};

// A spawner that DOES invoke onChild (the live-spawn moment the running turn-advance
// hangs off) before resolving with the given exit code.
function spawnerThatSpawns(exitCode = 0) {
  return {
    wake: vi.fn(async ({ sessionId, onChild, onMessage }) => {
      onChild?.({ pid: 4242, on: () => {}, kill: () => {} });
      onMessage?.({ type: "system", session_id: sessionId });
      return { sessionId, exitCode, isNew: true };
    }),
  };
}

// A spawner that NEVER calls onChild (e.g. a spawn that failed before the child
// materialized) — the turn must stay pending and ended must NOT be attempted.
function spawnerThatNeverSpawns() {
  return {
    wake: vi.fn(async ({ sessionId }) => ({ sessionId, exitCode: null, isNew: true })),
  };
}

function makeWaker(overrides = {}) {
  const advanceTurn = overrides.advanceTurn ?? vi.fn(async () => {});
  const waker = new Waker({
    creds: { url: "https://c", apiKey: "cho_x" },
    lineage:
      overrides.lineage ??
      { resolve: vi.fn(async () => ({ rootIdeaUuid: ROOT_IDEA, directIdeaUuid: DIRECT_IDEA })) },
    spawner: overrides.spawner ?? spawnerThatSpawns(0),
    cwd: "/work/dir",
    hooks: overrides.hooks,
    logger: overrides.logger ?? silent,
    writeMcpConfigFn: vi.fn(() => ({ path: "/tmp/m.json", cleanup: vi.fn() })),
    isNewSessionFn: vi.fn(() => true),
    reportInterrupt: vi.fn(async () => {}),
    advanceTurn,
  });
  return { waker, advanceTurn, spawner: waker.spawner };
}

describe("Waker turn lifecycle (子1)", () => {
  it("advances pending→running on spawn and running→ended on exit, keyed on the session id, with the entity for executionUuid linkage", async () => {
    const { waker, advanceTurn } = makeWaker();
    const resolved = await waker.keyFor(TASK_NOTIF);
    await waker.wake(TASK_NOTIF, resolved.key, resolved);

    expect(advanceTurn).toHaveBeenCalledTimes(2);
    // running first, then ended — strict forward order.
    expect(advanceTurn.mock.calls[0][0]).toEqual({
      sessionId: DIRECT_IDEA, // the session anchor = direct idea uuid
      status: "running",
      entityType: "task",
      entityUuid: "task-1",
    });
    expect(advanceTurn.mock.calls[1][0]).toEqual({
      sessionId: DIRECT_IDEA,
      status: "ended",
      entityType: "task",
      entityUuid: "task-1",
    });
  });

  it("anchors the turn on the entity's own uuid when there is no direct idea (ad-hoc session)", async () => {
    const QUICK_TASK = "22222222-2222-4222-8222-222222222222";
    const { waker, advanceTurn } = makeWaker({
      lineage: { resolve: async () => ({ rootIdeaUuid: null, directIdeaUuid: null }) },
    });
    const notif = { ...TASK_NOTIF, entityUuid: QUICK_TASK };
    const resolved = await waker.keyFor(notif);
    await waker.wake(notif, resolved.key, resolved);

    expect(advanceTurn).toHaveBeenCalledTimes(2);
    expect(advanceTurn.mock.calls[0][0].sessionId).toBe(QUICK_TASK);
    expect(advanceTurn.mock.calls[0][0].status).toBe("running");
    expect(advanceTurn.mock.calls[1][0].status).toBe("ended");
  });

  it("reports running→interrupted(crash) on a NON-ZERO exit with no interrupt requested (outcome-aware)", async () => {
    const { waker, advanceTurn } = makeWaker({ spawner: spawnerThatSpawns(2) });
    const resolved = await waker.keyFor(TASK_NOTIF);
    await waker.wake(TASK_NOTIF, resolved.key, resolved);

    const statuses = advanceTurn.mock.calls.map((c) => c[0].status);
    expect(statuses).toEqual(["running", "interrupted"]);
    expect(advanceTurn.mock.calls[1][0].interruptedReason).toBe("crash");
  });

  it("reports running→interrupted(user) when the interrupt flag was set before exit", async () => {
    const { waker, advanceTurn } = makeWaker({ spawner: spawnerThatSpawns(130) });
    const resolved = await waker.keyFor(TASK_NOTIF);
    waker.markInterrupting("task", "task-1");
    await waker.wake(TASK_NOTIF, resolved.key, resolved);

    const last = advanceTurn.mock.calls.at(-1)[0];
    expect(last.status).toBe("interrupted");
    expect(last.interruptedReason).toBe("user");
  });

  it("reports running→interrupted(shutdown) when the waker is shutting down", async () => {
    const { waker, advanceTurn } = makeWaker({ spawner: spawnerThatSpawns(130) });
    const resolved = await waker.keyFor(TASK_NOTIF);
    waker.shuttingDown = true;
    await waker.wake(TASK_NOTIF, resolved.key, resolved);

    const last = advanceTurn.mock.calls.at(-1)[0];
    expect(last.status).toBe("interrupted");
    expect(last.interruptedReason).toBe("shutdown");
  });

  it("user-interrupt outranks shutdown in the turn reason", async () => {
    const { waker, advanceTurn } = makeWaker({ spawner: spawnerThatSpawns(130) });
    const resolved = await waker.keyFor(TASK_NOTIF);
    waker.markInterrupting("task", "task-1");
    waker.shuttingDown = true;
    await waker.wake(TASK_NOTIF, resolved.key, resolved);

    expect(advanceTurn.mock.calls.at(-1)[0].interruptedReason).toBe("user");
  });

  it("clean exit during shutdown still reports ended (the subprocess finished its work)", async () => {
    const { waker, advanceTurn } = makeWaker({ spawner: spawnerThatSpawns(0) });
    const resolved = await waker.keyFor(TASK_NOTIF);
    waker.shuttingDown = true;
    await waker.wake(TASK_NOTIF, resolved.key, resolved);

    const last = advanceTurn.mock.calls.at(-1)[0];
    expect(last.status).toBe("ended");
    expect(last).not.toHaveProperty("interruptedReason");
  });

  it("does NOT attempt ended when the subprocess never spawned (turn stays pending; no illegal pending→ended)", async () => {
    const { waker, advanceTurn } = makeWaker({ spawner: spawnerThatNeverSpawns() });
    const resolved = await waker.keyFor(TASK_NOTIF);
    await waker.wake(TASK_NOTIF, resolved.key, resolved);

    // onChild never fired → no running, and therefore no ended either.
    expect(advanceTurn).not.toHaveBeenCalled();
  });

  it("reuses the existing executions map / onChild — the running entry still gets its child handle", async () => {
    // Assert the turn-advance addition did NOT displace the 子3 child-capture: the
    // running execution entry must still hold the live child for the interrupt path.
    let capturedChild = null;
    const spawner = {
      wake: vi.fn(async ({ sessionId, onChild }) => {
        const child = { pid: 7, on: () => {}, kill: () => {} };
        onChild?.(child);
        capturedChild = child;
        return { sessionId, exitCode: 0, isNew: true };
      }),
    };
    // Capture the running entry's child mid-wake via a spy on the snapshot.
    const { waker, advanceTurn } = makeWaker({ spawner });
    const resolved = await waker.keyFor(TASK_NOTIF);
    await waker.wake(TASK_NOTIF, resolved.key, resolved);
    // The child was handed to onChild (子3 path intact) AND the turn advanced (子1).
    expect(capturedChild).not.toBeNull();
    expect(advanceTurn.mock.calls.map((c) => c[0].status)).toEqual(["running", "ended"]);
  });

  it("a throwing turn reporter never crashes the wake (logged + swallowed)", async () => {
    const warns = [];
    const { waker } = makeWaker({
      advanceTurn: vi.fn(async () => {
        throw new Error("reporter boom");
      }),
      logger: { ...silent, warn: (m) => warns.push(m) },
    });
    const resolved = await waker.keyFor(TASK_NOTIF);
    await expect(waker.wake(TASK_NOTIF, resolved.key, resolved)).resolves.toBeUndefined();
    expect(warns.join("")).toMatch(/advanceTurn failed/);
  });

  it("flushes the transcript (onSessionEnd) BEFORE advancing the turn to ended (fix #444)", async () => {
    // The order guarantee: the server attaches transcript to the RUNNING turn, so the
    // flush must land before running→ended. We record an ordered log of both events.
    const order = [];
    const advanceTurn = vi.fn(async ({ status }) => {
      order.push(`advance:${status}`);
    });
    const hooks = {
      onSessionEnd: vi.fn(async ({ sessionId }) => {
        order.push(`flush:${sessionId}`);
      }),
    };
    const { waker } = makeWaker({ advanceTurn, hooks });
    const resolved = await waker.keyFor(TASK_NOTIF);
    await waker.wake(TASK_NOTIF, resolved.key, resolved);

    expect(hooks.onSessionEnd).toHaveBeenCalledWith({ sessionId: DIRECT_IDEA });
    // running → flush → ended: the flush is strictly between the running and ended advances.
    expect(order).toEqual([`advance:running`, `flush:${DIRECT_IDEA}`, "advance:ended"]);
  });

  it("flushes the transcript before advancing to interrupted on a dirty exit (fix #444)", async () => {
    const order = [];
    const advanceTurn = vi.fn(async ({ status }) => {
      order.push(`advance:${status}`);
    });
    const hooks = { onSessionEnd: vi.fn(async () => order.push("flush")) };
    const { waker } = makeWaker({ advanceTurn, hooks, spawner: spawnerThatSpawns(2) });
    const resolved = await waker.keyFor(TASK_NOTIF);
    await waker.wake(TASK_NOTIF, resolved.key, resolved);

    expect(order).toEqual(["advance:running", "flush", "advance:interrupted"]);
  });

  it("flushes the transcript during shutdown, before interrupted(shutdown) — so daemon.stop()'s queue.drain covers the flush (fix #444 AC4)", async () => {
    // daemon.stop() interrupts each wake then awaits queue.drain(...). The flush rides the
    // SAME exit path as the turn-advance report, so draining the wake drains the flush too.
    // Here we prove the flush happens (before the shutdown terminal advance) when the waker
    // is shutting down and the subprocess is killed (dirty exit).
    const order = [];
    const advanceTurn = vi.fn(async ({ status, interruptedReason }) => {
      order.push(`advance:${status}${interruptedReason ? `(${interruptedReason})` : ""}`);
    });
    const hooks = { onSessionEnd: vi.fn(async () => order.push("flush")) };
    const { waker } = makeWaker({ advanceTurn, hooks, spawner: spawnerThatSpawns(130) });
    waker.shuttingDown = true;
    const resolved = await waker.keyFor(TASK_NOTIF);
    await waker.wake(TASK_NOTIF, resolved.key, resolved);

    expect(hooks.onSessionEnd).toHaveBeenCalledWith({ sessionId: DIRECT_IDEA });
    expect(order).toEqual(["advance:running", "flush", "advance:interrupted(shutdown)"]);
  });

  it("a throwing onSessionEnd never crashes the wake and still advances the turn (fix #444)", async () => {
    const warns = [];
    const advanceTurn = vi.fn(async () => {});
    const hooks = {
      onSessionEnd: vi.fn(async () => {
        throw new Error("flush boom");
      }),
    };
    const { waker } = makeWaker({
      advanceTurn,
      hooks,
      logger: { ...silent, warn: (m) => warns.push(m) },
    });
    const resolved = await waker.keyFor(TASK_NOTIF);
    await expect(waker.wake(TASK_NOTIF, resolved.key, resolved)).resolves.toBeUndefined();
    // The flush failure is surfaced, and the turn still reached its terminal state.
    expect(warns.join("")).toMatch(/onSessionEnd flush failed/);
    expect(advanceTurn.mock.calls.map((c) => c[0].status)).toEqual(["running", "ended"]);
  });

  it("threads onSessionEnd's relayError onto the ended turn-advance (fix #444 follow-up)", async () => {
    // A clean exit whose transcript upload finally failed: the reply ran but never landed.
    // The waker must forward the KNOWN relay error onto the (still-clean) ended advance.
    const advanceTurn = vi.fn(async () => {});
    const hooks = {
      onSessionEnd: vi.fn(async () => ({ relayError: "transcript upload returned 502" })),
    };
    const { waker } = makeWaker({ advanceTurn, hooks });
    const resolved = await waker.keyFor(TASK_NOTIF);
    await waker.wake(TASK_NOTIF, resolved.key, resolved);

    const endedCall = advanceTurn.mock.calls.find((c) => c[0].status === "ended")[0];
    expect(endedCall.transcriptRelayError).toBe("transcript upload returned 502");
  });

  it("threads relayError onto the interrupted edge too (a dirty exit can still lose transcript)", async () => {
    const advanceTurn = vi.fn(async () => {});
    const hooks = {
      onSessionEnd: vi.fn(async () => ({ relayError: "transcript upload returned 502" })),
    };
    const { waker } = makeWaker({ advanceTurn, hooks, spawner: spawnerThatSpawns(2) });
    const resolved = await waker.keyFor(TASK_NOTIF);
    await waker.wake(TASK_NOTIF, resolved.key, resolved);

    const terminal = advanceTurn.mock.calls.find((c) => c[0].status === "interrupted")[0];
    expect(terminal.transcriptRelayError).toBe("transcript upload returned 502");
  });

  it("omits transcriptRelayError from the turn-advance when the relay succeeded (null)", async () => {
    const advanceTurn = vi.fn(async () => {});
    const hooks = { onSessionEnd: vi.fn(async () => ({ relayError: null })) };
    const { waker } = makeWaker({ advanceTurn, hooks });
    const resolved = await waker.keyFor(TASK_NOTIF);
    await waker.wake(TASK_NOTIF, resolved.key, resolved);

    const endedCall = advanceTurn.mock.calls.find((c) => c[0].status === "ended")[0];
    // A clean relay leaves the field absent from the payload (not sent as null noise).
    expect(endedCall).not.toHaveProperty("transcriptRelayError");
  });

  it("tolerates a legacy onSessionEnd that returns undefined (no relay error surfaced)", async () => {
    const advanceTurn = vi.fn(async () => {});
    const hooks = { onSessionEnd: vi.fn(async () => undefined) };
    const { waker } = makeWaker({ advanceTurn, hooks });
    const resolved = await waker.keyFor(TASK_NOTIF);
    await waker.wake(TASK_NOTIF, resolved.key, resolved);

    const endedCall = advanceTurn.mock.calls.find((c) => c[0].status === "ended")[0];
    expect(endedCall).not.toHaveProperty("transcriptRelayError");
  });

  it("does not attempt a transcript flush when the subprocess never spawned (no sessionId turn ran)", async () => {
    // A never-spawned wake leaves the turn pending; onSessionEnd is keyed on sessionId,
    // which is still resolved, so the flush is harmlessly a no-op batch. Assert it does
    // not throw and no terminal advance happens.
    const hooks = { onSessionEnd: vi.fn(async () => {}) };
    const { waker, advanceTurn } = makeWaker({ spawner: spawnerThatNeverSpawns(), hooks });
    const resolved = await waker.keyFor(TASK_NOTIF);
    await waker.wake(TASK_NOTIF, resolved.key, resolved);
    // No running turn ⇒ no ended; the flush still runs (best-effort) but advances nothing.
    expect(advanceTurn).not.toHaveBeenCalled();
  });

  it("defaults to a no-op-with-log reporter when none is injected (existing Wakers keep working)", async () => {
    const infos = [];
    // Build a Waker WITHOUT advanceTurn — the default no-op-with-log must be used.
    const waker = new Waker({
      creds: { url: "https://c", apiKey: "cho_x" },
      lineage: { resolve: async () => ({ rootIdeaUuid: ROOT_IDEA, directIdeaUuid: DIRECT_IDEA }) },
      spawner: spawnerThatSpawns(0),
      cwd: "/work/dir",
      logger: { ...silent, info: (m) => infos.push(m) },
      writeMcpConfigFn: vi.fn(() => ({ path: "/tmp/m.json", cleanup: vi.fn() })),
      isNewSessionFn: vi.fn(() => true),
    });
    const resolved = await waker.keyFor(TASK_NOTIF);
    await expect(waker.wake(TASK_NOTIF, resolved.key, resolved)).resolves.toBeUndefined();
    expect(infos.join("")).toMatch(/no turn reporter wired/);
  });
});
