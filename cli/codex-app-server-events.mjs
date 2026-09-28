// App Server notifications -> existing Chorus transcript/usage envelopes.
// Transport, process lifecycle and persistence belong to the spawner.
import { CodexAppServerError } from "./codex-app-server-client.mjs";
import { normalizeCodexUsageEvent } from "./codex-usage-map.mjs";

const COUNTERS = {
  inputTokens: "input_tokens",
  cachedInputTokens: "cached_input_tokens",
  cacheWriteInputTokens: "cache_write_input_tokens",
  outputTokens: "output_tokens",
  reasoningOutputTokens: "reasoning_output_tokens",
};
const validCount = (v) => Number.isSafeInteger(v) && v >= 0;
const nonempty = (v) => typeof v === "string" && v.trim().length > 0;
const fail = (code) => new CodexAppServerError(code, `Codex App Server: ${code}`);
const ZERO = Object.fromEntries(Object.values(COUNTERS).map((k) => [k, 0]));

export class CodexAppServerEvents {
  #threadId;
  #turnId = null;
  #observedTurnId = null;
  #baseline;
  #isNew;
  #onMessage;
  #onUsageSnapshot;
  #buffer = [];
  #bufferBytes = 0;
  #maxBufferedBytes;
  #maxItems;
  #seen = new Set();
  #snapshot = null;
  #lastObserved = {};
  #tainted = new Set();
  #outcome = null;
  #finished = false;
  #noticeSent = false;
  #resolveCompletion;

