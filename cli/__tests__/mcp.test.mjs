// cli/__tests__/mcp.test.mjs
// Covers cli-mcp-client: runMcp output/exit semantics (call/whoami/list) with a
// fake client + fake creds resolver, plus a real `node chorus.mjs mcp` dispatch
// smoke test (routing + help without contacting a server).
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runMcp } from "../mcp.mjs";

const ENTRY = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), "chorus.mjs");

/** Capturing writable. */
function cap() {
  let s = "";
  return { write: (x) => { s += x; return true; }, get: () => s };
}

/** Fake ChorusClient recording calls. */
function fakeClient(over = {}) {
  const calls = { callToolRaw: [], listTools: 0, callTool: [], disconnect: 0 };
  return {
    calls,
    async callToolRaw(name, args) {
      calls.callToolRaw.push({ name, args });
      if (over.callThrows) throw over.callThrows;
      return over.callResult ?? { isError: false, text: "OK" };
    },
    async listTools() {
      calls.listTools++;
      if (over.listThrows) throw over.listThrows;
      return over.tools ?? [];
    },
    async callTool(name, args) {
      calls.callTool.push({ name, args });
      if (over.checkinThrows) throw over.checkinThrows;
      return over.checkin ?? { agent: { uuid: "a-1", name: "Bot" } };
    },
    async disconnect() { calls.disconnect++; },
  };
}

/** Standard opts wiring a fake client + fixed creds. */
function opts(over = {}, { creds = { url: "https://c", apiKey: "cho_k", label: "env" }, files = {}, stdin = "" } = {}) {
  const stdout = cap();
  const stderr = cap();
  const client = fakeClient(over);
  return {
    o: {
      version: "9.9.9",
      stdout,
      stderr,
      makeClient: () => client,
      readFile: (p) => { if (!(p in files)) throw new Error(`ENOENT ${p}`); return files[p]; },
      readStdin: () => stdin,
      resolveCreds: () => { if (creds instanceof Error) throw creds; return creds; },
    },
    stdout,
    stderr,
    client,
  };
}

describe("runMcp — call", () => {
  it("writes verbatim tool text (+trailing newline) to stdout and exits 0", async () => {
    const { o, stdout, stderr, client } = opts({ callResult: { isError: false, text: '{"uuid":"x"}' } });
    const code = await runMcp(["call", "chorus_get_task", '{"taskUuid":"t1"}'], o);
    expect(code).toBe(0);
    expect(stdout.get()).toBe('{"uuid":"x"}\n'); // matches chorus-api.sh jq -r trailing newline
    expect(stderr.get()).toBe("");
    expect(client.calls.callToolRaw[0]).toEqual({ name: "chorus_get_task", args: { taskUuid: "t1" } });
    expect(client.calls.disconnect).toBe(1);
  });

  it("assembles file-filled args and passes them to the tool", async () => {
    const { o, client } = opts({}, { files: { "./f.md": "BODY\n" } });
    await runMcp(["call", "chorus_pm_add_document_draft", "--arg", "type=prd", "--arg-file", "content=./f.md"], o);
    expect(client.calls.callToolRaw[0].args).toEqual({ type: "prd", content: "BODY\n" });
  });

  it("tool isError → error text to stderr, empty stdout, exit 1", async () => {
    const { o, stdout, stderr } = opts({ callResult: { isError: true, text: "Task not found" } });
    const code = await runMcp(["call", "t", "{}"], o);
    expect(code).toBe(1);
    expect(stdout.get()).toBe("");
    expect(stderr.get()).toBe("Task not found\n");
  });

  it("transport/auth throw → stderr diagnostic, exit 2, still disconnects", async () => {
    const { o, stdout, stderr, client } = opts({ callThrows: new Error("connect ECONNREFUSED") });
    const code = await runMcp(["call", "t", "{}"], o);
    expect(code).toBe(2);
    expect(stdout.get()).toBe("");
    expect(stderr.get()).toMatch(/error:.*ECONNREFUSED/);
    expect(client.calls.disconnect).toBe(1);
  });

  it("UsageError from arg assembly (both base sources) → stderr, exit 2, no tool call", async () => {
    const { o, stdout, stderr, client } = opts({}, { files: { "./a.json": "{}" } });
    const code = await runMcp(["call", "t", "{}", "--args-file", "./a.json"], o);
    expect(code).toBe(2);
    expect(stdout.get()).toBe("");
    expect(stderr.get()).toMatch(/error:/);
    expect(client.calls.callToolRaw.length).toBe(0);
  });
});

