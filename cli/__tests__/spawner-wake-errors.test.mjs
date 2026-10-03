import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { ClaudeSpawner } from "../claude-spawner.mjs";
import { CodexSpawner } from "../codex-spawner.mjs";
import { PiSpawner } from "../pi-spawner.mjs";
import { KiroSpawner } from "../kiro-spawner.mjs";
import { DshSpawner } from "../dsh-spawner.mjs";
import { appServerChild } from "./fixtures/codex-app-server-child.mjs";

const ANCHOR = "11111111-1111-4111-8111-111111111111";
const DSH_ID = "chorus-11111111111141118111111111111111";
const QUIET = { info() {}, warn() {}, error() {} };
const CLASSES = { claude: ClaudeSpawner, codex: CodexSpawner, pi: PiSpawner, kiro: KiroSpawner, dsh: DshSpawner };
const SOURCES = Object.keys(CLASSES);
const REDACTION_FIXTURE = JSON.parse(readFileSync(
  new URL("./fixtures/wake-errors/recoverable-credentials.json", import.meta.url), "utf8",
));

function plainChild(source) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  child.send = (frame) => child.stdout.emit("data", JSON.stringify(frame) + "\n");
  child.exit = (code, signal = null) => {
    child.exitCode = code;
    child.signalCode = signal;
    child.emit("exit", code, signal);
    child.emit("close", code, signal);
  };
  child.stdin.write = vi.fn((line) => {
    if (source !== "dsh") return true;
    const request = JSON.parse(line);
    queueMicrotask(() => {
      const result = request.method === "initialize"
        ? { serverInfo: { name: "deepseek-harness-sdk-runtime" } }
        : request.method === "session/prompt" ? { messageId: "receipt" } : {};
      child.send({ jsonrpc: "2.0", id: request.id, result });
      if (request.method === "session/prompt") child.send({
        jsonrpc: "2.0", method: "session.event", params: {
          sessionId: DSH_ID, event: { type: "agent/inbox/spliced", data: { inserted: [{ id: "receipt" }] } },
        },
      });
    });
    return true;
  });
  child.stdin.end = vi.fn(() => {
    if (source !== "kiro") queueMicrotask(() => child.exit(0));
  });
  return child;
}

function makeSpawner(source, opts = {}) {
  return new CLASSES[source]({
    [`${source}Path`]: `/fake/${source}`,
    logger: QUIET, env: { CHORUS_DSH_HOME: "/fake/home" }, platform: "linux",
    creds: { apiKey: "authoritative-daemon-key" },
    versionProbeFn: async () => "0.85.1", readdirImpl: () => [],
    getSessionIdFn: () => null, setSessionIdFn: vi.fn(), snapshotSessionsFn: () => new Map(),
    reconstructTranscript: null,
    getThreadIdFn: () => null, setThreadIdFn: vi.fn(),
    getUsageSnapshotFn: () => null, setUsageSnapshotFn: vi.fn(), hasChorusMcpServerFn: () => true,
    uuidFn: () => ANCHOR, shutdownTimeoutMs: 30, timeoutMs: 200,
    cleanupTimeoutMs: 30, stdioGraceMs: 5,
    rpcLimits: { initializeTimeoutMs: 100, threadSetupTimeoutMs: 100, turnStartTimeoutMs: 100 },
    ...opts,
  });
}
const wake = (spawner, extra = {}) => spawner.wake({ prompt: "go", sessionId: ANCHOR, isNew: true, ...extra });

