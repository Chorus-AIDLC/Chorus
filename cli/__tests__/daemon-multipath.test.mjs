// cli/__tests__/daemon-multipath.test.mjs
// T3 — 单 daemon 多路径引擎. Covers the engine core:
//   • AC#1 unified cwd source of truth: Waker.resolveCwd() drives BOTH the transcript
//     probe and the spawn; process-level cwd is only the unspecified fallback.
//   • AC#2 multi-path registration: one daemon process serving a SET of cwds builds one
//     independent connection per path, each self-reporting its own cwd.
//   • AC#3 per-spawn cwd: each spawned child uses its connection-bound cwd; the daemon
//     process cwd never changes; the same session's repeated wakes land the same cwd.
//   • AC#6 HARD-1: an unspecified cwd (old daemon) degrades to the process default cwd
//     for both spawn and self-report — behaves exactly as before.
import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDaemon } from "../daemon.mjs";
import { Waker } from "../waker.mjs";
import { transcriptPath } from "../claude-spawner.mjs";

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

function mockMcp() {
  return {
    async callTool(name) {
      return name === "chorus_get_notifications" ? { notifications: [TASK_NOTIF] } : null;
    },
    async disconnect() {},
  };
}

function lineageFetch() {
  return async (url) => ({
    ok: true,
    status: 200,
    async json() {
      if (String(url).includes("/api/entities/task/task-1/root-idea")) {
        return {
          success: true,
          data: { rootIdeaUuid: ROOT_IDEA, directIdeaUuid: DIRECT_IDEA, lineage: [], resolvedVia: "via_proposal" },
        };
      }
      return { success: true, data: { rootIdeaUuid: null, directIdeaUuid: null, lineage: [], resolvedVia: "not_found" } };
    },
  });
}

/** A mock SSE listener mirroring the real fork; records the cwd it was constructed with. */
class MockSse {
  constructor(opts) {
    this.opts = opts;
    // Mirror the real SseListener: an unspecified cwd self-reports the process cwd
    // (HARD-1). So `this.cwd` is the value actually sent to the server.
    this.cwd = opts.cwd ?? process.cwd();
    this.connected = false;
  }
  async connect() {
    this.connected = true;
  }
  disconnect() {
    this.connected = false;
  }
  deliver(event) {
    if (event?.type === "connection_registered") return this.opts.onConnectionId?.(event.connectionUuid);
    if (event?.type === "control") return this.opts.onControl?.(event);
    if (event?.type === "connection_conflict") return this.opts.onConflict?.(event);
    this.opts.onEvent(event);
  }
}

// ===== AC#1 — Waker.resolveCwd() is the single cwd source of truth =====
describe("AC#1 unified cwd source of truth (Waker.resolveCwd)", () => {
  it("resolveCwd returns the connection-bound cwd when one is declared", () => {
    const waker = new Waker({ creds: {}, lineage: {}, spawner: {}, cwd: "/dev/repo-a", logger: silent });
    expect(waker.resolveCwd()).toBe("/dev/repo-a");
  });

  it("resolveCwd degrades to the process cwd when cwd is unspecified (HARD-1 fallback)", () => {
    const waker = new Waker({ creds: {}, lineage: {}, spawner: {}, logger: silent });
    expect(waker.cwd).toBeUndefined(); // stored raw — no process.cwd() baked at construction
    expect(waker.resolveCwd()).toBe(process.cwd());
  });

  it("the transcript probe AND the spawn both receive the SAME resolved cwd", async () => {
    const probeCwds = [];
    const spawnCwds = [];
    const waker = new Waker({
      creds: { url: "u", apiKey: "k" },
      lineage: { resolve: async () => ({ rootIdeaUuid: ROOT_IDEA, directIdeaUuid: DIRECT_IDEA }) },
      isNewSessionFn: (_id, cwd) => {
        probeCwds.push(cwd);
        return true;
      },
      writeMcpConfigFn: () => ({ path: "/tmp/mcp.json", cleanup() {} }),
      spawner: {
        wake: vi.fn(async (params) => {
          spawnCwds.push(params.cwd);
          return { sessionId: params.sessionId, exitCode: 0, isNew: params.isNew };
        }),
      },
      cwd: "/dev/repo-bound",
      logger: silent,
    });
    await waker.wake(TASK_NOTIF, `idea:${DIRECT_IDEA}`, { rootIdeaUuid: ROOT_IDEA, directIdeaUuid: DIRECT_IDEA });
    // One probe, one spawn, both at the connection-bound cwd — never process.cwd().
    expect(probeCwds).toEqual(["/dev/repo-bound"]);
    expect(spawnCwds).toEqual(["/dev/repo-bound"]);
  });
});

