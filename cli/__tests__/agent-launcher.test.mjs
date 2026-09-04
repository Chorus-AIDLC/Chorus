// cli/__tests__/agent-launcher.test.mjs
// Covers `chorus agents run` (cli/agent-launcher.mjs + resolveLaunchAgent in
// cli/credentials.mjs): argv split at `--`, agent selection, --type override,
// type→binary map, PATH resolution, childEnv injection, exit-code/signal
// forwarding, and the secret-never-printed guarantee. Pure unit tests — spawn,
// env, daemon.json read, and file-probe are all injected (no real subprocess,
// disk, or env).
import { describe, it, expect } from "vitest";
import {
  parseRunArgs,
  resolveBinaryName,
  resolveBinaryPath,
  resolveSpawnCommand,
  buildChildEnv,
  runAgentLaunch,
  TYPE_TO_BINARY,
} from "../agent-launcher.mjs";
import { resolveLaunchAgent } from "../credentials.mjs";

const LOGIN_PATH = "/home/u/.chorus/daemon.json";
const SECRET = "cho_SUPERSECRET_KEY_should_never_print";

function cap() {
  const out = [];
  const err = [];
  return {
    stdout: { write: (s) => out.push(String(s)) },
    stderr: { write: (s) => err.push(String(s)) },
    text: () => out.join(""),
    errText: () => err.join(""),
    all: () => out.join("") + err.join(""),
  };
}

/** A fake spawn that records calls and drives the child's close/error async. */
function makeSpawn(behavior = {}) {
  const calls = [];
  const spawn = (command, argv, options) => {
    calls.push({ command, argv, options });
    if (behavior.throwErr) throw behavior.throwErr;
    const handlers = {};
    const child = {
      on: (ev, cb) => {
        handlers[ev] = cb;
        return child;
      },
    };
    queueMicrotask(() => {
      if (behavior.emitError) handlers.error?.(behavior.emitError);
      else handlers.close?.(behavior.code ?? 0, behavior.signal ?? null);
    });
    return child;
  };
  return { spawn, calls };
}

const AGENT = {
  agentUuid: "11111111-2222-3333-4444-555555555555",
  agentName: "work",
  agentType: "claude-code",
  url: "https://chorus.example.com",
  apiKey: SECRET,
};

/** Build opts for runAgentLaunch with a fake daemon.json + spawn + found binary. */
function opts({ agents = [AGENT], env = {}, spawnBehavior = {}, isFile = () => true } = {}) {
  const io = cap();
  const { spawn, calls } = makeSpawn(spawnBehavior);
  return {
    io,
    calls,
    o: {
      stdout: io.stdout,
      stderr: io.stderr,
      env: { PATH: "/usr/bin", ...env },
      platform: "linux",
      loginPath: LOGIN_PATH,
      readJson: () => ({ agents }),
      spawnImpl: spawn,
      isFile,
      cwd: "/work",
    },
  };
}

describe("parseRunArgs", () => {
  it("splits chorus flags from verbatim passthrough at `--`", () => {
    const p = parseRunArgs(["--name", "work", "--type", "codex", "--", "--model", "opus", "--name", "x"]);
    expect(p.name).toBe("work");
    expect(p.type).toBe("codex");
    expect(p.passthrough).toEqual(["--model", "opus", "--name", "x"]);
    expect(p.help).toBe(false);
  });

  it("supports --name= / --type= and --agent alias", () => {
    const p = parseRunArgs(["--agent=work", "--type=pi"]);
    expect(p.name).toBe("work");
    expect(p.type).toBe("pi");
  });

  it("treats the first unknown token as start of passthrough (no `--` needed)", () => {
    const p = parseRunArgs(["--name", "work", "chat", "--foo"]);
    expect(p.name).toBe("work");
    expect(p.passthrough).toEqual(["chat", "--foo"]);
  });

  it("launches bare when no `--` and no trailing args", () => {
    const p = parseRunArgs(["--name", "work"]);
    expect(p.passthrough).toEqual([]);
  });

  it("errors when a flag is missing its value", () => {
    expect(parseRunArgs(["--name"]).error).toMatch(/--name needs a value/);
    expect(parseRunArgs(["--type"]).error).toMatch(/--type needs a value/);
  });

  it("recognizes --help / -h", () => {
    expect(parseRunArgs(["--help"]).help).toBe(true);
    expect(parseRunArgs(["-h"]).help).toBe(true);
  });
});

