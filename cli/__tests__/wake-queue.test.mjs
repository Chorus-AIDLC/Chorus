// cli/__tests__/wake-queue.test.mjs
// Covers cli-daemon spec "Per-root-idea wake serialization" — the BLOCKER fix
// from proposal review. Three scenarios: same-key serial, cross-key concurrent,
// failed task doesn't wedge the key.
import { describe, it, expect } from "vitest";
import { WakeQueue } from "../wake-queue.mjs";

/** A controllable async task: resolves only when release() is called. */
function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, release: () => resolve() };
}

const silent = { info() {}, warn() {}, error() {} };

describe("WakeQueue same-key serialization", () => {
  it("runs two same-key tasks strictly sequentially (2nd waits for 1st)", async () => {
    const q = new WakeQueue({ logger: silent });
    const order = [];
    const d1 = deferred();
    const d2 = deferred();

    q.enqueue("root-1", async () => {
      order.push("start-1");
      await d1.promise;
      order.push("end-1");
    });
    q.enqueue("root-1", async () => {
      order.push("start-2");
      await d2.promise;
      order.push("end-2");
    });

    // Let microtasks flush: only task 1 should have started.
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["start-1"]);

    // Finish task 1 → task 2 starts only now.
    d1.release();
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual(["start-1", "end-1", "start-2"]);

    d2.release();
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual(["start-1", "end-1", "start-2", "end-2"]);
  });
});

describe("WakeQueue cross-key concurrency", () => {
  it("runs tasks for different keys concurrently", async () => {
    const q = new WakeQueue({ maxConcurrency: 4, logger: silent });
    const started = [];
    const dA = deferred();
    const dB = deferred();

    q.enqueue("root-A", async () => {
      started.push("A");
      await dA.promise;
    });
    q.enqueue("root-B", async () => {
      started.push("B");
      await dB.promise;
    });

    await new Promise((r) => setTimeout(r, 0));
    // Both started without either finishing → genuinely concurrent.
    expect(started.sort()).toEqual(["A", "B"]);
    dA.release();
    dB.release();
    await new Promise((r) => setTimeout(r, 0));
  });

  it("respects the global concurrency cap", async () => {
    const q = new WakeQueue({ maxConcurrency: 2, logger: silent });
    let active = 0;
    let maxActive = 0;
    const defs = [];
    for (let i = 0; i < 5; i++) {
      const d = deferred();
      defs.push(d);
      q.enqueue(`key-${i}`, async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await d.promise;
        active--;
      });
    }
    await new Promise((r) => setTimeout(r, 0));
    expect(maxActive).toBe(2); // never more than the cap at once
    defs.forEach((d) => d.release());
    await new Promise((r) => setTimeout(r, 0));
  });
});

describe("WakeQueue failure isolation", () => {
  it("a throwing task is logged and the next same-key task still runs", async () => {
    const warns = [];
    const q = new WakeQueue({ logger: { ...silent, warn: (m) => warns.push(m) } });
    const ran = [];

    q.enqueue("root-1", async () => {
      ran.push("first");
      throw new Error("boom");
    });
    q.enqueue("root-1", async () => {
      ran.push("second");
    });

    await new Promise((r) => setTimeout(r, 0));
    expect(ran).toEqual(["first", "second"]); // poisoned task didn't wedge the key
    expect(warns.join("")).toMatch(/wake task for root-1 failed/);
  });
});

describe("WakeQueue enqueue is non-blocking", () => {
  it("enqueue returns synchronously before the task runs", async () => {
    const q = new WakeQueue({ logger: silent });
    let ran = false;
    q.enqueue("k", async () => {
      ran = true;
    });
    // Synchronously after enqueue, the task has not run yet.
    expect(ran).toBe(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(ran).toBe(true);
  });
});

describe("WakeQueue graceful shutdown (stop + drain)", () => {
  it("stop() prevents queued-but-unstarted tasks from ever starting", async () => {
    const q = new WakeQueue({ maxConcurrency: 1, logger: silent });
    const d1 = deferred();
    const order = [];

    q.enqueue("k1", async () => {
      order.push("start-1");
      await d1.promise;
      order.push("end-1");
    });
    q.enqueue("k2", async () => {
      order.push("start-2");
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["start-1"]); // k2 waits on the concurrency slot

    q.stop(); // shutdown begins — k2 must never start
    d1.release();
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual(["start-1", "end-1"]);
  });

  it("drain resolves true once in-flight tasks finish (pending ones don't block it)", async () => {
    const q = new WakeQueue({ maxConcurrency: 1, logger: silent });
    const d1 = deferred();
    q.enqueue("k1", async () => {
      await d1.promise;
    });
    q.enqueue("k2", async () => {}); // queued, never starts after stop()
    await Promise.resolve();
    q.stop();

    const drainP = q.drain(2_000);
    d1.release();
    await expect(drainP).resolves.toBe(true);
  });

  it("drain resolves false when an in-flight task outlives the bound (shutdown never hangs)", async () => {
    const q = new WakeQueue({ logger: silent });
    const never = deferred(); // task that never finishes (unkillable wake)
    q.enqueue("k1", async () => {
      await never.promise;
    });
    await Promise.resolve();

    await expect(q.drain(120)).resolves.toBe(false);
    never.release(); // cleanup
  });

  it("drain on an idle queue resolves true immediately", async () => {
    const q = new WakeQueue({ logger: silent });
    await expect(q.drain(0)).resolves.toBe(true);
  });
});