// ===== AC#2 / AC#3 — single daemon, multiple paths =====
describe("AC#2/#3 single daemon serving a SET of cwds", () => {
  it("builds one independent connection per declared cwd, each self-reporting its own cwd", async () => {
    const created = [];
    const daemon = buildDaemon(
      { url: "https://c", apiKey: "cho_x" },
      {
        logger: silent,
        mcpClient: mockMcp(),
        fetchImpl: lineageFetch(),
        spawner: { wake: vi.fn(async (p) => ({ sessionId: p.sessionId, exitCode: 0, isNew: p.isNew })) },
        cwds: ["/dev/repo-a", "/dev/repo-b"],
        makeSseListener: (o) => {
          const sse = new MockSse(o);
          created.push(sse);
          return sse;
        },
      }
    );
    // Two connections, each with its own Waker bound to a distinct cwd.
    expect(daemon.connections).toHaveLength(2);
    expect(daemon.connections.map((c) => c.cwd)).toEqual(["/dev/repo-a", "/dev/repo-b"]);
    expect(daemon.connections[0].waker.resolveCwd()).toBe("/dev/repo-a");
    expect(daemon.connections[1].waker.resolveCwd()).toBe("/dev/repo-b");
    // Each connection's SSE listener self-reports ITS cwd → distinct registry rows.
    await daemon.start();
    expect(created.map((s) => s.cwd)).toEqual(["/dev/repo-a", "/dev/repo-b"]);
    expect(created.every((s) => s.connected)).toBe(true);
    await daemon.stop();
    expect(created.every((s) => !s.connected)).toBe(true);
  });

  it("a wake delivered to the repo-b connection spawns in repo-b; the daemon process cwd is untouched", async () => {
    const spawnCalls = [];
    const procCwdBefore = process.cwd();
    const daemon = buildDaemon(
      { url: "https://c", apiKey: "cho_x" },
      {
        logger: silent,
        mcpClient: mockMcp(),
        fetchImpl: lineageFetch(),
        spawner: {
          wake: vi.fn(async (p) => {
            spawnCalls.push({ cwd: p.cwd, sessionId: p.sessionId });
            p.onMessage?.({ type: "system", session_id: p.sessionId });
            return { sessionId: p.sessionId, exitCode: 0, isNew: p.isNew };
          }),
        },
        cwds: ["/dev/repo-a", "/dev/repo-b"],
        makeSseListener: (o) => new MockSse(o),
      }
    );
    await daemon.start();
    // Drive a wake only on connection #2 (repo-b).
    daemon.connections[1].sseListener.deliver({ type: "new_notification", notificationUuid: "notif-1" });
    await new Promise((r) => setTimeout(r, 20));

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].cwd).toBe("/dev/repo-b"); // per-spawn cwd = the connection's cwd
    expect(spawnCalls[0].sessionId).toBe(DIRECT_IDEA);
    // NFR-3: the daemon's OWN process cwd never changed.
    expect(process.cwd()).toBe(procCwdBefore);
    await daemon.stop();
  });

  it("the same session's repeated wakes on a connection always land that connection's cwd", async () => {
    const spawnCwds = [];
    // Two DISTINCT notifications, both targeting task-1 → same DIRECT_IDEA session. The
    // realistic "repeated wakes on one session" path (a single notif uuid is deduped by
    // the router's `seen` set, which is correct — a session continues across wakes).
    const mcp = {
      async callTool(name) {
        return name === "chorus_get_notifications"
          ? { notifications: [TASK_NOTIF, { ...TASK_NOTIF, uuid: "notif-2" }] }
          : null;
      },
      async disconnect() {},
    };
    const daemon = buildDaemon(
      { url: "https://c", apiKey: "cho_x" },
      {
        logger: silent,
        mcpClient: mcp,
        fetchImpl: lineageFetch(),
        spawner: {
          wake: vi.fn(async (p) => {
            spawnCwds.push(p.cwd);
            return { sessionId: p.sessionId, exitCode: 0, isNew: p.isNew };
          }),
        },
        cwds: ["/dev/repo-a"],
        makeSseListener: (o) => new MockSse(o),
      }
    );
    await daemon.start();
    const conn = daemon.connections[0];
    conn.sseListener.deliver({ type: "new_notification", notificationUuid: "notif-1" });
    await new Promise((r) => setTimeout(r, 30));
    conn.sseListener.deliver({ type: "new_notification", notificationUuid: "notif-2" });
    await new Promise((r) => setTimeout(r, 30));
    // Both wakes for the same session landed the same (connection-bound) cwd.
    expect(spawnCwds).toEqual(["/dev/repo-a", "/dev/repo-a"]);
    await daemon.stop();
  });

  it("connections do not share a connectionUuid box (independent registration)", async () => {
    const daemon = buildDaemon(
      { url: "https://c", apiKey: "cho_x" },
      {
        logger: silent,
        mcpClient: mockMcp(),
        fetchImpl: lineageFetch(),
        spawner: { wake: vi.fn(async (p) => ({ sessionId: p.sessionId, exitCode: 0, isNew: p.isNew })) },
        cwds: ["/dev/repo-a", "/dev/repo-b"],
        makeSseListener: (o) => new MockSse(o),
      }
    );
    await daemon.start();
    daemon.connections[0].sseListener.deliver({ type: "connection_registered", connectionUuid: "conn-A" });
    daemon.connections[1].sseListener.deliver({ type: "connection_registered", connectionUuid: "conn-B" });
    expect(daemon.connections[0].connectionState.connectionUuid).toBe("conn-A");
    expect(daemon.connections[1].connectionState.connectionUuid).toBe("conn-B");
    await daemon.stop();
  });
});