describe("resolveBinaryName", () => {
  it("maps every known type to its binary", () => {
    expect(resolveBinaryName(undefined, "claude-code")).toEqual({ type: "claude-code", binary: "claude" });
    expect(resolveBinaryName("claude", undefined)).toEqual({ type: "claude", binary: "claude" });
    expect(resolveBinaryName(undefined, "codex")).toEqual({ type: "codex", binary: "codex" });
    expect(resolveBinaryName(undefined, "kiro")).toEqual({ type: "kiro", binary: "kiro-cli" });
    expect(resolveBinaryName(undefined, "pi")).toEqual({ type: "pi", binary: "pi" });
    expect(resolveBinaryName(undefined, "opencode")).toEqual({ type: "opencode", binary: "opencode" });
    expect(resolveBinaryName(undefined, "openclaw")).toEqual({ type: "openclaw", binary: "openclaw" });
    expect(resolveBinaryName(undefined, "dsh")).toEqual({ type: "dsh", binary: "dsh-jsonrpc-agent" });
  });

  it("prefers explicit --type over the stored agentType", () => {
    expect(resolveBinaryName("codex", "claude-code")).toEqual({ type: "codex", binary: "codex" });
  });

  it("errors for an `offline` classification with no explicit type", () => {
    const r = resolveBinaryName(undefined, "offline");
    expect(r.error).toMatch(/offline/);
    expect(r.error).toMatch(/--type/);
  });

  it("errors for an unknown type and when no type is available", () => {
    expect(resolveBinaryName("banana", undefined).error).toMatch(/unknown agent type/);
    expect(resolveBinaryName(undefined, undefined).error).toMatch(/no agent type given/);
  });

  it("TYPE_TO_BINARY has no `offline` key", () => {
    expect(TYPE_TO_BINARY.offline).toBeUndefined();
  });
});

describe("resolveBinaryPath", () => {
  it("walks PATH and returns the first existing candidate (POSIX)", () => {
    const seen = [];
    const p = resolveBinaryPath("claude", {
      env: { PATH: "/a:/b" },
      platform: "linux",
      isFile: (c) => {
        seen.push(c);
        return c === "/b/claude";
      },
    });
    expect(p).toBe("/b/claude");
    expect(seen).toEqual(["/a/claude", "/b/claude"]);
  });

  it("tries .cmd/.exe on Windows", () => {
    const p = resolveBinaryPath("claude", {
      env: { PATH: "C:\\bin" },
      platform: "win32",
      isFile: (c) => c === "C:\\bin\\claude.cmd",
    });
    expect(p).toBe("C:\\bin\\claude.cmd");
  });

  it("returns null when not found", () => {
    expect(resolveBinaryPath("nope", { env: { PATH: "/a" }, platform: "linux", isFile: () => false })).toBeNull();
  });
});

describe("resolveSpawnCommand", () => {
  it("passes a POSIX binary through directly", () => {
    expect(resolveSpawnCommand("/usr/bin/claude", ["--x"], "linux")).toEqual({
      command: "/usr/bin/claude",
      argv: ["--x"],
    });
  });

  it("wraps a Windows .cmd shim in cmd.exe", () => {
    const r = resolveSpawnCommand("C:\\bin\\claude.cmd", ["--x"], "win32", { ComSpec: "cmd.exe" });
    expect(r.command).toBe("cmd.exe");
    expect(r.argv).toEqual(["/d", "/s", "/c", "C:\\bin\\claude.cmd", "--x"]);
  });
});

describe("buildChildEnv", () => {
  it("injects the 3 CHORUS_* vars and clears CHORUS_DAEMON_HEADLESS", () => {
    const env = buildChildEnv(AGENT, { PATH: "/usr/bin", CHORUS_DAEMON_HEADLESS: "1", KEEP: "yes" });
    expect(env.CHORUS_URL).toBe(AGENT.url);
    expect(env.CHORUS_API_KEY).toBe(SECRET);
    expect(env.CHORUS_AGENT_PROFILE).toBe(AGENT.agentUuid);
    expect(env.CHORUS_DAEMON_HEADLESS).toBeUndefined();
    expect(env.KEEP).toBe("yes"); // inherited env preserved
  });

  it("falls back to agentName for the profile when no uuid", () => {
    const env = buildChildEnv({ agentName: "solo", url: "u", apiKey: "k" }, {});
    expect(env.CHORUS_AGENT_PROFILE).toBe("solo");
  });
});

describe("resolveLaunchAgent (selection)", () => {
  const two = [AGENT, { agentUuid: "aaaa", agentName: "other", agentType: "codex", url: "u2", apiKey: "cho_two" }];
  const call = (flags, agents, env = {}) =>
    resolveLaunchAgent(flags, { env, loginPath: LOGIN_PATH, readJson: () => ({ agents }) });

  it("defaults to the single configured agent", () => {
    expect(call({}, [AGENT]).agentType).toBe("claude-code");
  });

  it("selects by name and by uuid", () => {
    expect(call({ name: "other" }, two).agentName).toBe("other");
    expect(call({ name: "11111111-2222-3333-4444-555555555555" }, two).agentName).toBe("work");
  });

  it("honors CHORUS_AGENT_PROFILE", () => {
    expect(call({}, two, { CHORUS_AGENT_PROFILE: "other" }).agentType).toBe("codex");
  });

  it("errors on ambiguity", () => {
    const dup = [AGENT, { ...AGENT, agentUuid: "bbbb" }]; // both agentName "work"
    expect(() => call({ name: "work" }, dup)).toThrow(/ambiguous/);
  });

  it("errors when multiple agents and none specified", () => {
    expect(() => call({}, two)).toThrow(/Multiple agents/);
  });

  it("errors when no agents are configured", () => {
    expect(() => call({}, [])).toThrow(/No agents are configured/);
  });

  it("preserves agentType, url, apiKey, uuid", () => {
    const a = call({ name: "work" }, two);
    expect(a).toMatchObject({ agentType: "claude-code", url: AGENT.url, apiKey: SECRET, agentUuid: AGENT.agentUuid });
  });
});

