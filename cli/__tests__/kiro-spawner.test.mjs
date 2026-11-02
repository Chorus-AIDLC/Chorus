// cli/__tests__/kiro-spawner.test.mjs
// Covers daemon-kiro-backend spec: headless `kiro-cli chat --no-interactive` wake
// (prompt on stdin), buildArgs for new vs resume + trust flags + --agent chorus,
// post-run sessionId capture via a store-snapshot diff + persistence, daemon-key-
// via-env, cross-platform exec resolution, and never-throw-into-the-wake-path.
//
// Verified against kiro-cli 2.12.1: `chat --no-interactive` reads the prompt and
// emits plain text (no id-bearing stream); resume is `--resume-id <SESSION_ID>`;
// trust is `--trust-all-tools` / `--trust-tools=…`; MCP tools are namespaced
// `@chorus`.
import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { backendSessionKey } from "../backend-session-identity.mjs";
import { reconstructTranscript } from "../kiro-transcript.mjs";
import {
  KiroSpawner,
  buildKiroArgs,
  trustFlags,
  resolveKiroPath,
} from "../kiro-spawner.mjs";

const ANCHOR = "11111111-1111-4111-8111-111111111111";
const SID = "540019be-35ec-4740-8880-a6c83f172646";
const SID2 = "7db3039f-f915-4274-8508-6e17c4af1ccf";

/** A fake child process: stdin captures writes; stdout/stderr are emitters. */
function makeFakeChild() {
  const child = new EventEmitter();
  const stdinChunks = [];
  const stdin = new EventEmitter();
  stdin.writes = stdinChunks;
  stdin.write = (c) => stdinChunks.push(String(c));
  stdin.end = vi.fn();
  child.stdin = stdin;
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter();
  child.stderr.setEncoding = () => {};
  child.pid = 4242;
  return child;
}