  constructor({
    threadId, isNew = false, previousUsage = null,
    onMessage = () => {}, onUsageSnapshot = () => {},
    maxBufferedBytes = 32 * 1024 * 1024, maxItems = 100_000,
  }) {
    if (!nonempty(threadId) || !Number.isSafeInteger(maxBufferedBytes) || maxBufferedBytes <= 0
      || !Number.isSafeInteger(maxItems) || maxItems <= 0) throw fail("INVALID_EVENT_OPTIONS");
    this.#threadId = threadId;
    this.#isNew = isNew;
    this.#baseline = previousUsage ? { ...previousUsage } : null;
    this.#lastObserved = isNew ? {} : { ...this.#baseline };
    this.#onMessage = onMessage;
    this.#onUsageSnapshot = onUsageSnapshot;
    this.#maxBufferedBytes = maxBufferedBytes;
    this.#maxItems = maxItems;
    this.completion = new Promise((resolve) => { this.#resolveCompletion = resolve; });
  }

  get turnId() { return this.#turnId; }
  get observedTurnId() { return this.#observedTurnId; }
  get outcome() { return this.#outcome; }
  get usageSnapshot() { return this.#snapshot ? { ...this.#snapshot } : null; }

  /** Authoritative turn/start response; buffered events cannot settle before it. */
  confirmTurn(turnId) {
    if (!nonempty(turnId) || (this.#turnId && this.#turnId !== turnId)) throw fail("INVALID_TURN_ID");
    if (this.#finished) throw fail("EVENT_ADAPTER_CLOSED");
    this.#turnId = turnId;
    const buffered = this.#buffer;
    this.#buffer = [];
    this.#bufferBytes = 0;
    for (const message of buffered) this.accept(message);
  }

  /** Returns whether the frame is relevant semantic progress for this wake. */
  accept(message) {
    if (this.#finished || !message || Object.hasOwn(message, "id")) return false;
    const { method, params } = message;
    if (typeof method !== "string" || !params || params.threadId !== this.#threadId) return false;
    const turnId = method === "turn/started" || method === "turn/completed"
      ? params.turn?.id : params.turnId;
    if (!nonempty(turnId)) return false;
    if (!(method.startsWith("item/") || method === "turn/started"
      || method === "turn/completed" || method === "thread/tokenUsage/updated")) return false;
    if (!this.#turnId) {
      if (method === "turn/started") this.#observedTurnId = turnId;
      // Only completed snapshots and totals are needed after confirmation.
      if (method !== "turn/started" && method !== "turn/completed"
        && method !== "item/completed" && method !== "thread/tokenUsage/updated") return true;
      const bytes = Buffer.byteLength(JSON.stringify(message));
      if (this.#bufferBytes + bytes > this.#maxBufferedBytes || this.#buffer.length >= this.#maxItems) {
        throw fail("EVENT_BUFFER_LIMIT");
      }
      this.#buffer.push(message);
      this.#bufferBytes += bytes;
      return true;
    }
    if (turnId !== this.#turnId) return false;
    if (method === "item/completed") this.#item(params.item);
    if (method === "thread/tokenUsage/updated") this.#usage(params.tokenUsage?.total);
    if (method === "turn/completed") {
      if (!["completed", "failed", "interrupted"].includes(params.turn?.status)) throw fail("INVALID_TURN_OUTCOME");
      // Some transports deliver the terminal snapshot without every item event.
      for (const item of Array.isArray(params.turn.items) ? params.turn.items : []) this.#item(item);
      this.#outcome = { status: params.turn.status, turnId: this.#turnId };
      this.finish();
      this.#resolveCompletion(this.#outcome);
    }
    return true;
  }

  #item(item) {
    if (item?.type !== "agentMessage" || !nonempty(item.id) || !nonempty(item.text) || this.#seen.has(item.id)) return;
    if (this.#seen.size >= this.#maxItems) throw fail("ITEM_LIMIT");
    this.#seen.add(item.id);
    this.#onMessage({
      type: "item.completed",
      item: { id: item.id, type: "agent_message", text: item.text, phase: item.phase ?? null },
    });
  }

  #usage(total) {
    if (!total || typeof total !== "object" || Array.isArray(total)) return;
    const snapshot = {};
    for (const [from, to] of Object.entries(COUNTERS)) {
      if (!validCount(total[from])) continue;
      snapshot[to] = total[from];
      // Never turn a counter reset into a historical charge, including resets
      // between two notifications inside this wake.
      const before = this.#lastObserved[to];
      if (validCount(before) && snapshot[to] < before) this.#tainted.add(to);
      this.#lastObserved[to] = snapshot[to];
    }
    if (!Object.keys(snapshot).length) return;
    if (this.#tainted.has("cached_input_tokens") || this.#tainted.has("cache_write_input_tokens")) {
      this.#tainted.add("input_tokens"); // Exclusive input depends on both cache deltas.
    }
    if (JSON.stringify(snapshot) === JSON.stringify(this.#snapshot)) return;
    this.#snapshot = snapshot;
    this.#onUsageSnapshot({ ...snapshot });
  }

  /** One notice per fallback, through the same transcript consumer as replies. */
  notice(text) {
    if (this.#finished || this.#noticeSent || !nonempty(text)) return;
    this.#noticeSent = true;
    this.#onMessage({
      type: "item.completed",
      item: { id: `chorus-continuity-${this.#threadId}`, type: "agent_message", text },
    });
  }

  /**
   * Flush at most one usage frame, including partial valid totals on crash.
   * The spawner owns persistence; snapshot callbacks also seed interrupted turns.
   */
  finish() {
    if (this.#finished) return this.usageSnapshot;
    this.#finished = true;
    this.#buffer = [];
    this.#bufferBytes = 0;
    let usage = null;
    if (this.#snapshot && (this.#isNew || this.#baseline)) {
      const delta = {};
      for (const key of Object.values(COUNTERS)) {
        const now = this.#snapshot[key];
        const before = this.#isNew ? 0 : this.#baseline?.[key];
        delta[key] = validCount(now) && validCount(before) && now >= before && !this.#tainted.has(key)
          ? now - before : null;
      }
      // Shared normalization excludes cache reads/writes from input exactly once.
      usage = normalizeCodexUsageEvent({ type: "turn.completed", usage: delta }, ZERO).usage;
    }
    this.#onMessage({ type: "turn.completed", usage });
    this.#seen.clear();
    return this.usageSnapshot;
  }
}