describe.each(["claude", "kiro", "dsh", "pi"])("%s early-exit diagnostics", (source) => {
  it.each(["short", "large"])("keeps the real stderr reason for a %s prompt and immediate process exit", async (size) => {
    const result = await wake(makeSpawner(source, {
      spawnImpl: (_command, _args, options) => spawn(process.execPath, ["-e", [
        'require("node:fs").closeSync(0);',
        'process.stderr.write("Error: Invalid API key (status 1)\\n");',
        "process.exit(1);",
      ].join("\n")], { ...options, detached: false }),
      shutdownTimeoutMs: 2000,
    }), { prompt: size === "large" ? "x".repeat(200_000) : "go" });
    expect(result.wakeError).toMatchObject({
      source, kind: "execution", message: "Error: Invalid API key (status 1)", exitCode: 1,
    });
  });

  it.each(["stdin-first", "stderr-first"])("prefers the backend error in %s event order", async (order) => {
    const child = plainChild(source);
    child.stdin.write = vi.fn(() => true);
    child.stdin.end = vi.fn();
    const spawner = makeSpawner(source, { spawnImpl: () => {
      queueMicrotask(() => {
        const stderr = () => child.stderr.emit("data", "Error: Invalid API key (status 1)\n");
        if (order === "stderr-first") stderr();
        child.stdin.emit("error", Object.assign(new Error("broken pipe"), { code: "EPIPE" }));
        if (order === "stdin-first") stderr();
        child.exit(1);
      });
      return child;
    } });
    const result = await wake(spawner);
    expect(result.wakeError).toMatchObject({
      source, kind: "execution", message: "Error: Invalid API key (status 1)", exitCode: 1,
    });
    expect(result.wakeError.details).toContain("stdin closed");
  });

  it("retains a delivery failure if stderr is empty", async () => {
    const child = plainChild(source);
    child.stdin.write = vi.fn(() => true);
    child.stdin.end = vi.fn();
    const result = await wake(makeSpawner(source, { spawnImpl: () => {
      queueMicrotask(() => {
        child.stdin.emit("error", new Error("broken pipe"));
        child.exit(1);
      });
      return child;
    } }));
    expect(result.wakeError).toMatchObject({ source, kind: "protocol", exitCode: 1 });
    expect(result.wakeError.message).toContain("stdin closed");
  });
});

async function begin(source, opts = {}) {
  const child = source === "codex" ? appServerChild({ autoComplete: false }) : plainChild(source);
  let spawned;
  const ready = new Promise((resolve) => { spawned = resolve; });
  const spawner = makeSpawner(source, { spawnImpl: () => child, ...opts });
  const running = wake(spawner, { onChild: spawned });
  await ready;
  if (source === "codex") {
    await vi.waitFor(() => expect(child.requests.some((r) => r.method === "turn/start")).toBe(true), { interval: 1 });
  } else if (source === "pi") {
    child.send({ type: "response", id: "chorus-state-1", success: true, data: { messageCount: 0 } });
    child.send({ type: "response", id: "chorus-prompt-1", success: true });
    child.send({ type: "agent_start" });
  } else if (source === "dsh") {
    await vi.waitFor(() => expect(child.stdin.write.mock.calls.some(([line]) => JSON.parse(line).method === "session/prompt")).toBe(true), { interval: 1 });
  }
  return { child, running };
}

describe("terminal reasons survive pipe errors", () => {
  it("prefers a later authoritative Claude result to an early stdin error", async () => {
    const { child, running } = await begin("claude");
    child.stdin.emit("error", new Error("broken pipe"));
    child.stderr.emit("data", "provider warning\n");
    child.send({ type: "result", is_error: true, subtype: "error_during_execution",
      errors: ["Provider rejected the API key"] });
    child.exit(0);
    const result = await running;
    expect(result.wakeError).toMatchObject({
      kind: "execution", message: "Provider rejected the API key", exitCode: 0,
    });
  });

  it("does not replace a Pi rejection with a later stdin error", async () => {
    const { child, running } = await begin("pi");
    child.send({ type: "response", id: "chorus-prompt-1", success: false,
      error: "Provider rejected the API key" });
    child.stdin.emit("error", new Error("broken pipe"));
    const result = await running;
    expect(result.wakeError.message).toBe("Provider rejected the API key");
    expect(result.wakeError.exitCode).toBe(0);
  });
});

function complete(source, child) {
  if (source === "codex") child.terminal();
  else if (source === "pi") child.send({ type: "agent_settled" });
  else if (source === "dsh") child.send({ jsonrpc: "2.0", method: "session.status",
    params: { sessionId: DSH_ID, status: "idle" } });
  else if (source === "claude") child.send({ type: "result", subtype: "success", is_error: false });
  else child.exit(0);
}

