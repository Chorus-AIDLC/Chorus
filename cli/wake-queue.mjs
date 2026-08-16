// cli/wake-queue.mjs
// Per-key FIFO scheduler with a global concurrency cap, coalescing same-key
// wakes into batches. This is what makes the idea_root session anchor safe
// (cli-daemon spec "Per-root-idea wake serialization", design.md "Concurrency
// model") AND implements daemon-wake-coalescing (design.md §C1):
//   • within one key (root idea) → strictly serial, FIFO. The next batch waits
//     for the current runBatch to settle, so we never run two
//     `claude --resume <sameSessionId>` against one session.
//   • coalescing: when a key's slot frees, the ENTIRE pending array for that key
//     is drained (splice) and delivered to runBatch ONCE as a single batch. So
//     N events that pile up while the previous turn runs become ONE turn.
//     Natural batching only — NO debounce/collect timer, NO batch-size cap.
//   • across keys → concurrent, bounded by maxConcurrency.
//   • enqueue() returns immediately — never blocks the SSE loop.
//   • a batch whose runBatch throws is logged and the next batch for that key
//     proceeds (a poisoned wake must not wedge the key's queue forever).
// The queue carries opaque DATA items (the router passes `{ notification,
// attribution }`); it never introspects them — the runBatch callback (supplied
// at construction, wired to waker.wakeBatch in daemon.mjs) does.
// Plain ESM, zero deps, in-memory.

const NOOP_LOGGER = { info() {}, warn() {}, error() {} };

export class WakeQueue {
  /**
   * @param {{
   *   maxConcurrency?: number,
   *   logger?: { info(m:string):void, warn(m:string):void, error(m:string):void },
   *   runBatch?: (key: string, items: any[]) => Promise<void>,
   * }} [opts]
   */
  constructor(opts = {}) {
    this.maxConcurrency = opts.maxConcurrency ?? 4;
    this.logger = opts.logger ?? NOOP_LOGGER;
    // The batch runner: called ONCE per drained batch with every pending item
    // for the key. Defaults to a no-op so an unwired queue never throws (the
    // daemon always supplies the real waker.wakeBatch runner).
    this.runBatch = opts.runBatch ?? (async () => {});
    /** @type {Map<string, any[]>} pending data items per key. */
    this.pending = new Map();
    /** @type {Set<string>} keys with a batch currently running. */
    this.running = new Set();
    /** @type {string[]} keys waiting for a global concurrency slot. */
    this.readyKeys = [];
    this.activeCount = 0;
    // Graceful-shutdown latch: once set, #pump starts NOTHING new — in-flight
    // batches finish (drain observes them) but queued work stays queued and dies
    // with the process. Never cleared; a stopping queue is on its way out.
    this.stopped = false;
  }

  /** Stop starting new batches (graceful shutdown). In-flight batches are unaffected. */
  stop() {
    this.stopped = true;
  }

  /**
   * Enqueue an opaque data item under a key. Returns immediately. Items on the
   * same key coalesce: while a key's batch runs, later items pile up and are
   * drained together as ONE batch when the slot frees. Different keys run
   * concurrently up to maxConcurrency.
   * @param {string} key
   * @param {any} item  opaque data (e.g. `{ notification, attribution }`)
   */
  enqueue(key, item) {
    if (!this.pending.has(key)) this.pending.set(key, []);
    this.pending.get(key).push(item);
    // A key becomes "ready" to claim a global slot only when it's not already
    // running (serial-per-key) and not already queued for a slot. While it IS
    // running, later items simply accumulate in `pending` and are picked up by
    // the next batch — this is where coalescing happens.
    if (!this.running.has(key) && !this.readyKeys.includes(key)) {
      this.readyKeys.push(key);
    }
    this.#pump();
  }

  /** Number of keys with pending work (for tests/observability). */
  get pendingKeyCount() {
    return [...this.pending.values()].filter((q) => q.length > 0).length;
  }

  /**
   * Snapshot of the keys with a batch currently running (observability read).
   * Returns a fresh array so a caller can't mutate the internal Set.
   * @returns {string[]}
   */
  runningKeys() {
    return [...this.running];
  }

  /**
   * Snapshot of the keys that have at least one item still waiting to run —
   * i.e. enqueued but not yet started (observability read). A key that is
   * currently running with no further queued work is NOT pending. Returns a
   * fresh array so a caller can't mutate internal state.
   * @returns {string[]}
   */
  pendingKeys() {
    return [...this.pending.entries()].filter(([, q]) => q.length > 0).map(([k]) => k);
  }

  /**
   * Wait (bounded) for every in-flight batch to finish — the graceful-shutdown drain
   * (fix-daemon-exit-orphan-running-turn). Resolves `true` when the queue went idle
   * (no active batch) within `timeoutMs`, `false` on timeout — the caller exits
   * anyway and leaves the rest to the server-side reconcile backstop. Pending
   * (not-yet-started) items are NOT waited for: a shutting-down daemon stops
   * starting new work, so only the in-flight subprocesses (and their exit reports)
   * matter. Polling (50ms) keeps this zero-dep and independent of batch internals.
   * @param {number} timeoutMs
   * @returns {Promise<boolean>}
   */
  async drain(timeoutMs) {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (this.activeCount > 0) {
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, 50));
    }
    return true;
  }

  /** Try to start as many ready keys as the concurrency cap allows. */
  #pump() {
    if (this.stopped) return; // shutting down — start nothing new
    while (this.activeCount < this.maxConcurrency && this.readyKeys.length > 0) {
      const key = this.readyKeys.shift();
      if (this.running.has(key)) continue; // already running under another slot
      const queue = this.pending.get(key);
      if (!queue || queue.length === 0) continue;
      this.#startBatch(key);
    }
  }

  /**
   * Drain the ENTIRE pending array for a key into one batch and run it, then
   * chain to the following batch. No batch-size cap (design.md §C1, Q7).
   */
  #startBatch(key) {
    const queue = this.pending.get(key);
    if (!queue || queue.length === 0) {
      this.running.delete(key);
      return;
    }
    // Coalesce: take everything pending for this key right now as one batch.
    // Items that arrive after this splice accumulate for the NEXT batch.
    const items = queue.splice(0);
    this.running.add(key);
    this.activeCount++;

    Promise.resolve()
      .then(() => this.runBatch(key, items))
      .catch((err) => {
        // Poisoned batch: log, do NOT let it wedge the key's queue.
        this.logger.warn(`[Chorus] wake batch for ${key} failed: ${err}`);
      })
      .finally(() => {
        this.activeCount--;
        const remaining = this.pending.get(key);
        if (remaining && remaining.length > 0) {
          // Same key accumulated more work while this batch ran → it must run
          // serially as the next batch. Re-mark ready; #pump will pick it up
          // (respecting the global cap).
          if (!this.readyKeys.includes(key)) this.readyKeys.push(key);
          this.running.delete(key); // free the key so #pump can re-claim it
        } else {
          this.running.delete(key);
          this.pending.delete(key);
        }
        this.#pump();
      });
  }
}
