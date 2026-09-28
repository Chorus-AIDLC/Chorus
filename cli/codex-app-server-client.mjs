// Versioned wire contract and integration responsibilities:
// docs/verification/codex-app-server-protocol.md
import { TextDecoder } from "node:util";

export const APP_SERVER_DEFAULTS = Object.freeze({
  initializeTimeoutMs: 30_000,
  threadSetupTimeoutMs: 60_000,
  turnStartTimeoutMs: 60_000,
  requestTimeoutMs: 60_000,
  writeTimeoutMs: 60_000,
  maxFrameBytes: 32 * 1024 * 1024,
  maxQueuedBytes: 32 * 1024 * 1024,
  maxPendingRequests: 1024,
  stderrTailBytes: 8192,
});

export class CodexAppServerError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "CodexAppServerError";
    this.code = code;
    Object.assign(this, details);
  }
}

const fault = (code) => new CodexAppServerError(code, `Codex App Server: ${code}`);
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const has = (value, key) => Object.hasOwn(value, key);
const validId = (id) => typeof id === "string" || Number.isSafeInteger(id);
const positive = (value) => Number.isSafeInteger(value) && value > 0;

/** Deliberately narrower than "invalid request" or generic "not found". */
export function isHistoryUnavailableError(error, threadId) {
  return error instanceof CodexAppServerError
    && error.code === "RPC_ERROR"
    && error.method === "thread/resume"
    && error.rpcCode === -32600
    && typeof threadId === "string" && threadId.length > 0
    && error.rpcMessage === `no rollout found for thread id ${threadId}`;
}

/** No user answers or positive approvals are ever synthesized. */
export function headlessResponseFor(method) {
  switch (method) {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
      return { result: { decision: "cancel" } };
    case "item/permissions/requestApproval":
      return { result: { permissions: {}, scope: "turn" } };
    case "mcpServer/elicitation/request":
      return { result: { action: "cancel", content: null } };
    case "execCommandApproval":
    case "applyPatchApproval":
      return { result: { decision: "abort" } };
    case "item/tool/call":
      return { result: { contentItems: [], success: false } };
    case "item/tool/requestUserInput":
    case "account/chatgptAuthTokens/refresh":
    case "attestation/generate":
      return { error: { code: -32603, message: "Unavailable in headless mode" }, fatal: true };
    default:
      return { error: { code: -32601, message: "Method not supported" }, fatal: true };
  }
}

// A write callback can schedule a later error event, even after client teardown.
// Keep only this payload-blind guard until the actual stream/process closes.
function guardLateErrors(emitter) {
  const ignore = () => {};
  emitter.on("error", ignore);
  emitter.once("close", () => emitter.removeListener("error", ignore));
}

/**
 * Execution-scoped, bounded stdio RPC transport. Does not spawn, kill, retry,
 * interpret turn success, or call Chorus. Subscribe before sending requests.
 */
export class CodexAppServerClient {
  #child;
  #limits;
  #diagnostic;
  #error = null;
  #pending = new Map();
  #subscribers = new Set();
  #listeners = [];
  #closedEmitters = new WeakSet();
  #nextId = 1n;
  #frame = Buffer.alloc(0);
  #frameLength = 0;
  #stderr = Buffer.alloc(0);
  #queue = [];
  #queuedBytes = 0;
  #writing = false;
  #fatalReply = false;
  #resolveFailure;