// ===== AC#6 — HARD-1: old daemon / unspecified cwd =====
describe("AC#6 HARD-1: an unspecified cwd degrades to the process default", () => {
  it("a single-path daemon (no cwds) builds one connection whose cwd is undefined → self-reports process.cwd()", async () => {
    let captured;
    const daemon = buildDaemon(
      { url: "https://c", apiKey: "cho_x" },
      {
        logger: silent,
        mcpClient: mockMcp(),
        fetchImpl: lineageFetch(),
        spawner: { wake: vi.fn(async (p) => ({ sessionId: p.sessionId, exitCode: 0, isNew: p.isNew })) },
        // no `cwds` and no `cwd` → the default single connection
        makeSseListener: (o) => (captured = new MockSse(o)),
      }
    );
    expect(daemon.connections).toHaveLength(1);
    expect(daemon.connections[0].cwd).toBeUndefined(); // raw — unspecified
    // resolveCwd() and the self-reported cwd both degrade to the process cwd.
    expect(daemon.connections[0].waker.resolveCwd()).toBe(process.cwd());
    await daemon.start();
    expect(captured.cwd).toBe(process.cwd()); // SSE self-report = process cwd (HARD-1)
    await daemon.stop();
  });

  it("an old-daemon wake (undefined cwd) still spawns — at the process default cwd", async () => {
    const spawnCalls = [];
    let captured;
    const daemon = buildDaemon(
      { url: "https://c", apiKey: "cho_x" },
      {
        logger: silent,
        mcpClient: mockMcp(),
        fetchImpl: lineageFetch(),
        spawner: {
          wake: vi.fn(async (p) => {
            spawnCalls.push(p.cwd);
            p.onMessage?.({ type: "system", session_id: p.sessionId });
            return { sessionId: p.sessionId, exitCode: 0, isNew: p.isNew };
          }),
        },
        // explicitly model the OLD daemon: cwds = [undefined] (what resolveDaemonCwds
        // returns when nothing is declared).
        cwds: [undefined],
        makeSseListener: (o) => (captured = new MockSse(o)),
      }
    );
    await daemon.start();
    captured.deliver({ type: "new_notification", notificationUuid: "notif-1" });
    await new Promise((r) => setTimeout(r, 20));
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]).toBe(process.cwd()); // degraded to process default (HARD-1)
    await daemon.stop();
  });
});