describe("Kiro agent session isolation", () => {
  it.each(["orchestrator", "reviewer"])("rejects one foreign singleton during overlapping O/R wakes (%s closes first), including recreated spawners", async (firstToClose) => {
    const store = new Map();
    const sessions = new Map();
    const snapshotSessionsFn = vi.fn(() => new Map(store));
    const setSessionIdFn = vi.fn((key, value) => sessions.set(key, value));
    const read = vi.fn(() => { throw new Error("unowned native transcript read"); });
    const readdir = vi.fn(() => { throw new Error("unowned native store scan"); });
    const start = (agentUuid) => {
      const child = makeFakeChild();
      const spawnImpl = vi.fn(() => child);
      const onMessage = vi.fn();
      const reconstruct = vi.fn((params) => reconstructTranscript({ ...params, read, readdir }));
      const spawner = new KiroSpawner({
        kiroPath: "/fake/kiro-cli", spawnImpl, creds: { agentUuid }, env: { HOME: "/shared/home" },
        getSessionIdFn: (key) => sessions.get(key) ?? null, setSessionIdFn,
        snapshotSessionsFn, reconstructTranscript: reconstruct,
      });
      const pending = spawner.wake({ prompt: agentUuid, sessionId: ANCHOR, cwd: "/shared/repo", onMessage });
      child.stdout.emit("data", `${agentUuid} output`);
      return { child, spawnImpl, pending, onMessage, reconstruct };
    };
    const orchestrator = start("orchestrator");
    const reviewer = start("reviewer");
    expect(orchestrator.spawnImpl).toHaveBeenCalledTimes(1);
    expect(reviewer.spawnImpl).toHaveBeenCalledTimes(1);
    expect(store.size).toBe(0);
    store.set(SID, 1);
    const active = { orchestrator, reviewer };
    active[firstToClose].child.emit("close", 0);
    await active[firstToClose].pending;
    active[firstToClose === "orchestrator" ? "reviewer" : "orchestrator"].child.emit("close", 0);
    for (const [agentUuid, run] of Object.entries(active)) {
      expect(await run.pending).toMatchObject({ sessionId: ANCHOR, backendSessionId: null, isNew: true, exitCode: 0 });
      expect(run.reconstruct).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "", stdout: `${agentUuid} output` }));
      expect(JSON.stringify(run.onMessage.mock.calls)).toContain(`${agentUuid} output`);
      expect(JSON.stringify(run.onMessage.mock.calls)).not.toContain(`${agentUuid === "orchestrator" ? "reviewer" : "orchestrator"} output`);
      const recreated = start(agentUuid);
      recreated.child.emit("close", 0);
      expect(await recreated.pending).toMatchObject({ backendSessionId: null, isNew: true });
      expect(recreated.spawnImpl.mock.calls[0][1]).not.toContain("--resume-id");
      expect(recreated.reconstruct).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "" }));
    }
    expect([...store]).toEqual([[SID, 1]]);
    expect(sessions.size).toBe(0);
    expect(setSessionIdFn).not.toHaveBeenCalled();
    expect(snapshotSessionsFn).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(readdir).not.toHaveBeenCalled();
  });

  it.each([false, true])("preserves and visibly refuses unverified legacy mappings after recreation (scoped: %s)", async (scoped) => {
    const sessions = new Map(scoped
      ? ["orchestrator", "reviewer"].map((agentUuid) => [backendSessionKey(ANCHOR, agentUuid), SID])
      : [[ANCHOR, SID]]);
    const original = [...sessions];
    const setSessionIdFn = vi.fn();
    for (const agentUuid of ["orchestrator", "reviewer", "orchestrator", "reviewer"]) {
      const child = makeFakeChild();
      const spawnImpl = vi.fn(() => child);
      const logger = { info() {}, error() {}, warn: vi.fn() };
      const reconstruct = vi.fn();
      const spawner = new KiroSpawner({
        kiroPath: "/fake/kiro-cli", spawnImpl, creds: { agentUuid }, env: {}, logger,
        getSessionIdFn: (key) => sessions.get(key) ?? null, setSessionIdFn,
        reconstructTranscript: reconstruct,
      });
      const pending = spawner.wake({ prompt: "continue", sessionId: ANCHOR, cwd: "/shared/repo" });
      child.emit("close", 0);
      expect(await pending).toMatchObject({ backendSessionId: null, isNew: true });
      expect(spawnImpl.mock.calls[0][1]).not.toContain("--resume-id");
      expect(reconstruct).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "" }));
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(SID));
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("ownership"));
    }
    expect([...sessions]).toEqual(original);
    expect(setSessionIdFn).not.toHaveBeenCalled();
  });

  it("resumes and reconstructs only independently verified ownership across recreated spawners", async () => {
    const sessions = new Map([
      [backendSessionKey(ANCHOR, "orchestrator"), SID],
      [backendSessionKey(ANCHOR, "reviewer"), SID2],
      [backendSessionKey("other-idea", "reviewer"), SID2],
    ]);
    const verifySessionOwnershipFn = vi.fn(({ agentUuid, anchor, sessionId, cwd, dir }) =>
      anchor === ANCHOR && cwd === "/shared/repo" && dir === "/shared/home/.kiro/sessions/cli" &&
      ((agentUuid === "orchestrator" && sessionId === SID) || (agentUuid === "reviewer" && sessionId === SID2)));
    for (const [agentUuid, anchor, cwd, expected] of [
      ["orchestrator", ANCHOR, "/shared/repo", SID],
      ["reviewer", ANCHOR, "/shared/repo", SID2],
      ["orchestrator", ANCHOR, "/shared/repo", SID],
      ["reviewer", ANCHOR, "/shared/repo", SID2],
      ["reviewer", "other-idea", "/shared/repo", null],
      ["reviewer", ANCHOR, "/other/repo", null],
    ]) {
      const child = makeFakeChild();
      const spawnImpl = vi.fn(() => child);
      const reconstruct = vi.fn();
      const spawner = new KiroSpawner({
        kiroPath: "/fake/kiro-cli", spawnImpl, creds: { agentUuid }, env: { HOME: "/shared/home" }, platform: "linux",
        getSessionIdFn: (key) => sessions.get(key) ?? null, verifySessionOwnershipFn,
        reconstructTranscript: reconstruct,
      });
      const pending = spawner.wake({ prompt: "continue", sessionId: anchor, cwd, isNew: true });
      child.emit("close", 0);
      expect(await pending).toMatchObject({ backendSessionId: expected, isNew: !expected });
      expect(verifySessionOwnershipFn).toHaveBeenLastCalledWith({
        agentUuid, anchor, sessionKey: backendSessionKey(anchor, agentUuid),
        sessionId: sessions.get(backendSessionKey(anchor, agentUuid)), cwd, dir: "/shared/home/.kiro/sessions/cli",
      });
      const argv = spawnImpl.mock.calls[0][1];
      if (expected) expect(argv[argv.indexOf("--resume-id") + 1]).toBe(expected);
      else expect(argv).not.toContain("--resume-id");
      expect(reconstruct).toHaveBeenCalledWith(expect.objectContaining({ sessionId: expected ?? "" }));
    }
  });

  it.each([{ ids: [] }, { ids: [SID] }, { ids: [SID, SID2] }])("does not report the business anchor as native identity without ownership: $ids", async ({ ids }) => {
    const child = makeFakeChild();
    const setSessionIdFn = vi.fn();
    const spawner = new KiroSpawner({
      kiroPath: "/fake/kiro-cli", spawnImpl: () => child, creds: { agentUuid: "agent-one" },
      getSessionIdFn: () => null, setSessionIdFn, reconstructTranscript: null,
      snapshotSessionsFn: vi.fn().mockReturnValueOnce(new Map()).mockReturnValue(new Map(ids.map((id) => [id, 1]))),
    });
    const pending = spawner.wake({ prompt: "hello", sessionId: ANCHOR });
    child.emit("close", 0);
    expect(await pending).toMatchObject({ sessionId: ANCHOR, backendSessionId: null, exitCode: 0 });
    expect(setSessionIdFn).not.toHaveBeenCalled();
  });

  it.each(["throws", "truthy", "promise", "missing-agent"])("fails closed when ownership verification is invalid: %s", async (mode) => {
    const child = makeFakeChild();
    const spawnImpl = vi.fn(() => child);
    const reconstruct = vi.fn();
    const verifySessionOwnershipFn = vi.fn(() => {
      if (mode === "throws") throw new Error("proof unavailable");
      if (mode === "truthy") return "true";
      if (mode === "promise") return Promise.resolve(true);
      return true;
    });
    const logger = { info() {}, error() {}, warn: vi.fn() };
    const spawner = new KiroSpawner({
      kiroPath: "/fake/kiro-cli", spawnImpl, creds: mode === "missing-agent" ? {} : { agentUuid: "reviewer" },
      env: {}, logger, getSessionIdFn: () => SID, verifySessionOwnershipFn,
      reconstructTranscript: reconstruct,
    });
    const pending = spawner.wake({ prompt: "continue", sessionId: ANCHOR, cwd: "/shared/repo" });
    child.stdout.emit("data", "own output");
    child.emit("close", 0);
    expect(await pending).toMatchObject({ backendSessionId: null, isNew: true, exitCode: 0 });
    expect(spawnImpl.mock.calls[0][1]).not.toContain("--resume-id");
    expect(reconstruct).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "", stdout: "own output" }));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("unverified ownership"));
    if (mode === "missing-agent") expect(verifySessionOwnershipFn).not.toHaveBeenCalled();
  });
});

