// cli/wake-queue.mjs
// Per-key FIFO scheduler with a global concurrency cap. This is what makes the
// idea_root session anchor safe (cli-daemon spec "Per-root-idea wake
// serialization", design.md "Concurrency model"):
//   • within one key (root idea) → strictly serial, FIFO. The 2nd wake waits
//     for the 1st subprocess to exit, so we never run two
//     `claude --resume <sameSessionId>` against one session.
//   • across keys → concurrent, bounded by maxConcurrency.
//   • enqueue() returns immediately — never blocks the SSE loop.
//   • a task that throws is logged and the next task for that key proceeds (a
//     poisoned wake must not wedge the key's queue forever).
// Plain ESM, zero deps, in-memory.

const NOOP_LOGGER = { info() {}, warn() {}, error() {} };

export class WakeQueue {
  /**
   * @param {{
   *   maxConcurrency?: number,
   *   logger?: { info(m:string):void, warn(m:string):void, error(m:string):void },
   * }} [opts]
   */
  constructor(opts = {}) {
    this.maxConcurrency = opts.maxConcurrency ?? 4;
    this.logger = opts.logger ?? NOOP_LOGGER;
    /** @type {Map<string, Array<() => Promise<void>>>} pending tasks per key. */
    this.pending = new Map();
    /** @type {Set<string>} keys with a task currently running. */
    this.running = new Set();
    /** @type {string[]} keys waiting for a global concurrency slot. */
    this.readyKeys = [];
    this.activeCount = 0;
    // Graceful-shutdown latch: once set, #pump starts NOTHING new — in-flight tasks
    // finish (drain observes them) but queued work stays queued and dies with the
    // process. Never cleared; a stopping queue is on its way out.
    this.stopped = false;
  }

  /** Stop starting new tasks (graceful shutdown). In-flight tasks are unaffected. */
  stop() {
    this.stopped = true;
  }

  /**
   * Enqueue a wake task under a key. Returns immediately. The task is a thunk
   * returning a promise (the actual wake). Same key → serialized; different
   * keys → concurrent up to maxConcurrency.
   * @param {string} key
   * @param {() => Promise<void>} task
   */
  enqueue(key, task) {
    if (!this.pending.has(key)) this.pending.set(key, []);
    this.pending.get(key).push(task);
    // A key becomes "ready" to claim a global slot only when it's not already
    // running (serial-per-key) and not already queued for a slot.
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
   * Snapshot of the keys with a task currently running (observability read).
   * Returns a fresh array so a caller can't mutate the internal Set.
   * @returns {string[]}
   */
  runningKeys() {
    return [...this.running];
  }

  /**
   * Snapshot of the keys that have at least one task still waiting to run —
   * i.e. enqueued but not yet started (observability read). A key that is
   * currently running with no further queued work is NOT pending. Returns a
   * fresh array so a caller can't mutate internal state.
   * @returns {string[]}
   */
  pendingKeys() {
    return [...this.pending.entries()].filter(([, q]) => q.length > 0).map(([k]) => k);
  }

  /**
   * Wait (bounded) for every in-flight task to finish — the graceful-shutdown drain
   * (fix-daemon-exit-orphan-running-turn). Resolves `true` when the queue went idle
   * (no active task) within `timeoutMs`, `false` on timeout — the caller exits
   * anyway and leaves the rest to the server-side reconcile backstop. Pending
   * (not-yet-started) tasks are NOT waited for: a shutting-down daemon stops
   * starting new work, so only the in-flight subprocesses (and their exit reports)
   * matter. Polling (50ms) keeps this zero-dep and independent of task internals.
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
      this.#runNext(key);
    }
  }

  /** Run the next task for a key, then chain to the following one. */
  #runNext(key) {
    const queue = this.pending.get(key);
    if (!queue || queue.length === 0) {
      this.running.delete(key);
      return;
    }
    const task = queue.shift();
    this.running.add(key);
    this.activeCount++;

    Promise.resolve()
      .then(task)
      .catch((err) => {
        // Poisoned wake: log, do NOT let it wedge the key's queue.
        this.logger.warn(`[Chorus] wake task for ${key} failed: ${err}`);
      })
      .finally(() => {
        this.activeCount--;
        const remaining = this.pending.get(key);
        if (remaining && remaining.length > 0) {
          // Same key still has work → it must run serially. Re-mark ready;
          // #pump will pick it up (respecting the global cap).
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