// ===== AC#3/#4 — real on-disk transcript isolation per cwd =====
// Uses the REAL isNewSession/transcriptPath probe against a sandboxed CLAUDE_CONFIG_DIR.
// Proves: a session run in cwd-A creates its transcript under cwd-A's escaped projects
// dir, and the SAME session id probed in cwd-B is still "new" (the cwd-A transcript is
// invisible there) — i.e. resume is cwd-bound, so a cross-cwd route would `No conversation
// found`. This is exactly why resume must route back to the session's ORIGINAL cwd.
describe("AC#3/#4 real transcript isolation across cwds (resume is cwd-bound)", () => {
  let configDir;
  const SESSION = "11111111-1111-4111-8111-111111111111";

  afterEach(() => {
    if (configDir) rmSync(configDir, { recursive: true, force: true });
    configDir = undefined;
    delete process.env.CLAUDE_CONFIG_DIR;
  });

  it("a Waker bound to cwd-A creates its transcript under cwd-A only; cwd-B's probe stays 'new'", async () => {
    configDir = mkdtempSync(join(tmpdir(), "chorus-mp-cfg-"));
    process.env.CLAUDE_CONFIG_DIR = configDir;
    const cwdA = mkdtempSync(join(tmpdir(), "chorus-mp-a-"));
    const cwdB = mkdtempSync(join(tmpdir(), "chorus-mp-b-"));

    // A spawner that behaves like claude: writes the transcript at the REAL probed path
    // for the cwd it is told to spawn in.
    const spawner = {
      wake: vi.fn(async ({ sessionId, cwd, isNew }) => {
        const tpath = transcriptPath(sessionId, cwd, { env: process.env });
        mkdirSync(tpath.slice(0, tpath.lastIndexOf("/")), { recursive: true });
        writeFileSync(tpath, `{"type":"system","session_id":"${sessionId}"}\n`, { flag: "a" });
        return { sessionId, exitCode: 0, isNew };
      }),
    };

    // Waker bound to cwd-A (real probe + real spawn).
    const wakerA = new Waker({
      creds: { url: "u", apiKey: "k" },
      lineage: { resolve: async () => ({ rootIdeaUuid: SESSION, directIdeaUuid: SESSION }) },
      writeMcpConfigFn: () => ({ path: join(configDir, "mcp.json"), cleanup() {} }),
      spawner,
      cwd: cwdA,
      logger: silent,
    });

    const notif = { ...TASK_NOTIF, entityUuid: SESSION };
    await wakerA.wake(notif, `idea:${SESSION}`, { rootIdeaUuid: SESSION, directIdeaUuid: SESSION });

    // The transcript now exists under cwd-A's escaped dir, NOT cwd-B's.
    const pathA = transcriptPath(SESSION, cwdA, { env: process.env });
    const pathB = transcriptPath(SESSION, cwdB, { env: process.env });
    expect(existsSync(pathA)).toBe(true);
    expect(existsSync(pathB)).toBe(false);
    expect(pathA).not.toBe(pathB); // distinct escaped-cwd dirs → cwd-bound resume

    // A Waker bound to cwd-B probing the SAME session id sees "new" (transcript invisible
    // there) — proving a cross-cwd resume would start fresh / fail, hence resume MUST
    // route back to the original cwd (the server's originConnectionUuid pin).
    const wakerB = new Waker({ creds: {}, lineage: {}, spawner: {}, cwd: cwdB, logger: silent });
    expect(wakerB.isNewSessionFn(SESSION, wakerB.resolveCwd())).toBe(true);
    // While cwd-A correctly resumes (transcript present → not new).
    expect(wakerA.isNewSessionFn(SESSION, wakerA.resolveCwd())).toBe(false);

    rmSync(cwdA, { recursive: true, force: true });
    rmSync(cwdB, { recursive: true, force: true });
  });
});

// ===== Back-compat: deps.cwd single value still works (every existing test path) =====
describe("back-compat: deps.cwd (single value) maps to a one-element cwd set", () => {
  it("a daemon built with deps.cwd has one connection bound to that cwd, aliased onto daemon.waker", async () => {
    const daemon = buildDaemon(
      { url: "https://c", apiKey: "cho_x" },
      {
        logger: silent,
        mcpClient: mockMcp(),
        fetchImpl: lineageFetch(),
        spawner: { wake: vi.fn(async (p) => ({ sessionId: p.sessionId, exitCode: 0, isNew: p.isNew })) },
        cwd: "/legacy/single",
        makeSseListener: (o) => new MockSse(o),
      }
    );
    expect(daemon.connections).toHaveLength(1);
    expect(daemon.waker).toBe(daemon.connections[0].waker); // primary alias
    expect(daemon.waker.resolveCwd()).toBe("/legacy/single");
  });
});