describe("trustFlags — permission mode mapping", () => {
  it("yolo → --trust-all-tools", () => {
    expect(trustFlags("yolo")).toEqual(["--trust-all-tools"]);
  });
  it("chorus → scoped --trust-tools=fs_read,@chorus (read-only fs + Chorus MCP)", () => {
    expect(trustFlags("chorus")).toEqual(["--trust-tools=fs_read,@chorus"]);
  });
  it("defaults unknown/undefined to the restricted scoped set", () => {
    expect(trustFlags(undefined)).toEqual(["--trust-tools=fs_read,@chorus"]);
  });
});

describe("buildKiroArgs — new vs resume", () => {
  it("new run: chat --no-interactive --agent chorus + trust, no resume, no prompt in argv, no --v3", () => {
    const args = buildKiroArgs({ isNew: true, permissionMode: "yolo" });
    expect(args).toEqual(["chat", "--no-interactive", "--agent", "chorus", "--trust-all-tools"]);
    expect(args).not.toContain("--resume-id");
    expect(args).not.toContain("--v3");
  });

  it("resume run (yolo): + --resume-id <sessionId>", () => {
    const args = buildKiroArgs({ isNew: false, sessionId: SID, permissionMode: "yolo" });
    expect(args).toEqual([
      "chat",
      "--no-interactive",
      "--resume-id",
      SID,
      "--agent",
      "chorus",
      "--trust-all-tools",
    ]);
  });

  it("chorus mode carries the scoped trust set on both new and resume", () => {
    expect(buildKiroArgs({ isNew: true, permissionMode: "chorus" })).toContain("--trust-tools=fs_read,@chorus");
    expect(buildKiroArgs({ isNew: false, sessionId: SID, permissionMode: "chorus" })).toContain(
      "--trust-tools=fs_read,@chorus"
    );
  });

  it("never contains the prompt (prompt is stdin-only)", () => {
    const args = buildKiroArgs({ isNew: true, permissionMode: "yolo" });
    expect(args.join(" ")).not.toContain("PROMPT");
  });
});