describe("runMcp — whoami / list", () => {
  it("whoami prints the bare UUID + newline, exit 0", async () => {
    const { o, stdout, stderr } = opts({ checkin: { agent: { uuid: "agent-123", name: "Bot" } } });
    const code = await runMcp(["whoami"], o);
    expect(code).toBe(0);
    expect(stdout.get()).toBe("agent-123\n");
    expect(stderr.get()).toBe(""); // env label → no "acting as" line
  });

  it("list prints one `name — description` line per tool (first line only)", async () => {
    const { o, stdout } = opts({
      tools: [
        { name: "chorus_get_task", description: "Get a task\nsecond line ignored" },
        { name: "chorus_add_comment", description: "" },
      ],
    });
    const code = await runMcp(["list"], o);
    expect(code).toBe(0);
    expect(stdout.get()).toBe("chorus_get_task — Get a task\nchorus_add_comment\n");
  });

  it("list surfaces the acting agent label on stderr when it is a named agent", async () => {
    const { o, stderr } = opts({ tools: [{ name: "t" }] }, { creds: { url: "u", apiKey: "k", label: "worker-a" } });
    await runMcp(["list"], o);
    expect(stderr.get()).toMatch(/acting as agent "worker-a"/);
  });
});

describe("runMcp — help & errors", () => {
  it("--help prints action help, exits 0, and never builds a client", async () => {
    let built = 0;
    const stdout = cap();
    const code = await runMcp(["--help"], { version: "9.9.9", stdout, stderr: cap(), makeClient: () => { built++; return fakeClient(); } });
    expect(code).toBe(0);
    expect(stdout.get()).toContain("chorus mcp call");
    expect(built).toBe(0);
  });

  it("unknown action → usage help on stderr, exit 2", async () => {
    const stderr = cap();
    const code = await runMcp(["frobnicate"], { version: "9.9.9", stdout: cap(), stderr });
    expect(code).toBe(2);
    expect(stderr.get()).toMatch(/Unknown action/);
  });

  it("credential resolution error → stderr, exit 2", async () => {
    const { o, stderr } = opts({}, { creds: new Error("Multiple agents are configured (a, b). Specify --agent") });
    const code = await runMcp(["whoami"], o);
    expect(code).toBe(2);
    expect(stderr.get()).toMatch(/Multiple agents/);
  });
});

/** Real dispatch: proves chorus.mjs routes `mcp` to runMcp without a server. */
function runEntry(args, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [ENTRY, ...args], {
      env: { ...process.env, CHORUS_URL: "", CHORUS_API_KEY: "", HOME: "/tmp/chorus-mcp-test-home", CHORUS_DAEMON_HEADLESS: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "", errOut = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (errOut += c));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, out, errOut }); });
  });
}

describe("chorus.mjs dispatch (real entry)", () => {
  it("`chorus mcp --help` prints the group help and exits 0 without a server", async () => {
    const { code, out } = await runEntry(["mcp", "--help"]);
    expect(code).toBe(0);
    expect(out).toContain("chorus mcp call");
    expect(out).toContain("chorus mcp whoami");
  });

  it("`chorus mcp bogus` exits non-zero with a usage error", async () => {
    const { code, errOut } = await runEntry(["mcp", "bogus"]);
    expect(code).not.toBe(0);
    expect(errOut).toMatch(/Unknown action/);
  });
});