  constructor(child, { limits = {}, onDiagnostic = () => {} } = {}) {
    this.#limits = { ...APP_SERVER_DEFAULTS, ...limits };
    if (Object.values(this.#limits).some((value) => !positive(value))
      || !child?.stdin?.write || !child?.stdout?.on || !child?.stderr?.on) {
      throw fault("INVALID_OPTIONS");
    }
    this.#child = child;
    this.#diagnostic = onDiagnostic;
    this.failure = new Promise((resolve) => { this.#resolveFailure = resolve; });
    for (const emitter of [child, child.stdin, child.stdout, child.stderr]) {
      this.#listen(emitter, "close", () => this.#closedEmitters.add(emitter));
    }
    this.#listen(child.stdout, "data", (chunk) => this.#read(chunk));
    this.#listen(child.stderr, "data", (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const limit = this.#limits.stderrTailBytes;
      // Copy so a tiny tail does not retain a huge input backing buffer.
      this.#stderr = bytes.length >= limit
        ? Buffer.from(bytes.subarray(bytes.length - limit))
        : Buffer.from(Buffer.concat([this.#stderr, bytes]).subarray(-limit));
    });
    this.#listen(child.stdout, "end", () => this.#stop(fault(
      this.#frameLength ? "TRUNCATED_FRAME" : "EOF",
    )));
    this.#listen(child.stdout, "close", () => this.#stop(fault("EOF")));
    this.#listen(child.stdin, "close", () => this.#stop(fault("IO_CLOSED")));
    this.#listen(child, "close", () => this.#stop(fault("PROCESS_CLOSED")));
    // Do not settle on exit: the shared spawner settlement drains trailing IO.
    for (const emitter of [child, child.stdin, child.stdout, child.stderr]) {
      this.#listen(emitter, "error", () => this.#stop(fault("IO_ERROR")));
    }
  }

  get error() { return this.#error; }
  get closed() { return this.#error !== null; }
  get pendingCount() { return this.#pending.size; }
  get stderrBytes() { return this.#stderr.length; }

  subscribe(listener) {
    if (typeof listener !== "function") throw fault("INVALID_SUBSCRIBER");
    if (!this.closed) this.#subscribers.add(listener);
    return () => this.#subscribers.delete(listener);
  }

  request(method, params, { timeoutMs = this.#timeout(method), signal } = {}) {
    if (this.closed) return Promise.reject(this.#error);
    if (this.#fatalReply) return Promise.reject(fault("HEADLESS_REQUEST_UNSUPPORTED"));
    if (!positive(timeoutMs) || typeof method !== "string" || !method
      || (signal && (typeof signal.addEventListener !== "function"
        || typeof signal.removeEventListener !== "function"))) {
      return Promise.reject(fault("INVALID_REQUEST"));
    }
    if (signal?.aborted) {
      this.#stop(fault("CANCELLED"));
      return Promise.reject(this.#error);
    }
    if (this.#pending.size >= this.#limits.maxPendingRequests) {
      this.#stop(fault("PENDING_LIMIT"));
      return Promise.reject(this.#error);
    }
    // String IDs avoid collisions/precision loss and preserve numeric server IDs.
    const id = `chorus-${this.#nextId++}`;
    return new Promise((resolve, reject) => {
      const abort = () => this.#stop(fault("CANCELLED"));
      const timer = setTimeout(() => this.#stop(fault("RESPONSE_TIMEOUT")), timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      };
      this.#pending.set(id, { resolve, reject, cleanup, method });
      signal?.addEventListener("abort", abort, { once: true });
      this.#send({ id, method, ...(params === undefined ? {} : { params }) })
        .catch((error) => {
          // A fatal reverse request discards unsent application frames before
          // flushing its negative response. Do not close that response early.
          if (!(this.#fatalReply && error.code === "HEADLESS_REQUEST_UNSUPPORTED")) this.#stop(error);
        });
    });
  }

  notify(method, params) {
    if (typeof method !== "string" || !method) return Promise.reject(fault("INVALID_REQUEST"));
    return this.#send({ method, ...(params === undefined ? {} : { params }) });
  }

  respond(id, response) {
    if (!validId(id) || !object(response) || has(response, "result") === has(response, "error")
      || (has(response, "result") && response.result === undefined)
      || (has(response, "error") && !this.#validRpcError(response.error))) {
      return Promise.reject(fault("INVALID_RESPONSE"));
    }
    return this.#send({ id, ...(has(response, "error")
      ? { error: response.error } : { result: response.result }) });
  }

  close() { this.#stop(fault("CLOSED")); }

  #timeout(method) {
    if (method === "initialize") return this.#limits.initializeTimeoutMs;
    if (method === "thread/start" || method === "thread/resume") return this.#limits.threadSetupTimeoutMs;
    if (method === "turn/start") return this.#limits.turnStartTimeoutMs;
    return this.#limits.requestTimeoutMs;
  }

  #listen(emitter, name, fn) {
    emitter.on(name, fn);
    this.#listeners.push(() => emitter.removeListener(name, fn));
  }

  #send(message) {
    if (this.closed) return Promise.reject(this.#error);
    if (this.#fatalReply && has(message, "method")) return Promise.reject(fault("HEADLESS_REQUEST_UNSUPPORTED"));
    let bytes;
    try {
      bytes = Buffer.from(`${JSON.stringify(message)}\n`);
    } catch {
      this.#stop(fault("INVALID_OUTBOUND_FRAME"));
      return Promise.reject(this.#error);
    }
    if (bytes.length - 1 > this.#limits.maxFrameBytes
      || this.#queuedBytes + bytes.length > this.#limits.maxQueuedBytes) {
      this.#stop(fault("WRITE_BUFFER_LIMIT"));
      return Promise.reject(this.#error);
    }
    return new Promise((resolve, reject) => {
      const entry = { bytes, resolve, reject, cleanup: () => {} };
      // Covers time spent queued as well as the actual backpressured write.
      const timer = setTimeout(() => this.#stop(fault("WRITE_TIMEOUT")), this.#limits.writeTimeoutMs);
      entry.cleanup = () => clearTimeout(timer);
      this.#queue.push(entry);
      this.#queuedBytes += bytes.length;
      this.#pump();
    });
  }

  #pump() {
    if (this.closed || this.#writing || !this.#queue.length) return;
    this.#writing = true;
    const entry = this.#queue[0];
    const stdin = this.#child.stdin;
    let returned = false;
    let callbackDone = false;
    let drained = false;
    let needsDrain = false;
    const done = () => {
      if (this.closed || !returned || !callbackDone || (needsDrain && !drained)) return;
      entry.cleanup();
      this.#queue.shift();
      this.#queuedBytes -= entry.bytes.length;
      this.#writing = false;
      entry.resolve();
      this.#pump();
    };
    const onDrain = () => { drained = true; done(); };
    const clearTimer = entry.cleanup;
    entry.cleanup = () => { clearTimer(); stdin.removeListener("drain", onDrain); };
    stdin.on("drain", onDrain);
    try {
      needsDrain = stdin.write(entry.bytes, (error) => {
        if (error) { this.#stop(fault("IO_ERROR")); return; }
        callbackDone = true;
        done();
      }) === false;
      returned = true;
      done();
    } catch {
      this.#stop(fault("IO_ERROR"));
    }
  }

  #read(chunk) {
    if (this.closed) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let offset = 0;
    while (offset < bytes.length && !this.closed) {
      const newline = bytes.indexOf(10, offset);
      const end = newline < 0 ? bytes.length : newline;
      const length = end - offset;
      if (this.#frameLength + length > this.#limits.maxFrameBytes) {
        this.#stop(fault("FRAME_LIMIT"));
        return;
      }
      const required = this.#frameLength + length;
      if (required > this.#frame.length) {
        const capacity = Math.min(this.#limits.maxFrameBytes, Math.max(required, 1024, this.#frame.length * 2));
        const next = Buffer.allocUnsafe(capacity);
        this.#frame.copy(next, 0, 0, this.#frameLength);
        this.#frame = next;
      }
      bytes.copy(this.#frame, this.#frameLength, offset, end);
      this.#frameLength = required;
      if (newline < 0) return;
      const frame = this.#frame.subarray(0, this.#frameLength);
      this.#frameLength = 0;
      try {
        // Fatal decoding detects malformed UTF-8; buffering preserves split code points.
        this.#message(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame)));
      } catch {
        this.#stop(fault("MALFORMED_FRAME"));
      }
      offset = end + 1;
    }
  }

  #validRpcError(error) {
    return object(error) && Number.isSafeInteger(error.code) && typeof error.message === "string";
  }

  #message(message) {
    if (this.#fatalReply) return; // Only the bounded negative-response write remains.
    if (!object(message) || (has(message, "jsonrpc") && message.jsonrpc !== "2.0")) {
      throw fault("MALFORMED_FRAME");
    }
    if (has(message, "method")) {
      if (typeof message.method !== "string" || !message.method
        || has(message, "result") || has(message, "error")
        || (has(message, "id") && !validId(message.id))) throw fault("MALFORMED_FRAME");
      if (has(message, "id")) {
        const { fatal, ...response } = headlessResponseFor(message.method);
        this.#diagnose(fatal ? "HEADLESS_REQUEST_UNSUPPORTED" : "HEADLESS_REQUEST_DENIED");
        if (fatal) {
          this.#fatalReply = true;
          const error = fault("HEADLESS_REQUEST_UNSUPPORTED");
          for (const pending of this.#pending.values()) {
            pending.cleanup();
            pending.reject(error);
          }
          this.#pending.clear();
          // The active write has already reached stdin and cannot be recalled.
          // Keep its callback/drain and deadline, but remove everything unsent.
          const unsent = this.#queue.splice(this.#writing ? 1 : 0);
          for (const entry of unsent) {
            entry.cleanup();
            this.#queuedBytes -= entry.bytes.length;
            entry.reject(error);
          }
        }
        this.respond(message.id, response).then(() => {
          if (fatal) this.#stop(fault("HEADLESS_REQUEST_UNSUPPORTED"));
        }).catch((error) => this.#stop(error));
      }
    } else {
      if (!has(message, "id") || !validId(message.id)
        || has(message, "result") === has(message, "error")
        || (has(message, "error") && !this.#validRpcError(message.error))) throw fault("MALFORMED_FRAME");
      const pending = this.#pending.get(message.id);
      if (pending) {
        this.#pending.delete(message.id);
        pending.cleanup();
        if (has(message, "error")) {
          const error = new CodexAppServerError("RPC_ERROR", "Codex App Server RPC request failed", {
            method: pending.method, rpcCode: message.error.code,
          });
          // Needed for the exact verified fallback; excluded from serialization/logging.
          Object.defineProperty(error, "rpcMessage", { value: message.error.message });
          pending.reject(error);
        } else pending.resolve(message.result);
      }
    }
    for (const listener of this.#subscribers) {
      try {
        const result = listener(message);
        // Do not allow an accidental async subscriber rejection to escape.
        if (result?.then) Promise.resolve(result).catch(() => this.#stop(fault("SUBSCRIBER_ERROR")));
      } catch {
        this.#stop(fault("SUBSCRIBER_ERROR"));
        return;
      }
    }
  }

  #diagnose(code) {
    try {
      const result = this.#diagnostic(`Codex App Server: ${code}`);
      if (result?.then) Promise.resolve(result).catch(() => {});
    } catch { /* Diagnostic callbacks cannot strand transport cleanup. */ }
  }

  #stop(error) {
    if (this.closed) return;
    this.#error = error instanceof CodexAppServerError ? error : fault("IO_ERROR");
    for (const remove of this.#listeners.splice(0)) remove();
    for (const emitter of [this.#child, this.#child.stdin, this.#child.stdout, this.#child.stderr]) {
      if (!emitter.closed && !emitter.destroyed && !this.#closedEmitters.has(emitter)) guardLateErrors(emitter);
    }
    for (const pending of this.#pending.values()) {
      pending.cleanup();
      pending.reject(this.#error);
    }
    this.#pending.clear();
    for (const entry of this.#queue) {
      entry.cleanup();
      entry.reject(this.#error);
    }
    this.#queue = [];
    this.#queuedBytes = 0;
    this.#writing = false;
    this.#frame = Buffer.alloc(0);
    this.#frameLength = 0;
    this.#stderr = Buffer.alloc(0);
    this.#subscribers.clear();
    this.#resolveFailure(this.#error);
    this.#diagnose(this.#error.code);
    try { this.#child.stdin.end(); } catch { /* Tree cleanup belongs to spawner. */ }
  }
}