describe("resolveKiroPath", () => {
  const isFile = (set) => (p) => set.has(p);

  it("honors CHORUS_KIRO_PATH override when it is a file", () => {
    const env = { CHORUS_KIRO_PATH: "/opt/kiro-cli", PATH: "/usr/bin" };
    expect(resolveKiroPath({ env, platform: "linux", isFile: isFile(new Set(["/opt/kiro-cli"])) })).toBe(
      "/opt/kiro-cli"
    );
  });

  it("walks PATH for `kiro-cli` on POSIX", () => {
    const env = { PATH: "/a:/b" };
    expect(resolveKiroPath({ env, platform: "linux", isFile: isFile(new Set(["/b/kiro-cli"])) })).toBe("/b/kiro-cli");
  });

  it("prefers kiro-cli.cmd / kiro-cli.exe on Windows", () => {
    const env = { Path: "C:\\bin" };
    const got = resolveKiroPath({ env, platform: "win32", isFile: isFile(new Set(["C:\\bin\\kiro-cli.cmd"])) });
    expect(got).toBe("C:\\bin\\kiro-cli.cmd");
  });

  it("returns null when nothing resolves", () => {
    expect(resolveKiroPath({ env: { PATH: "/x" }, platform: "linux", isFile: () => false })).toBeNull();
  });
});