// ===== add-daemon-connection-conflict-skip: warn + skip + all-conflict exit =====
describe("connection conflict — warn, skip, no-retry, all-conflict exit", () => {
  /** Build a daemon over the given cwd set, capturing each MockSse + logger warns + wake spy. */
  function buildWithConflict(cwds) {
    const warns = [];
    const wake = vi.fn(async (p) => ({ sessionId: p.sessionId, exitCode: 0, isNew: p.isNew }));
    const daemon = buildDaemon(
      { url: "https://c", apiKey: "cho_x" },
      {
        logger: { ...silent, warn: (m) => warns.push(m) },
        mcpClient: mockMcp(),
        fetchImpl: lineageFetch(),
        spawner: { wake },
        cwds,
        makeSseListener: (o) => new MockSse(o),
      }
    );
    return { daemon, warns, wake };
  }

  it("AC#1: on conflict the daemon warns (host+cwd), disconnects that listener, and never spawns", async () => {
    const { daemon, warns, wake } = buildWithConflict(["/dev/repo-a"]);
    const conn = daemon.connections[0];
    expect(conn.sseListener.connected).toBe(false);
    await daemon.start();
    expect(conn.sseListener.connected).toBe(true);

    conn.sseListener.deliver({ type: "connection_conflict", host: "mac.local", cwd: "/dev/repo-a" });

    // Warned with host + cwd, listener torn down (no reconnect), path marked skipped.
    expect(warns.join("")).toMatch(/conflict/i);
    expect(warns.join("")).toContain("mac.local");
    expect(warns.join("")).toContain("/dev/repo-a");
    expect(conn.sseListener.connected).toBe(false);
    expect(conn.outcome.skipped).toBe(true);
    // A conflict is never a wake — no subprocess spawned.
    expect(wake).not.toHaveBeenCalled();
  });

  it("AC#2: partial conflict — C1 conflicts (skipped) while C2 registers and still serves wakes", async () => {
    const { daemon, wake } = buildWithConflict(["/dev/repo-a", "/dev/repo-b"]);
    await daemon.start();
    const [c1, c2] = daemon.connections;

    c1.sseListener.deliver({ type: "connection_conflict", host: "h", cwd: "/dev/repo-a" });
    c2.sseListener.deliver({ type: "connection_registered", connectionUuid: "conn-B" });

    // C1 surrendered; C2 alive and owns its connection uuid.
    expect(c1.outcome.skipped).toBe(true);
    expect(c1.sseListener.connected).toBe(false);
    expect(c2.outcome.skipped).toBe(false);
    expect(c2.sseListener.connected).toBe(true);
    expect(c2.connectionState.connectionUuid).toBe("conn-B");

    // C2 still dispatches a wake (its serving path is undisturbed by C1's skip).
    c2.sseListener.deliver({ type: "new_notification", notificationUuid: "notif-1" });
    await new Promise((r) => setTimeout(r, 10));
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it("AC#2: a partial conflict does NOT settle allConflict (the daemon keeps running)", async () => {
    const { daemon } = buildWithConflict(["/dev/repo-a", "/dev/repo-b"]);
    await daemon.start();
    const [c1, c2] = daemon.connections;

    let settled = false;
    daemon.allConflict.then(() => { settled = true; });

    c1.sseListener.deliver({ type: "connection_conflict", host: "h", cwd: "/dev/repo-a" });
    c2.sseListener.deliver({ type: "connection_registered", connectionUuid: "conn-B" });
    await new Promise((r) => setTimeout(r, 10));

    // One conflicted, one registered → at least one path serves → must NOT settle.
    expect(settled).toBe(false);
  });

  it("AC#3: allConflict settles ONLY after EVERY path conflicts (not while one is mid-handshake)", async () => {
    const { daemon } = buildWithConflict(["/dev/repo-a", "/dev/repo-b"]);
    await daemon.start();
    const [c1, c2] = daemon.connections;

    let settled = false;
    daemon.allConflict.then(() => { settled = true; });

    // First path conflicts; second still handshaking → latch must NOT fire yet (R5).
    c1.sseListener.deliver({ type: "connection_conflict", host: "h", cwd: "/dev/repo-a" });
    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(false);

    // Second path also conflicts → now all resolved + none registered → settles.
    c2.sseListener.deliver({ type: "connection_conflict", host: "h", cwd: "/dev/repo-b" });
    await daemon.allConflict; // resolves, or the test times out if the latch is broken
    expect(settled).toBe(true);
  });

  it("a reconnect's repeated connection_registered does not double-count the latch", async () => {
    // Two paths: one registers (twice, simulating a reconnect), the other conflicts.
    // The repeated registration must not flip the bookkeeping into a premature/incorrect
    // all-conflict (it stays a partial → never settles).
    const { daemon } = buildWithConflict(["/dev/repo-a", "/dev/repo-b"]);
    await daemon.start();
    const [c1, c2] = daemon.connections;

    let settled = false;
    daemon.allConflict.then(() => { settled = true; });

    c1.sseListener.deliver({ type: "connection_registered", connectionUuid: "conn-A" });
    c1.sseListener.deliver({ type: "connection_registered", connectionUuid: "conn-A" }); // reconnect re-emit
    c2.sseListener.deliver({ type: "connection_conflict", host: "h", cwd: "/dev/repo-b" });
    await new Promise((r) => setTimeout(r, 10));

    // One real registration survives → never an all-conflict.
    expect(settled).toBe(false);
    expect(c1.outcome.skipped).toBe(false);
    expect(c2.outcome.skipped).toBe(true);
  });
});
