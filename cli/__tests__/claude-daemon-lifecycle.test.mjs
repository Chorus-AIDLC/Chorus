// Cross-layer acceptance for the Claude stream-json protocol interrupt (design D4):
// real Waker, control handler, ClaudeSpawner and killProcessTree (the waker's and
// control handler's default killer). Only the child's stdio and process.kill are
// synthetic, so no real process is ever signalled.
import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { ClaudeSpawner } from "../claude-spawner.mjs";
import { Waker } from "../waker.mjs";
import { createControlHandler } from "../control-handler.mjs";

const IDEA = "74444444-4444-4444-8444-444444444444";
const creds = { url: "https://chorus.test", apiKey: "test-key" };
const silent = { info() {}, warn() {}, error() {} };
const INTERRUPT = { type: "control_request", request_id: "chorus-interrupt-1", request: { subtype: "interrupt" } };

let nextPid = 91000;
const children = new Map(); // pid → fake child, for the process.kill stub

/**
 * A fake stream-json Claude child. With `honorInterrupt` it answers the interrupt
 * like CLI 2.1.283 (ack + error result); after stdin closes following a result it
 * exits like the CLI does. `completeTurn` ends the turn normally right away.
 */
function fakeClaude({ honorInterrupt = true, completeTurn = false } = {}) {
  const child = new EventEmitter();
  child.pid = nextPid++;
  child.exitCode = null;
  child.signalCode = null;
  child.frames = [];
  let resultSent = false;
  const emit = (frame) => child.stdout.emit("data", `${JSON.stringify(frame)}\n`);
  const result = (subtype) => { resultSent = true; emit({ type: "result", subtype, is_error: subtype !== "success", session_id: IDEA }); };
  child.exit = (code, signal = null) => {
    if (child.exitCode !== null || child.signalCode) return;
    child.exitCode = signal ? null : code;
    child.signalCode = signal;
    child.emit("exit", child.exitCode, signal);
    child.emit("close", child.exitCode, signal);
  };
  const stdin = new EventEmitter();
  stdin.write = (line) => {
    const frame = JSON.parse(line);
    child.frames.push(frame);
    queueMicrotask(() => {
      if (frame.type === "user") {
        emit({ type: "system", subtype: "init", session_id: IDEA });
        if (completeTurn) result("success");
      } else if (frame.type === "control_request" && frame.request?.subtype === "interrupt" && honorInterrupt) {
        emit({ type: "control_response", response: { subtype: "success", request_id: frame.request_id, response: { still_queued: [] } } });
        emit({ type: "user", message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] }, session_id: IDEA });
        result("error_during_execution");
      }
    });
    return true;
  };
  stdin.end = vi.fn(() => {
    if (resultSent) queueMicrotask(() => child.exit(completeTurn ? 0 : 1));
    // EOF with no user frame: the CLI has nothing to run and exits without a turn.
    else if (!child.frames.some((f) => f.type === "user")) queueMicrotask(() => child.exit(1));
  });
  child.stdin = stdin;
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter();
  child.stderr.setEncoding = () => {};
  children.set(child.pid, child);
  return child;
}

let killSpy;
function stubProcessKill() {
  const signals = [];
  killSpy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    const child = children.get(Math.abs(pid));
    if (!child) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
    signals.push({ pid, signal });
    const gone = child.exitCode !== null || child.signalCode;
    if (signal === 0) { if (gone) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" }); return true; }
    if (signal === "SIGKILL") child.exit(null, "SIGKILL");
    return true;
  });
  return signals;
}
afterEach(() => { killSpy?.mockRestore(); killSpy = null; children.clear(); });

function harness({ childOptions, transcripts = new Set(), sigintTimeoutMs = 2_000, onSpawn } = {}) {
  const turns = [], interrupts = [], spawned = [];
  let waker;
  const spawner = new ClaudeSpawner({
    claudePath: "/fake/claude", logger: silent, platform: "linux", creds,
    spawnImpl: (_cmd, argv) => {
      onSpawn?.(waker);
      const child = fakeClaude(childOptions);
      spawned.push({ argv, child });
      // Claude writes the transcript as soon as the session starts.
      const i = argv.indexOf("--session-id");
      if (i >= 0) transcripts.add(argv[i + 1]);
      return child;
    },
  });
  waker = new Waker({
    creds, spawner, logger: silent, cwd: "/nonexistent/chorus-claude-lifecycle", sigintTimeoutMs,
    lineage: { resolve: async () => ({ rootIdeaUuid: IDEA, directIdeaUuid: IDEA }) },
    writeMcpConfigFn: () => ({ path: "/unused.json", cleanup() {} }),
    isNewSessionFn: (sessionId) => !transcripts.has(sessionId),
    validateRuntimeCwd: async (cwd) => ({ normalizedPath: cwd }),
    advanceTurn: async (p) => { turns.push(p); return { ok: true, data: { turnUuid: p.turnUuid } }; },
    reportInterrupt: async (...args) => { interrupts.push(args); },
  });
  const control = createControlHandler({ waker, getConnectionUuid: () => "connection", sigintTimeoutMs, logger: silent });
  async function wake() {
    const notification = { uuid: "notification", entityType: "task", entityUuid: "task",
      entityTitle: "Task", projectUuid: "project", action: "task_assigned", message: "",
      actorType: "user", actorUuid: "user", actorName: "Owner" };
    const resolved = await waker.keyFor(notification);
    return waker.wake(notification, resolved.key, resolved);
  }
  // A canonical research operation: its admitted turn arms the waker's
  // cancel-before-spawn branch (onChild kills a child whose stop already landed).
  async function wakeResearch() {
    const notification = {
      uuid: "research-notification", action: "research_requested", entityType: "idea", entityUuid: IDEA,
      turnUuid: "research-turn", sessionId: IDEA, directIdeaUuid: IDEA, runtimeCwd: "/work",
      promptText: "", operationPayload: { version: 1, kind: "research", ideaUuid: IDEA },
    };
    const attribution = { rootIdeaUuid: IDEA, directIdeaUuid: IDEA, key: `idea:${IDEA}` };
    return waker.wake(notification, attribution.key, attribution);
  }
  return { waker, control, wake, wakeResearch, turns, interrupts, spawned, transcripts };
}