describe.each(SOURCES)("%s wake error contract", (source) => {
  it("exposes backend source metadata before any child or wake exists", () => {
    const spawnImpl = vi.fn();
    expect(makeSpawner(source, { spawnImpl }).wakeErrorSource).toBe(source);
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it.each(REDACTION_FIXTURE.stderr)("redacts $name in the actual returned diagnostic", async (fixture) => {
    const { child, running } = await begin(source, { env: {
      CHORUS_DSH_HOME: "/fake/home", [fixture.envKey]: fixture.secret,
    } });
    const split = fixture.output.indexOf("word") >= 0 ? fixture.output.indexOf("word")
      : fixture.output.indexOf("%2B") + 1;
    child.stderr.emit("data", fixture.output.slice(0, split));
    child.stderr.emit("data", fixture.output.slice(split));
    child.exit(1);
    const { wakeError } = await running;
    expect(wakeError).toMatchObject({ source, exitCode: 1 });
    expect(wakeError.details).toContain(fixture.expected);
    for (const form of [fixture.secret, JSON.stringify(fixture.secret).slice(1, -1),
      encodeURIComponent(fixture.secret)]) {
      expect(wakeError.message).not.toContain(form);
      expect(wakeError.details).not.toContain(form);
    }
    expect(wakeError.message.length).toBeLessThanOrEqual(500);
    expect(wakeError.details.length).toBeLessThanOrEqual(8000);
  });

  it("returns a startup diagnostic without invoking onChild when the binary is missing", async () => {
    const onChild = vi.fn();
    const spawnImpl = vi.fn();
    const spawner = makeSpawner(source, {
      [`${source}Path`]: null, env: { PATH: "" },
      [`resolve${source[0].toUpperCase() + source.slice(1)}PathFn`]: () => null,
      spawnImpl,
    });
    const result = await wake(spawner, { onChild });
    expect(result.exitCode).toBeNull();
    expect(result.wakeError).toMatchObject({ source, kind: "startup", exitCode: null });
    expect(result.wakeError.message).toMatch(/locate|EXECUTABLE_MISSING/);
    expect(onChild).not.toHaveBeenCalled();
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it("returns a nonthrowing actionable diagnostic when spawn throws", async () => {
    const onChild = vi.fn();
    const result = await wake(makeSpawner(source, { spawnImpl: () => {
      throw Object.assign(new Error("authoritative-daemon-key"), { code: "EACCES" });
    } }), { onChild });
    expect(result.wakeError).toMatchObject({ source, kind: "startup", exitCode: null });
    expect(result.wakeError.message).toContain("permission denied");
    expect(JSON.stringify(result.wakeError)).not.toContain("authoritative-daemon-key");
    expect(onChild).not.toHaveBeenCalled();
  });

  it("returns a startup diagnostic on an asynchronous process error", async () => {
    const { child, running } = await begin(source);
    child.emit("error", Object.assign(new Error("authoritative-daemon-key"), { code: "ENOENT" }));
    child.exit(1);
    const result = await running;
    expect(result.exitCode).not.toBe(0);
    expect(result.wakeError).toMatchObject({ source, kind: "startup" });
    expect(result.wakeError.message).toContain("not found");
  });

  it("fails prompt/protocol delivery even if closing stdin yields raw exit zero", async () => {
    const child = source === "codex" ? appServerChild() : plainChild(source);
    child.stdin.write = vi.fn(() => { throw new Error("stdin write rejected"); });
    if (source === "kiro") child.stdin.end = () => queueMicrotask(() => child.exit(0));
    const result = await wake(makeSpawner(source, { spawnImpl: () => child }));
    expect(result.exitCode).not.toBe(0);
    expect(result.wakeError).toMatchObject({ source, kind: "protocol", exitCode: 0 });
    expect(result.wakeError.message.trim()).not.toBe("");
  });

  it("diagnoses a silent nonzero exit with raw exit metadata", async () => {
    const { child, running } = await begin(source);
    child.exit(17);
    const result = await running;
    expect(result.exitCode).not.toBe(0);
    expect(result.wakeError).toMatchObject({ source, exitCode: 17, signal: null });
    expect(result.wakeError.message.trim()).not.toBe("");
  });

  it("preserves a termination signal when there is no error text", async () => {
    const { child, running } = await begin(source);
    if (source === "codex") {
      child.signalCode = "SIGTERM";
      // The shared App Server fixture exposes numeric exit only.
      child.emit("exit", null, "SIGTERM");
      child.emit("close", null, "SIGTERM");
    } else child.exit(null, "SIGTERM");
    const result = await running;
    expect(result.exitCode).not.toBe(0);
    expect(result.wakeError).toMatchObject({ source, exitCode: null, signal: "SIGTERM" });
  });

  it("omits wakeError on success despite warning stderr and nonterminal tool failures", async () => {
    const { child, running } = await begin(source);
    child.stderr.emit("data", "warning: optional integration unavailable\n");
    if (source === "claude") child.send({ type: "user", message: { content: [{ type: "tool_result", is_error: true }] } });
    if (source === "pi") {
      child.send({ type: "tool_execution_end", isError: true });
      child.send({ type: "extension_error", event: "tool_call", error: "ignored" });
    }
    complete(source, child);
    const result = await running;
    expect(result.exitCode).toBe(0);
    expect(result).not.toHaveProperty("wakeError");
  });

  it("bounds and sanitizes long stderr, including a credential split between chunks", async () => {
    const { child, running } = await begin(source, { env: {
      CHORUS_DSH_HOME: "/fake/home", CHORUS_CALLBACK_API_KEY: "callback-key-value",
    } });
    child.stderr.emit("data", "x".repeat(200_000));
    child.stderr.emit("data", "\n\u001b[31mdenied authoritative-");
    child.stderr.emit("data", "daemon-key callback-key-value Bearer opaque-token\u0000\u001b[0m\n");
    child.exit(2);
    const { wakeError } = await running;
    expect(wakeError.message.length).toBeLessThanOrEqual(500);
    expect(wakeError.details.length).toBeLessThanOrEqual(8000);
    expect(wakeError.details).toContain("denied");
    for (const value of ["authoritative-daemon-key", "callback-key-value", "opaque-token", "\u001b", "\u0000"]) {
      expect(JSON.stringify(wakeError)).not.toContain(value);
    }
  });
});

describe("authoritative structured failures", () => {
  it.each(["literal", "JSON", "URL", "multiple entries", "result fallback"])(
    "Claude redacts %s array credentials before the 8000-character extraction boundary", async (representation) => {
      const { secret, envKey, paddingLength } = REDACTION_FIXTURE.structured;
      const key = representation === "JSON" ? `${secret}/"\\`
        : representation === "URL" ? `${secret}/+` : secret;
      const form = representation === "JSON" ? JSON.stringify(key).slice(1, -1)
        : representation === "URL" ? encodeURIComponent(key) : key;
      const errors = representation === "multiple entries"
        ? ["x".repeat(paddingLength - 1), form] : ["x".repeat(paddingLength) + form];
      const { child, running } = await begin("claude", { env: { [envKey]: key } });
      child.send({ type: "result", is_error: true,
        ...(representation === "result fallback" ? { result: errors } : { errors }) });
      const result = await running;
      expect(result).toMatchObject({ exitCode: 1,
        wakeError: { kind: "execution", source: "claude", exitCode: 0, signal: null } });
      expect(result.wakeError.details).toContain("[redacted]");
      expect(result.wakeError.details).not.toContain("callback-");
      expect(result.wakeError.details.length).toBeLessThanOrEqual(8000);
      expect(result.wakeError.message.length).toBeLessThanOrEqual(500);
    },
  );

  it.each([["claude"], ["codex"], ["pi"]])("%s fails on a terminal error with raw exit zero", async (source) => {
    const { child, running } = await begin(source);
    child.stderr.emit("data", "warning: this must not replace the terminal reason");
    if (source === "claude") child.send({ type: "result", subtype: "error_during_execution",
      is_error: true, errors: ["Provider authentication failed"] });
    if (source === "codex") child.send({ method: "turn/completed", params: { threadId: "thread-1",
      turn: { id: "turn-1", status: "failed", items: [], error: { message: "Provider authentication failed" } } } });
    if (source === "pi") {
      // Shape from the live abort-running-tool fixture, terminal at agent_settled.
      child.send({ type: "message_end", message: { role: "assistant",
        stopReason: "error", errorMessage: "Provider authentication failed" } });
      child.send({ type: "agent_end", willRetry: false });
      child.send({ type: "agent_settled" });
    }
    const result = await running;
    expect(result.exitCode).not.toBe(0);
    expect(result.wakeError).toMatchObject({
      source, kind: "execution", message: "Provider authentication failed", exitCode: 0,
    });
    expect(result.wakeError.details).toContain("warning:");
  });

  it.each(["claude", "codex", "pi"])("%s provides a reason when a terminal failure has no text", async (source) => {
    const { child, running } = await begin(source);
    if (source === "claude") child.send({ type: "result", is_error: true, errors: [] });
    if (source === "codex") child.terminal("failed");
    if (source === "pi") {
      child.send({ type: "message_end", message: { role: "assistant", stopReason: "error" } });
      child.send({ type: "agent_settled" });
    }
    const result = await running;
    expect(result.exitCode).not.toBe(0);
    expect(result.wakeError.message).toMatch(/failed|error/);
    expect(result.wakeError.exitCode).toBe(0);
  });

  it("Pi clears an intermediate assistant error after a successful retry", async () => {
    const { child, running } = await begin("pi");
    child.send({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "retryable" } });
    child.send({ type: "agent_end", willRetry: true });
    child.send({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
    child.send({ type: "agent_end", willRetry: false });
    child.send({ type: "agent_settled" });
    expect(await running).not.toHaveProperty("wakeError");
  });

  it("Pi exposes the rejected-prompt fixture's reason with raw exit zero", async () => {
    const fixture = JSON.parse(readFileSync(new URL("./fixtures/pi-rpc/rejected-prompt.json", import.meta.url), "utf8"));
    const child = plainChild("pi");
    let spawned;
    const ready = new Promise((resolve) => { spawned = resolve; });
    const running = wake(makeSpawner("pi", { spawnImpl: () => child }), { onChild: spawned });
    await ready;
    for (const frame of fixture.frames) child.send(frame);
    const result = await running;
    expect(result.exitCode).toBe(1);
    expect(result.wakeError).toMatchObject({ source: "pi", kind: "protocol", exitCode: 0,
      message: "No API key found for amazon-bedrock." });
  });

  it("Codex ignores an unrelated terminal error and retains only the matching outcome", async () => {
    const { child, running } = await begin("codex");
    child.send({ method: "turn/completed", params: { threadId: "other-thread",
      turn: { id: "turn-1", status: "failed", error: { message: "wrong thread" } } } });
    child.send({ method: "turn/completed", params: { threadId: "thread-1",
      turn: { id: "other-turn", status: "failed", error: { message: "wrong turn" } } } });
    child.terminal();
    expect(await running).not.toHaveProperty("wakeError");
  });

  it("DSH RPC rejection remains a protocol failure despite clean shutdown", async () => {
    const child = plainChild("dsh");
    child.stdin.write = vi.fn((line) => {
      const { id } = JSON.parse(line);
      queueMicrotask(() => child.send({ jsonrpc: "2.0", id, error: {
        code: -32603, message: "Provider authentication failed",
      } }));
    });
    const result = await wake(makeSpawner("dsh", { spawnImpl: () => child }));
    expect(result.exitCode).not.toBe(0);
    expect(result.wakeError).toMatchObject({ kind: "protocol", exitCode: 0,
      message: "dsh JSON-RPC error -32603: Provider authentication failed" });
  });

  it("DSH managed setup rejects without a child and with classified safe text", async () => {
    const onChild = vi.fn();
    const result = await wake(makeSpawner("dsh", {
      env: {}, prepareManagedConfigFn: () => { throw new Error("authentication failed: authoritative-daemon-key"); },
    }), { onChild });
    expect(result.wakeError).toMatchObject({ kind: "startup", source: "dsh" });
    expect(result.wakeError.message).toContain("authentication failed");
    expect(JSON.stringify(result.wakeError)).not.toContain("authoritative-daemon-key");
    expect(onChild).not.toHaveBeenCalled();
  });

  it("Pi rejects an unsupported version without launching the runtime", async () => {
    const spawnImpl = vi.fn();
    const result = await wake(makeSpawner("pi", { spawnImpl, versionProbeFn: async () => "0.84.0" }));
    expect(result.wakeError).toMatchObject({ source: "pi", kind: "startup", exitCode: null });
    expect(result.wakeError.message).toContain("Upgrade:");
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it("Kiro retains its resume decision when startup configuration is rejected", async () => {
    const spawnImpl = vi.fn();
    const result = await wake(makeSpawner("kiro", {
      kiroPath: "C:\\bin\\kiro.cmd", platform: "win32", spawnImpl,
      getSessionIdFn: () => "existing-kiro-session",
      cliConfig: { args: ["--custom=%UNSAFE%"] },
    }));
    expect(result).toMatchObject({ sessionId: ANCHOR, isNew: false, exitCode: null,
      wakeError: { source: "kiro", kind: "startup" } });
    expect(spawnImpl).not.toHaveBeenCalled();
  });
});