describe("runAgentLaunch", () => {
  it("launches the resolved binary in the foreground with verbatim passthrough", async () => {
    const { calls, o } = opts();
    const code = await runAgentLaunch(["--name", "work", "--", "--model", "opus", "--resume", "abc"], o);
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe("/usr/bin/claude");
    expect(calls[0].argv).toEqual(["--model", "opus", "--resume", "abc"]);
    expect(calls[0].options.stdio).toBe("inherit");
    expect(calls[0].options.shell).toBe(false);
    expect(calls[0].options.cwd).toBe("/work");
  });

  it("injects the 3 CHORUS_* vars into the child env", async () => {
    const { calls, o } = opts({ env: { CHORUS_DAEMON_HEADLESS: "1" } });
    await runAgentLaunch(["--name", "work"], o);
    const cenv = calls[0].options.env;
    expect(cenv.CHORUS_URL).toBe(AGENT.url);
    expect(cenv.CHORUS_API_KEY).toBe(SECRET);
    expect(cenv.CHORUS_AGENT_PROFILE).toBe(AGENT.agentUuid);
    expect(cenv.CHORUS_DAEMON_HEADLESS).toBeUndefined();
  });

  it("--type overrides the stored agentType", async () => {
    const { calls, o } = opts();
    await runAgentLaunch(["--name", "work", "--type", "codex"], o);
    expect(calls[0].command).toBe("/usr/bin/codex");
  });

  it("forwards the child exit code", async () => {
    const { o } = opts({ spawnBehavior: { code: 3 } });
    expect(await runAgentLaunch(["--name", "work"], o)).toBe(3);
  });

  it("maps signal death to 128 + signum (SIGINT → 130)", async () => {
    const { o } = opts({ spawnBehavior: { code: null, signal: "SIGINT" } });
    expect(await runAgentLaunch(["--name", "work"], o)).toBe(130);
  });

  it("errors (no spawn) when the agent is offline and no --type is given", async () => {
    const offline = [{ agentUuid: "x", agentName: "oc", agentType: "offline", url: "u", apiKey: "cho_x" }];
    const { io, calls, o } = opts({ agents: offline });
    const code = await runAgentLaunch(["--name", "oc"], o);
    expect(code).toBe(1);
    expect(calls).toHaveLength(0);
    expect(io.errText()).toMatch(/offline/);
  });

  it("launches an offline-stored agent when --type is given explicitly", async () => {
    const offline = [{ agentUuid: "x", agentName: "oc", agentType: "offline", url: "u", apiKey: "cho_x" }];
    const { calls, o } = opts({ agents: offline });
    const code = await runAgentLaunch(["--name", "oc", "--type", "opencode"], o);
    expect(code).toBe(0);
    expect(calls[0].command).toBe("/usr/bin/opencode");
  });

  it("errors (no spawn) when the binary is not on PATH", async () => {
    const { io, calls, o } = opts({ isFile: () => false });
    const code = await runAgentLaunch(["--name", "work"], o);
    expect(code).toBe(1);
    expect(calls).toHaveLength(0);
    expect(io.errText()).toMatch(/claude/);
  });

  it("errors on ambiguous selection without spawning", async () => {
    const dup = [AGENT, { ...AGENT, agentUuid: "bbbb" }];
    const { calls, o } = opts({ agents: dup });
    expect(await runAgentLaunch(["--name", "work"], o)).toBe(1);
    expect(calls).toHaveLength(0);
  });

  it("returns 2 and prints help on a usage error", async () => {
    const { io, o } = opts();
    expect(await runAgentLaunch(["--name"], o)).toBe(2);
    expect(io.errText()).toMatch(/needs a value/);
  });

  it("prints help and exits 0 for --help", async () => {
    const { io, calls, o } = opts();
    expect(await runAgentLaunch(["--help"], o)).toBe(0);
    expect(io.text()).toMatch(/USAGE/);
    expect(calls).toHaveLength(0);
  });

  it("NEVER prints the API key on any path", async () => {
    // success path
    let t = opts();
    await runAgentLaunch(["--name", "work", "--", "--model", "opus"], t.o);
    expect(t.io.all()).not.toContain(SECRET);
    // missing-binary error path
    t = opts({ isFile: () => false });
    await runAgentLaunch(["--name", "work"], t.o);
    expect(t.io.all()).not.toContain(SECRET);
    // offline error path
    t = opts({ agents: [{ agentUuid: "x", agentName: "oc", agentType: "offline", url: "u", apiKey: SECRET }] });
    await runAgentLaunch(["--name", "oc"], t.o);
    expect(t.io.all()).not.toContain(SECRET);
  });
});