describe("Claude stream-json daemon lifecycle: protocol interrupt", () => {
  it("a user interrupt via the control handler ends the turn over the protocol, reports interrupted(user), then resumes the anchor", async () => {
    const signals = stubProcessKill();
    const h = harness();
    const running = h.wake();
    await vi.waitFor(() => expect(h.spawned[0]?.child.frames.some((f) => f.type === "user")).toBe(true));
    const { child, argv } = h.spawned[0];
    expect(argv).toEqual(expect.arrayContaining(["--session-id", IDEA]));

    h.control({ type: "control", command: "interrupt", targetConnectionUuid: "connection", entityType: "idea", entityUuid: IDEA });
    await running;

    expect(child.frames[1]).toEqual(INTERRUPT);
    expect(child.frames).toHaveLength(2);
    expect(child.stdin.end).toHaveBeenCalledTimes(1);
    // protocol stop, not signals: no SIGINT and no forced kill
    expect(signals.some((s) => s.signal === "SIGINT" || s.signal === "SIGKILL")).toBe(false);
    expect(child.exitCode).toBe(1);
    expect(h.turns.map((t) => t.status)).toEqual(["running", "interrupted"]);
    expect(h.turns[1]).toMatchObject({ interruptedReason: "user", backendSessionId: IDEA });
    expect(h.interrupts).toEqual([["task", "task", "user"]]);

    // A later wake for the same anchor resumes it.
    const again = harness({ transcripts: h.transcripts, childOptions: { completeTurn: true } });
    await again.wake();
    expect(again.spawned[0].argv).toEqual(expect.arrayContaining(["--resume", IDEA]));
    expect(again.spawned[0].argv).not.toContain("--session-id");
    expect(again.turns.map((t) => t.status)).toEqual(["running", "ended"]);
  });

  it("a child ignoring the interrupt is force-cleaned within the deadline and still reports interrupted(user)", async () => {
    const signals = stubProcessKill();
    const sigintTimeoutMs = 300;
    const h = harness({ childOptions: { honorInterrupt: false }, sigintTimeoutMs });
    const running = h.wake();
    await vi.waitFor(() => expect(h.spawned[0]?.child.frames.some((f) => f.type === "user")).toBe(true));
    const start = Date.now();
    h.control({ type: "control", command: "interrupt", targetConnectionUuid: "connection", entityType: "idea", entityUuid: IDEA });
    await running;
    const { child } = h.spawned[0];
    // One full extra window of slack for loaded CI runners; still fails if the forced
    // cleanup waited a second window (or fell back to the 10 s default).
    expect(Date.now() - start).toBeLessThan(2 * sigintTimeoutMs);
    expect(child.frames[1]).toEqual(INTERRUPT);
    expect(signals).toEqual(expect.arrayContaining([{ pid: -child.pid, signal: "SIGKILL" }]));
    expect(signals.some((s) => s.signal === "SIGINT")).toBe(false);
    expect(h.turns[1]).toMatchObject({ status: "interrupted", interruptedReason: "user" });
    expect(h.interrupts).toEqual([["task", "task", "user"]]);
  });

  it.each([
    ["user interrupt", (w) => w.markInterrupting("idea", IDEA), "user"],
    ["daemon shutdown", (w) => w.interruptAll(), "shutdown"],
  ])("a %s landing while the child spawns (waker onChild cancel branch) never delivers the prompt (code-review B1)", async (_label, stop, reason) => {
    const signals = stubProcessKill();
    // The stop lands after the waker's pre-launch check but before onChild, so the
    // waker's onChild calls the real killProcessTree before the spawner writes the prompt.
    const h = harness({ onSpawn: stop });
    await h.wakeResearch();
    const { child } = h.spawned[0];
    expect(child.frames).toEqual([]); // no user frame, and nothing to interrupt
    expect(child.stdin.end).toHaveBeenCalledTimes(1);
    expect(signals.some((s) => s.signal === "SIGINT" || s.signal === "SIGKILL")).toBe(false);
    expect(h.turns.at(-1)).toMatchObject({ turnUuid: "research-turn", status: "interrupted", interruptedReason: reason });
  });

  it("daemon shutdown (interruptAll) stops the wake over the protocol and reports interrupted(shutdown)", async () => {
    const signals = stubProcessKill();
    const h = harness();
    const running = h.wake();
    await vi.waitFor(() => expect(h.spawned[0]?.child.frames.some((f) => f.type === "user")).toBe(true));
    h.waker.interruptAll();
    await running;
    const { child } = h.spawned[0];
    expect(child.frames[1]).toEqual(INTERRUPT);
    expect(signals.some((s) => s.signal === "SIGINT" || s.signal === "SIGKILL")).toBe(false);
    expect(h.turns.map((t) => t.status)).toEqual(["running", "interrupted"]);
    expect(h.turns[1].interruptedReason).toBe("shutdown");
    expect(h.interrupts).toEqual([]); // shutdown suppresses the execution interrupt report
  });
});