describe("KiroSpawner.wake — spawn orchestration", () => {
  const creds = { url: "https://chorus.test", apiKey: "cho_secret", agentUuid: "test-agent" };

  /** Build a spawner whose spawnImpl returns our fake child + records the call. */
  function makeSpawner({
    child,
    permissionMode = "yolo",
    getSessionId,
    verifySessionOwnershipFn,
    setSessionId,
    snapshots,
    kiroPath = "/usr/bin/kiro-cli",
  } = {}) {
    const calls = {};
    const spawnImpl = vi.fn((command, argv, opts) => {
      calls.command = command;
      calls.argv = argv;
      calls.opts = opts;
      return child;
    });
    // snapshots: an array of Map results returned in order on each snapshot call
    // (before-run, after-run). Defaults to empty→empty (no id captured).
    const snaps = snapshots ?? [new Map(), new Map()];
    let snapIdx = 0;
    const snapshotSessionsFn = vi.fn(() => snaps[Math.min(snapIdx++, snaps.length - 1)]);
    const spawner = new KiroSpawner({
      kiroPath,
      spawnImpl,
      permissionMode,
      creds,
      platform: "linux",
      logger: { info() {}, warn() {}, error() {} },
      getSessionIdFn: getSessionId ?? (() => null),
      verifySessionOwnershipFn,
      setSessionIdFn: setSessionId ?? (() => {}),
      snapshotSessionsFn,
      // Isolate spawn-orchestration tests from the real ~/.kiro store; the tests
      // that exercise transcript feeding override this with their own hook.
      reconstructTranscript: null,
    });
    return { spawner, spawnImpl, calls };
  }

  it("new wake: spawns Kiro with the resolved Chorus pair in env, never argv", async () => {
    const child = makeFakeChild();
    const { spawner, calls } = makeSpawner({
      child,
      // before: empty; after: one new session id
      snapshots: [new Map(), new Map([[SID, 200]])],
    });
    const onChild = vi.fn();
    const p = spawner.wake({ prompt: "do the thing", sessionId: ANCHOR, isNew: true, onChild });
    child.stdout.emit("data", "some plain text output\n");
    child.emit("close", 0);
    const result = await p;

    expect(calls.argv.slice(0, 4)).toEqual(["chat", "--no-interactive", "--agent", "chorus"]);
    expect(calls.argv).not.toContain("--resume-id");
    // prompt only on stdin, never argv
    expect(child.stdin.writes.join("")).toBe("do the thing");
    expect(calls.argv.join(" ")).not.toContain("do the thing");
    expect(calls.opts.env.CHORUS_URL).toBe("https://chorus.test");
    expect(calls.opts.env.CHORUS_API_KEY).toBe("cho_secret");
    expect(calls.opts.env.CHORUS_DAEMON_HEADLESS).toBe("1");
    expect(calls.argv.join(" ")).not.toContain("cho_secret");
    // detached process group on POSIX (for interrupt parity)
    expect(calls.opts.detached).toBe(true);
    // onChild fired exactly once with the live child
    expect(onChild).toHaveBeenCalledTimes(1);
    expect(onChild).toHaveBeenCalledWith(child);
    expect(result.exitCode).toBe(0);
    expect(result.sessionId).toBe(ANCHOR);
    expect(result.backendSessionId).toBeNull();
  });

  it("does not persist a singleton store delta even on a successful new run", async () => {
    const child = makeFakeChild();
    const setSessionId = vi.fn();
    const { spawner } = makeSpawner({
      child,
      setSessionId,
      snapshots: [new Map(), new Map([[SID, 200]])],
    });
    const p = spawner.wake({ prompt: "x", sessionId: ANCHOR, isNew: true });
    child.emit("close", 0);
    await p;
    expect(setSessionId).not.toHaveBeenCalled();
  });

  it("does NOT persist on a non-zero exit (failed run)", async () => {
    const child = makeFakeChild();
    const setSessionId = vi.fn();
    const { spawner } = makeSpawner({
      child,
      setSessionId,
      snapshots: [new Map(), new Map([[SID, 200]])],
    });
    const p = spawner.wake({ prompt: "x", sessionId: ANCHOR, isNew: true });
    child.emit("close", 1);
    await p;
    expect(setSessionId).not.toHaveBeenCalled();
  });

  it.each([
    "/workspaces/项目 alpha",
    "/workspaces/space only",
  ])("resume wake: independently verified ownership ignores the shared new-session probe under cwd %s", async (cwd) => {
    const child = makeFakeChild();
    const setSessionId = vi.fn();
    const { spawner, calls } = makeSpawner({
      child, getSessionId: () => SID, setSessionId,
      verifySessionOwnershipFn: (context) => context.agentUuid === creds.agentUuid && context.anchor === ANCHOR && context.sessionId === SID && context.cwd === cwd,
    });
    // pass isNew:true (the shared Claude probe missed) but the map has a session
    // id → Kiro must resume independently and pass the cwd through verbatim.
    const p = spawner.wake({ prompt: "again", sessionId: ANCHOR, isNew: true, cwd });
    child.emit("close", 0);
    const result = await p;
    expect(spawner.sessionDecision).toEqual({ probeIsAuthoritative: false });
    expect(calls.argv).toContain("--resume-id");
    expect(calls.argv[calls.argv.indexOf("--resume-id") + 1]).toBe(SID);
    expect(calls.opts.cwd).toBe(cwd);
    // resume returns the known id; does NOT re-persist (not a new run)
    expect(result.sessionId).toBe(SID);
    expect(result.isNew).toBe(false);
    expect(setSessionId).not.toHaveBeenCalled();
  });

  it("feeds reconstructed transcript entries to onMessage via the injected hook (post-run)", async () => {
    const child = makeFakeChild();
    const onMessage = vi.fn();
    const { spawner } = makeSpawner({
      child,
      snapshots: [new Map(), new Map([[SID, 200]])],
    });
    // Inject a transcript reconstructor (task 4's seam): it pushes two entries.
    spawner.reconstructTranscript = ({ sessionId, onMessage: om }) => {
      om?.({ type: "user", message: { role: "user", content: [{ type: "text", text: "hi" }] } });
      om?.({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: sessionId }] } });
    };
    const p = spawner.wake({ prompt: "x", sessionId: ANCHOR, isNew: true, onMessage });
    child.emit("close", 0);
    await p;
    expect(onMessage).toHaveBeenCalledTimes(2);
  });

  it("never throws and returns exitCode:null when the kiro-cli executable is unresolved", async () => {
    const child = makeFakeChild();
    const { spawner, spawnImpl } = makeSpawner({ child, kiroPath: null });
    spawner.resolveKiroPathFn = () => null;
    const result = await spawner.wake({ prompt: "x", sessionId: ANCHOR, isNew: true });
    expect(spawnImpl).not.toHaveBeenCalled();
    expect(result.exitCode).toBeNull();
  });

  it("never throws when spawn itself throws (returns exitCode:null)", async () => {
    const spawner = new KiroSpawner({
      kiroPath: "/usr/bin/kiro-cli",
      spawnImpl: () => {
        throw new Error("EACCES");
      },
      permissionMode: "yolo",
      creds,
      platform: "linux",
      logger: { info() {}, warn() {}, error() {} },
      getSessionIdFn: () => null,
      setSessionIdFn: () => {},
      snapshotSessionsFn: () => new Map(),
    });
    const result = await spawner.wake({ prompt: "x", sessionId: ANCHOR, isNew: true });
    expect(result.exitCode).toBeNull();
  });

  it("tolerates a thrown onChild without escaping the wake path", async () => {
    const child = makeFakeChild();
    const { spawner } = makeSpawner({ child });
    const p = spawner.wake({
      prompt: "x",
      sessionId: ANCHOR,
      isNew: true,
      onChild: () => {
        throw new Error("boom");
      },
    });
    child.emit("close", 0);
    const result = await p;
    expect(result.exitCode).toBe(0);
  });
});
