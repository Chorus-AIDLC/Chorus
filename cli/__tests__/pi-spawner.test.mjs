// cli/__tests__/pi-spawner.test.mjs
// Covers the pi-daemon-backend spec: headless `pi --mode json -p` wake (prompt on
// stdin), buildPiArgs (client-owned `--session-id` anchor, identical for new and
// resume — pi's `--session-id` is idempotent create-or-resume), cross-platform exec
// resolution (pi.cmd shim on Windows, CHORUS_PI_PATH override), daemon creds via env
// (never argv), event parse/forward, and never-throw-into-the-wake-path failure
// handling (missing binary / spawn throw / thrown onChild → exitCode null).
//
// Verified against the pi source (earendil-works/pi, packages/coding-agent):
//   • `pi --mode json -p` emits a JSONL event stream on stdout, prompt read from
//     piped stdin (src/main.ts readPipedStdin → initialMessage; src/modes/print-mode.ts).
//   • `--session-id <id>` creates the session if missing, resumes it if present
//     (src/main.ts createSessionManager); `--session <id>` is resume-only. So a wake
//     always passes `--session-id <anchor>` and pi owns new-vs-resume from disk.
//   • pi has NO permission system → no sandbox / skip-permissions flag is emitted.
import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import {
  PiSpawner,
  buildPiArgs,
  resolvePiPath,
  resolveSpawnCommand,
} from "../pi-spawner.mjs";

const ANCHOR = "11111111-1111-4111-8111-111111111111";

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

describe("buildPiArgs — client-owned session-id anchor (new === resume)", () => {
  it("builds `--mode json --session-id <anchor> -p`, prompt NOT in argv", () => {
    const args = buildPiArgs({ sessionId: ANCHOR });
    expect(args).toEqual(["--mode", "json", "--session-id", ANCHOR, "-p"]);
  });

  it("places -p LAST so pi's arg parser cannot slurp a following token as a message", () => {
    const args = buildPiArgs({ sessionId: ANCHOR });
    expect(args[args.length - 1]).toBe("-p");
  });

  it("emits NO permission / sandbox flag (pi has no permission system)", () => {
    const args = buildPiArgs({ sessionId: ANCHOR });
    expect(args).not.toContain("--dangerously-skip-permissions");
    expect(args).not.toContain("--sandbox");
    expect(args.join(" ")).not.toMatch(/permission|sandbox|approval/i);
  });

  it("never emits --no-session (that flag is for ephemeral subagent children only)", () => {
    expect(buildPiArgs({ sessionId: ANCHOR })).not.toContain("--no-session");
  });

  it("never contains the prompt (prompt is stdin-only)", () => {
    expect(buildPiArgs({ sessionId: ANCHOR }).join(" ")).not.toContain("PROMPT");
  });
});

describe("resolvePiPath", () => {
  const isFile = (set) => (p) => set.has(p);

  it("honors CHORUS_PI_PATH override when it is a file", () => {
    const env = { CHORUS_PI_PATH: "/opt/pi", PATH: "/usr/bin" };
    expect(resolvePiPath({ env, platform: "linux", isFile: isFile(new Set(["/opt/pi"])) })).toBe("/opt/pi");
  });

  it("ignores CHORUS_PI_PATH when it is not a file (falls back to PATH walk)", () => {
    const env = { CHORUS_PI_PATH: "/opt/missing", PATH: "/a:/b" };
    expect(resolvePiPath({ env, platform: "linux", isFile: isFile(new Set(["/b/pi"])) })).toBe("/b/pi");
  });

  it("walks PATH for `pi` on POSIX", () => {
    const env = { PATH: "/a:/b" };
    expect(resolvePiPath({ env, platform: "linux", isFile: isFile(new Set(["/b/pi"])) })).toBe("/b/pi");
  });

  it("prefers pi.cmd / pi.exe on Windows", () => {
    const env = { Path: "C:\\bin" };
    const got = resolvePiPath({ env, platform: "win32", isFile: isFile(new Set(["C:\\bin\\pi.cmd"])) });
    expect(got).toBe("C:\\bin\\pi.cmd");
  });

  it("returns null when nothing resolves", () => {
    expect(resolvePiPath({ env: { PATH: "/x" }, platform: "linux", isFile: () => false })).toBeNull();
  });
});

describe("resolveSpawnCommand", () => {
  it("runs a Windows .cmd shim through cmd.exe /d /s /c", () => {
    const { command, argv } = resolveSpawnCommand("C:\\bin\\pi.cmd", ["--mode", "json"], "win32", {
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
    });
    expect(command).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(argv).toEqual(["/d", "/s", "/c", "C:\\bin\\pi.cmd", "--mode", "json"]);
  });

  it("spawns a real POSIX binary directly", () => {
    const { command, argv } = resolveSpawnCommand("/usr/bin/pi", ["--mode", "json"], "linux");
    expect(command).toBe("/usr/bin/pi");
    expect(argv).toEqual(["--mode", "json"]);
  });
});

