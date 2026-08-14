// cli/__tests__/wake-queue.test.mjs
// Covers cli-daemon spec "Per-root-idea wake serialization" + the coalescing
// contract from design.md §C1 (daemon-wake-coalescing). The queue no longer runs
// opaque thunks — it carries opaque DATA items and, when a key's slot frees,
// drains the ENTIRE pending array for that key and calls a single
// runBatch(key, items) callback (supplied at construction). Natural batching
// only: NO debounce/collect timer, NO batch-size cap.
//
// Invariants under test: same-key serialization (next batch waits for the
// current runBatch to settle), cross-key concurrency bounded by maxConcurrency,
// coalescing (piled-up same-key items → one runBatch with all items),
// poisoned-batch isolation, and drain()/stop() graceful shutdown.
import { describe, it, expect } from "vitest";
import { WakeQueue } from "../wake-queue.mjs";

/** A controllable async task: resolves only when release() is called. */
function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, release: () => resolve() };
}

/** Flush the microtask queue only (NO macrotask/timer) — used to prove that
 *  coalescing fires on slot-free without any debounce timer. */
async function flushMicrotasks(n = 30) {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

/** Let both micro- and macro-tasks flush (a single timer tick). */
const tick = () => new Promise((r) => setTimeout(r, 0));

const silent = { info() {}, warn() {}, error() {} };

describe("WakeQueue coalescing", () => {
  it("coalesces same-key items that pile up during a running batch into ONE runBatch with all items", async () => {
    const batches = [];
    const firstStarted = deferred();
    const gate = deferred(); // holds the first batch open so later items pile up
    const q = new WakeQueue({
      logger: silent,
      runBatch: async (key, items) => {
        batches.push({ key, items });
        if (batches.length === 1) {
          firstStarted.release();
          await gate.promise;
        }
      },
    });

    // First enqueue claims the free slot immediately → batch of 1.
    q.enqueue("K", { n: 1 });
    await firstStarted.promise; // batch 1 is now in-flight, holding the key

    // These arrive while batch 1 runs → they MUST coalesce into one batch.
    q.enqueue("K", { n: 2 });
    q.enqueue("K", { n: 3 });
    q.enqueue("K", { n: 4 });

    expect(batches).toHaveLength(1);
    expect(batches[0].items).toEqual([{ n: 1 }]);

    gate.release(); // slot frees → drain [2,3,4] as ONE batch
    await tick();

    expect(batches).toHaveLength(2);
    expect(batches[1].key).toBe("K");
    expect(batches[1].items).toEqual([{ n: 2 }, { n: 3 }, { n: 4 }]);
  });

  it("coalesced batch fires on slot-free via microtasks only (no debounce timer)", async () => {
    const sizes = [];
    const gate = deferred();
    const q = new WakeQueue({
      logger: silent,
      runBatch: async (_key, items) => {
        sizes.push(items.length);
        if (sizes.length === 1) await gate.promise;
      },
    });
    q.enqueue("K", { n: 1 });
    await flushMicrotasks();
    q.enqueue("K", { n: 2 });
    q.enqueue("K", { n: 3 });
    gate.release();
    await flushMicrotasks(); // NO setTimeout — only microtasks
    expect(sizes).toEqual([1, 2]); // 2nd batch (size 2) ran with no timer gate
  });

  it("drains the entire pending array with no batch-size cap", async () => {
    const sizes = [];
    const gate = deferred();
    const q = new WakeQueue({
      maxConcurrency: 2,
      logger: silent,
      runBatch: async (_key, items) => {
        sizes.push(items.length);
        if (sizes.length === 1) await gate.promise;
      },
    });
    q.enqueue("K", { n: 0 });
    await tick();
    for (let i = 1; i <= 100; i++) q.enqueue("K", { n: i });
    gate.release();
    await tick();
    expect(sizes).toEqual([1, 100]); // all 100 piled-up items in ONE batch
  });
});

describe("WakeQueue same-key serialization", () => {
  it("does not start a key's next batch until the current batch's runBatch settles", async () => {
    const events = [];
    const gate1 = deferred();
    const q = new WakeQueue({
      logger: silent,
      runBatch: async (_key, items) => {
        const label = items.map((i) => i.n).join(",");
        events.push(`start:${label}`);
        if (items[0].n === 1) await gate1.promise;
        events.push(`end:${label}`);
      },
    });

    q.enqueue("K", { n: 1 });
    await tick(); // batch 1 in-flight, blocked on gate1
    q.enqueue("K", { n: 2 });
    q.enqueue("K", { n: 3 });
    await tick();
    expect(events).toEqual(["start:1"]); // batch 2 must NOT have started

    gate1.release();
    await tick();
    expect(events).toEqual(["start:1", "end:1", "start:2,3", "end:2,3"]);
  });
});

describe("WakeQueue cross-key concurrency", () => {
  it("runs batches for different keys concurrently", async () => {
    const started = [];
    const gates = { A: deferred(), B: deferred() };
    const q = new WakeQueue({
      maxConcurrency: 4,
      logger: silent,
      runBatch: async (key) => {
        started.push(key);
        await gates[key].promise;
      },
    });

    q.enqueue("A", {});
    q.enqueue("B", {});
    await tick();
    // Both started without either finishing → genuinely concurrent.
    expect(started.sort()).toEqual(["A", "B"]);
    gates.A.release();
    gates.B.release();
    await tick();
  });

  it("respects the global concurrency cap", async () => {
    let active = 0;
    let maxActive = 0;
    const gates = [];
    const q = new WakeQueue({
      maxConcurrency: 2,
      logger: silent,
      runBatch: async (_key, items) => {
        active++;
        maxActive = Math.max(maxActive, active);
        await items[0].gate.promise;
        active--;
      },
    });

    for (let i = 0; i < 5; i++) {
      const d = deferred();
      gates.push(d);
      q.enqueue(`key-${i}`, { gate: d });
    }
    await tick();
    expect(maxActive).toBe(2); // never more than the cap at once
    gates.forEach((d) => d.release());
    await tick();
  });
});

describe("WakeQueue failure isolation", () => {
  it("a throwing runBatch is logged and the key's next batch still runs", async () => {
    const warns = [];
    const ran = [];
    const gate1 = deferred();
    const q = new WakeQueue({
      logger: { ...silent, warn: (m) => warns.push(m) },
      runBatch: async (_key, items) => {
        ran.push(items.map((i) => i.n));
        if (items[0].n === 1) {
          await gate1.promise;
          throw new Error("boom");
        }
      },
    });

    q.enqueue("K", { n: 1 });
    await tick(); // batch 1 in-flight
    q.enqueue("K", { n: 2 }); // piles up while batch 1 runs
    gate1.release();
    await tick();

    expect(ran).toEqual([[1], [2]]); // poisoned batch didn't wedge the key
    expect(warns.join("")).toMatch(/wake batch for K failed/);
  });
});

describe("WakeQueue enqueue is non-blocking", () => {
  it("enqueue returns synchronously before runBatch runs", async () => {
    let ran = false;
    const q = new WakeQueue({
      logger: silent,
      runBatch: async () => {
        ran = true;
      },
    });
    q.enqueue("k", {});
    // Synchronously after enqueue, the batch has not run yet.
    expect(ran).toBe(false);
    await tick();
    expect(ran).toBe(true);
  });
});

describe("WakeQueue graceful shutdown (stop + drain)", () => {
  it("stop() prevents queued-but-unstarted batches from ever starting", async () => {
    const order = [];
    const gate1 = deferred();
    const q = new WakeQueue({
      maxConcurrency: 1,
      logger: silent,
      runBatch: async (key) => {
        order.push(`start:${key}`);
        if (key === "k1") await gate1.promise;
        order.push(`end:${key}`);
      },
    });

    q.enqueue("k1", {});
    q.enqueue("k2", {});
    await tick();
    expect(order).toEqual(["start:k1"]); // k2 waits on the concurrency slot

    q.stop(); // shutdown begins — k2 must never start
    gate1.release();
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual(["start:k1", "end:k1"]);
  });

  it("drain resolves true once in-flight batches finish (pending ones don't block it)", async () => {
    const gate1 = deferred();
    const q = new WakeQueue({
      maxConcurrency: 1,
      logger: silent,
      runBatch: async (key) => {
        if (key === "k1") await gate1.promise;
      },
    });
    q.enqueue("k1", {});
    q.enqueue("k2", {}); // queued, never starts after stop()
    await tick();
    q.stop();

    const drainP = q.drain(2_000);
    gate1.release();
    await expect(drainP).resolves.toBe(true);
  });

  it("drain resolves false when an in-flight batch outlives the bound (shutdown never hangs)", async () => {
    const never = deferred(); // batch that never finishes (unkillable wake)
    const q = new WakeQueue({
      logger: silent,
      runBatch: async () => {
        await never.promise;
      },
    });
    q.enqueue("k1", {});
    await tick();

    await expect(q.drain(120)).resolves.toBe(false);
    never.release(); // cleanup
  });

  it("drain on an idle queue resolves true immediately", async () => {
    const q = new WakeQueue({ logger: silent, runBatch: async () => {} });
    await expect(q.drain(0)).resolves.toBe(true);
  });
});
