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
import {
  KiroSpawner,
  buildKiroArgs,
  trustFlags,
  resolveKiroPath,
  pickNewSessionId,
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

describe("pickNewSessionId — UNAMBIGUOUS post-run capture (reviewer N1 hardening)", () => {
  it("returns the id when EXACTLY ONE brand-new id appeared", () => {
    const before = new Map([[SID, 100]]);
    const after = new Map([
      [SID, 100],
      [SID2, 200],
    ]);
    expect(pickNewSessionId(before, after)).toBe(SID2);
  });

  it("returns null when SEVERAL new ids appear (concurrent same-cwd wake → refuse to guess)", () => {
    // Two fresh runs raced in the same cwd; we must NOT mis-attribute one to the other.
    const before = new Map();
    const after = new Map([
      [SID, 100],
      [SID2, 300],
    ]);
    expect(pickNewSessionId(before, after)).toBeNull();
  });

  it("returns null when NO new id appeared (only an existing id's updated_at moved)", () => {
    // No "updated_at advanced" fallback — a fresh run always creates a new id.
    const before = new Map([[SID, 100]]);
    const after = new Map([[SID, 250]]);
    expect(pickNewSessionId(before, after)).toBeNull();
  });

  it("returns null when nothing changed", () => {
    const before = new Map([[SID, 100]]);
    const after = new Map([[SID, 100]]);
    expect(pickNewSessionId(before, after)).toBeNull();
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
  const creds = { url: "https://chorus.test", apiKey: "cho_secret" };

  /** Build a spawner whose spawnImpl returns our fake child + records the call. */
  function makeSpawner({
    child,
    permissionMode = "yolo",
    getSessionId,
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
    // returns the captured session id (from the store diff) as the session id
    expect(result.exitCode).toBe(0);
    expect(result.sessionId).toBe(SID);
  });

  it("captures the new sessionId from the store diff and persists anchor→sessionId on a successful new run", async () => {
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
    expect(setSessionId).toHaveBeenCalledWith(ANCHOR, SID);
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

  it("resume wake: a known anchor produces `--resume-id <sessionId>` (ignores passed isNew)", async () => {
    const child = makeFakeChild();
    const setSessionId = vi.fn();
    const { spawner, calls } = makeSpawner({ child, getSessionId: () => SID, setSessionId });
    // pass isNew:true but the map has a session id → spawner must resume
    const p = spawner.wake({ prompt: "again", sessionId: ANCHOR, isNew: true });
    child.emit("close", 0);
    const result = await p;
    expect(calls.argv).toContain("--resume-id");
    expect(calls.argv[calls.argv.indexOf("--resume-id") + 1]).toBe(SID);
    // resume returns the known id; does NOT re-persist (not a new run)
    expect(result.sessionId).toBe(SID);
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