describe("PiSpawner.wake — spawn orchestration", () => {
  const creds = { url: "https://chorus.test", apiKey: "cho_secret" };

  /** Build a spawner whose spawnImpl returns our fake child + records the call. */
  function makeSpawner({ child, permissionMode = "chorus", piPath = "/usr/bin/pi", creds: credsOverride = creds } = {}) {
    const calls = {};
    const spawnImpl = vi.fn((command, argv, opts) => {
      calls.command = command;
      calls.argv = argv;
      calls.opts = opts;
      return child;
    });
    const spawner = new PiSpawner({
      piPath,
      spawnImpl,
      permissionMode,
      creds: credsOverride,
      platform: "linux",
      logger: { info() {}, warn() {}, error() {} },
    });
    return { spawner, spawnImpl, calls };
  }

  it("new wake: spawns pi with the resolved Chorus pair in env, never argv", async () => {
    const child = makeFakeChild();
    const { spawner, calls } = makeSpawner({ child });
    const onChild = vi.fn();
    // Ensure no ambient CHORUS_AGENT_PROFILE leaks through the inherited env for the
    // "no identity on creds → no profile exported" assertion below (this suite can run
    // inside a daemon-woken session that exports one). Saved/restored around the wake.
    const previousProfile = process.env.CHORUS_AGENT_PROFILE;
    delete process.env.CHORUS_AGENT_PROFILE;
    let result;
    try {
      const p = spawner.wake({ prompt: "do the thing", sessionId: ANCHOR, isNew: true, onChild });
      child.stdout.emit("data", JSON.stringify({ type: "message_end", message: { role: "assistant", content: [] } }) + "\n");
      child.emit("close", 0);
      result = await p;
    } finally {
      if (previousProfile === undefined) delete process.env.CHORUS_AGENT_PROFILE;
      else process.env.CHORUS_AGENT_PROFILE = previousProfile;
    }

    // args carry the client-owned anchor + json print mode; prompt only on stdin.
    expect(calls.argv).toEqual(["--mode", "json", "--session-id", ANCHOR, "-p"]);
    expect(child.stdin.writes.join("")).toBe("do the thing");
    expect(calls.argv.join(" ")).not.toContain("do the thing");
    // daemon connection pair exported via env, headless flag set, key absent from argv
    expect(calls.opts.env.CHORUS_URL).toBe("https://chorus.test");
    expect(calls.opts.env.CHORUS_API_KEY).toBe("cho_secret");
    expect(calls.opts.env.CHORUS_DAEMON_HEADLESS).toBe("1");
    // No identity on these creds → no profile exported (the extension falls back to url+key).
    expect(calls.opts.env.CHORUS_AGENT_PROFILE).toBeUndefined();
    expect(calls.argv.join(" ")).not.toContain("cho_secret");
    // detached process group on POSIX (for interrupt parity)
    expect(calls.opts.detached).toBe(true);
    // onChild fired exactly once with the live child
    expect(onChild).toHaveBeenCalledTimes(1);
    expect(onChild).toHaveBeenCalledWith(child);
    // resumable anchor returned as backendSessionId; exit code surfaced
    expect(result.exitCode).toBe(0);
    expect(result.sessionId).toBe(ANCHOR);
    expect(result.backendSessionId).toBe(ANCHOR);
  });

  it("resume wake: passes the SAME `--session-id <anchor>` args (pi resolves resume from disk)", async () => {
    const child = makeFakeChild();
    const { spawner, calls } = makeSpawner({ child });
    // isNew:false — but pi's --session-id is idempotent create-or-resume, so the
    // args must NOT switch to `--session` / `--resume` / `--no-session`.
    const p = spawner.wake({ prompt: "again", sessionId: ANCHOR, isNew: false });
    child.emit("close", 0);
    const result = await p;
    expect(calls.argv).toEqual(["--mode", "json", "--session-id", ANCHOR, "-p"]);
    expect(calls.argv).not.toContain("--session");
    expect(calls.argv).not.toContain("--resume");
    expect(result.backendSessionId).toBe(ANCHOR);
  });

  it("declares the shared transcript probe is NOT authoritative for pi", () => {
    const { spawner } = makeSpawner({ child: makeFakeChild() });
    expect(spawner.sessionDecision).toEqual({ probeIsAuthoritative: false });
  });

  it("passes cwd through verbatim (including non-ASCII / spaces)", async () => {
    const child = makeFakeChild();
    const { spawner, calls } = makeSpawner({ child });
    const cwd = "/workspaces/项目 alpha";
    const p = spawner.wake({ prompt: "x", sessionId: ANCHOR, cwd });
    child.emit("close", 0);
    await p;
    expect(calls.opts.cwd).toBe(cwd);
  });

  it("exports the agent identity as CHORUS_AGENT_PROFILE (uuid) when creds carry it", async () => {
    const child = makeFakeChild();
    const { spawner, calls } = makeSpawner({
      child,
      creds: { url: "https://chorus.test", apiKey: "cho_secret", agentUuid: "u-pi", agentName: "Pi" },
    });
    const p = spawner.wake({ prompt: "x", sessionId: ANCHOR, isNew: true });
    child.emit("close", 0);
    await p;
    expect(calls.opts.env.CHORUS_AGENT_PROFILE).toBe("u-pi");
    expect(calls.argv.join(" ")).not.toContain("u-pi");
  });

  it("overwrites stale inherited Chorus connection values", async () => {
    const child = makeFakeChild();
    const { spawner, calls } = makeSpawner({ child });
    const previousUrl = process.env.CHORUS_URL;
    const previousKey = process.env.CHORUS_API_KEY;
    process.env.CHORUS_URL = "https://stale.test";
    process.env.CHORUS_API_KEY = "cho_stale";
    try {
      const p = spawner.wake({ prompt: "x", sessionId: ANCHOR });
      child.emit("close", 0);
      await p;
      expect(calls.opts.env.CHORUS_URL).toBe("https://chorus.test");
      expect(calls.opts.env.CHORUS_API_KEY).toBe("cho_secret");
    } finally {
      if (previousUrl === undefined) delete process.env.CHORUS_URL;
      else process.env.CHORUS_URL = previousUrl;
      if (previousKey === undefined) delete process.env.CHORUS_API_KEY;
      else process.env.CHORUS_API_KEY = previousKey;
    }
  });

  it("forwards each parsed NDJSON event to onMessage (incl. message_end / tool_execution_end)", async () => {
    const child = makeFakeChild();
    const { spawner } = makeSpawner({ child });
    const onMessage = vi.fn();
    const p = spawner.wake({ prompt: "x", sessionId: ANCHOR, isNew: true, onMessage });
    child.stdout.emit("data", JSON.stringify({ type: "session", id: ANCHOR }) + "\n");
    child.stdout.emit(
      "data",
      JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } }) + "\n",
    );
    child.stdout.emit(
      "data",
      JSON.stringify({ type: "tool_execution_end", toolCallId: "t1", toolName: "read", result: {}, isError: false }) + "\n",
    );
    child.emit("close", 0);
    await p;
    expect(onMessage).toHaveBeenCalledTimes(3);
    expect(onMessage.mock.calls[1][0]).toMatchObject({ type: "message_end" });
    expect(onMessage.mock.calls[2][0]).toMatchObject({ type: "tool_execution_end" });
  });

  it("reassembles NDJSON events split across stdout chunks", async () => {
    const child = makeFakeChild();
    const { spawner } = makeSpawner({ child });
    const onMessage = vi.fn();
    const p = spawner.wake({ prompt: "x", sessionId: ANCHOR, onMessage });
    const line = JSON.stringify({ type: "message_end", message: { role: "assistant", content: [] } }) + "\n";
    child.stdout.emit("data", line.slice(0, 10));
    child.stdout.emit("data", line.slice(10));
    child.emit("close", 0);
    await p;
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage.mock.calls[0][0]).toMatchObject({ type: "message_end" });
  });

  it("never throws and returns exitCode:null when the pi executable is unresolved", async () => {
    const child = makeFakeChild();
    const { spawner, spawnImpl } = makeSpawner({ child, piPath: null });
    spawner.resolvePiPathFn = () => null;
    const result = await spawner.wake({ prompt: "x", sessionId: ANCHOR, isNew: true });
    expect(spawnImpl).not.toHaveBeenCalled();
    expect(result.exitCode).toBeNull();
    expect(result).toMatchObject({ sessionId: ANCHOR, backendSessionId: null, exitCode: null });
  });

  it("resolves pi lazily via resolvePiPathFn when no piPath was supplied", async () => {
    const child = makeFakeChild();
    const { spawner, calls } = makeSpawner({ child, piPath: null });
    spawner.resolvePiPathFn = () => "/found/pi";
    const p = spawner.wake({ prompt: "x", sessionId: ANCHOR });
    child.emit("close", 0);
    await p;
    expect(calls.command).toBe("/found/pi");
  });

  it("never throws when spawn itself throws (returns exitCode:null)", async () => {
    const spawner = new PiSpawner({
      piPath: "/usr/bin/pi",
      spawnImpl: () => {
        throw new Error("EACCES");
      },
      creds,
      platform: "linux",
      logger: { info() {}, warn() {}, error() {} },
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

  it("logs a non-zero exit but still resolves (no throw)", async () => {
    const child = makeFakeChild();
    const warn = vi.fn();
    const spawner = new PiSpawner({
      piPath: "/usr/bin/pi",
      spawnImpl: () => child,
      creds,
      platform: "linux",
      logger: { info() {}, warn, error() {} },
    });
    const p = spawner.wake({ prompt: "x", sessionId: ANCHOR });
    child.emit("close", 1);
    const result = await p;
    expect(result.exitCode).toBe(1);
    expect(warn).toHaveBeenCalled();
  });
});
