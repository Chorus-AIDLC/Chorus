import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { ClaudeSpawner, SESSION_CONFLICT_FAILURE } from "../claude-spawner.mjs";
import { Waker } from "../waker.mjs";

const SESSION = "11111111-1111-4111-8111-111111111111";
const TASK = "22222222-2222-4222-8222-222222222222";
const TERMINATION = "Background tasks still running after 600s; terminating.";
const NATIVE = "CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS";
const OVERRIDE = "CHORUS_CLAUDE_BG_WAIT_CEILING_MS";

function childProcess() {
  const child = new EventEmitter();
  child.stdin = Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn() });
  child.stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
  child.stderr = Object.assign(new EventEmitter(), { setEncoding() {} });
  return child;
}

function spawnerFixture(options = {}) {
  const child = childProcess();
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const spawnImpl = vi.fn(() => child);
  const spawner = new ClaudeSpawner({ claudePath: "/claude", env: {}, logger, spawnImpl, ...options });
  return { child, logger, spawnImpl, spawner };
}

const params = { sessionId: SESSION, isNew: true, prompt: "work", mcpConfigPath: "/mcp.json" };

describe("Claude background wait environment", () => {
  it.each([
    [{}, "3600000"],
    [{ [OVERRIDE]: "1800000" }, "1800000"],
    [{ [OVERRIDE]: " 00042 " }, "42"],
    [{ [OVERRIDE]: "0" }, "0"],
    [{ [NATIVE]: "0", [OVERRIDE]: "123" }, "0"],
    [{ [NATIVE]: " 123 ", [OVERRIDE]: "456" }, " 123 "],
    [{ [NATIVE]: "" }, ""],
    ...["", " ", "-1", "1.2", "NaN", "Infinity", "1e6", "0x10", "9007199254740992"].map((value) => [{ [OVERRIDE]: value }, "3600000"]),
  ])("resolves %j to %s without changing its input", async (env, expected) => {
    const original = { ...env };
    const fixture = spawnerFixture({ env });
    const pending = fixture.spawner.wake(params);
    fixture.child.emit("close", 0);
    await pending;
    expect(fixture.spawnImpl.mock.calls[0][2].env[NATIVE]).toBe(expected);
    expect(env).toEqual(original);
    expect(fixture.spawner.env).toEqual(original);
  });

  it("honors Windows native casing and configured overlays", async () => {
    const fixture = spawnerFixture({
      platform: "win32", env: { [NATIVE]: "99", PATH: "keep", chorus_claude_bg_wait_ceiling_ms: "123" },
      cliConfig: { env: { claude_code_print_bg_wait_ceiling_ms: "0" } },
    });
    const pending = fixture.spawner.wake(params);
    fixture.child.emit("close", 0);
    await pending;
    const env = fixture.spawnImpl.mock.calls[0][2].env;
    expect(env.claude_code_print_bg_wait_ceiling_ms).toBe("0");
    expect(env[NATIVE]).toBeUndefined();
    expect(env.PATH).toBe("keep");
  });

  it("honors Windows Chorus override casing", async () => {
    const fixture = spawnerFixture({ platform: "win32", env: { chorus_claude_bg_wait_ceiling_ms: "42" } });
    const pending = fixture.spawner.wake(params);
    fixture.child.emit("close", 0);
    await pending;
    expect(fixture.spawnImpl.mock.calls[0][2].env[NATIVE]).toBe("42");
  });

  it("warns about invalid overrides without echoing their value", async () => {
    const fixture = spawnerFixture({ env: { [OVERRIDE]: "private-invalid-value" } });
    const pending = fixture.spawner.wake(params);
    fixture.child.emit("close", 0);
    await pending;
    expect(fixture.logger.warn).toHaveBeenCalledWith(expect.stringContaining("using the 3600000ms default"));
    expect(JSON.stringify(fixture.logger.warn.mock.calls)).not.toContain("private-invalid-value");
  });
});

describe("Claude background termination detection", () => {
  it.each([0, 7, null])("latches split/repeated diagnostics and preserves raw exit %s", async (code) => {
    const fixture = spawnerFixture();
    const pending = fixture.spawner.wake(params);
    fixture.child.stdout.emit("data", '{"type":"result","subtype":"success"}\n');
    for (const character of TERMINATION) fixture.child.stderr.emit("data", character);
    fixture.child.stderr.emit("data", TERMINATION + "\n" + "noise".repeat(20000));
    fixture.child.emit("close", code, code === null ? "SIGTERM" : null);
    const result = await pending;
    expect(result.backgroundTasksTerminated).toBe(true);
    expect(result.exitCode).toBe(code === 0 ? 1 : code);
    expect(result.wakeError).toMatchObject({ kind: "execution", source: "claude", exitCode: code });
    expect(result.wakeError.message).toContain("unfinished background agents");
    if (code === null) expect(result.wakeError.signal).toBe("SIGTERM");
    expect(fixture.logger.warn.mock.calls.filter(([message]) => message.includes("this wake did not complete"))).toHaveLength(1);
  });

  it("detects a diagnostic before a large single-chunk tail", async () => {
    const fixture = spawnerFixture();
    const pending = fixture.spawner.wake(params);
    fixture.child.stderr.emit("data", "noise".repeat(20000) + TERMINATION + "noise".repeat(20000));
    fixture.child.emit("close", 0);
    expect((await pending).backgroundTasksTerminated).toBe(true);
  });

  it("ignores incomplete/near-match stderr and quoted stdout", async () => {
    const fixture = spawnerFixture();
    const pending = fixture.spawner.wake(params);
    fixture.child.stderr.emit("data", "Background tasks still running after 600s; continuing.\n");
    fixture.child.stdout.emit("data", JSON.stringify({ type: "assistant", message: TERMINATION }) + "\n");
    fixture.child.stderr.emit("data", "Background tasks still running after 600s");
    fixture.child.emit("close", 0);
    expect(await pending).toEqual({ sessionId: SESSION, backendSessionId: SESSION, exitCode: 0, isNew: true });
  });

  it("preserves session conflict classification", async () => {
    const fixture = spawnerFixture();
    const pending = fixture.spawner.wake(params);
    fixture.child.stderr.emit("data", "Session id is already in use\n");
    fixture.child.emit("close", 1);
    expect(await pending).toMatchObject({ exitCode: 1, failureClassification: SESSION_CONFLICT_FAILURE });
  });
});

async function wakeFixture({ entityType = "task", failComment = false, stop = null } = {}) {
  const fixture = spawnerFixture();
  const postComment = failComment ? vi.fn(async () => { throw new Error("private transport detail"); }) : vi.fn(async () => ({}));
  const advanceTurn = vi.fn(async ({ status }) => status === "running" ? { ok: true, data: { turnUuid: "turn" } } : { ok: true });
  const cleanup = vi.fn();
  const reportInterrupt = vi.fn();
  const notification = { action: entityType === "task" ? "task_assigned" : "mentioned", entityType, entityUuid: TASK, actorName: "Owner", actorUuid: "owner", actorType: "user", message: "work" };
  const waker = new Waker({
    creds: { url: "https://chorus.test", apiKey: "synthetic-key" },
    lineage: { resolve: async () => ({ directIdeaUuid: SESSION, rootIdeaUuid: "different-root" }) },
    spawner: fixture.spawner, logger: fixture.logger, postComment, advanceTurn, reportInterrupt,
    writeMcpConfigFn: () => ({ path: "/mcp.json", cleanup }), isNewSessionFn: () => true,
  });
  fixture.spawnImpl.mockImplementation(() => {
    queueMicrotask(() => {
      if (stop === "user") waker.interrupting.add(`${entityType}:${TASK}`);
      if (stop === "shutdown") waker.shuttingDown = true;
      fixture.child.stdout.emit("data", '{"type":"result","subtype":"success"}\n');
      fixture.child.stderr.emit("data", TERMINATION + "\n" + TERMINATION);
      fixture.child.emit("close", 0);
    });
    return fixture.child;
  });
  await waker.wake(notification, `idea:${SESSION}`, { directIdeaUuid: SESSION, rootIdeaUuid: "different-root" });
  return { ...fixture, waker, postComment, advanceTurn, reportInterrupt, cleanup };
}

describe("Claude spawner to Waker background failure integration", () => {
  it.each(["idea", "task"])("reports failure and comments once on triggering %s", async (entityType) => {
    const fixture = await wakeFixture({ entityType });
    expect(fixture.advanceTurn).toHaveBeenLastCalledWith(expect.objectContaining({
      status: "interrupted", interruptedReason: "crash", wakeError: expect.objectContaining({ exitCode: 0 }),
    }));
    expect(fixture.postComment).toHaveBeenCalledTimes(1);
    expect(fixture.postComment).toHaveBeenCalledWith({ targetType: entityType, targetUuid: TASK, content: expect.stringContaining(SESSION) });
    const content = fixture.postComment.mock.calls[0][0].content;
    expect(content).not.toMatch(/synthetic-key|different-root|@\[/);
    expect(content.length).toBeLessThan(600);
    expect(fixture.cleanup).toHaveBeenCalledOnce();
    expect(fixture.waker.executions.size).toBe(0);
    expect(fixture.logger.info.mock.calls.map(([message]) => message).join("\n")).toMatch(/! wake done: .*exit=1/);
  });

  it("keeps failure reporting and cleanup when the comment rejects", async () => {
    const fixture = await wakeFixture({ failComment: true });
    expect(fixture.postComment).toHaveBeenCalledOnce();
    expect(fixture.cleanup).toHaveBeenCalledOnce();
    expect(fixture.advanceTurn).toHaveBeenLastCalledWith(expect.objectContaining({ status: "interrupted" }));
    expect(fixture.logger.warn).toHaveBeenCalledWith(expect.stringContaining("Could not post"));
    expect(JSON.stringify(fixture.logger.warn.mock.calls)).not.toContain("private transport detail");
  });

  it("does not comment on unsupported entities", async () => {
    const fixture = await wakeFixture({ entityType: "proposal" });
    expect(fixture.postComment).not.toHaveBeenCalled();
    expect(fixture.advanceTurn).toHaveBeenLastCalledWith(expect.objectContaining({ status: "interrupted" }));
  });

  it.each(["user", "shutdown"])("preserves %s stop precedence", async (stop) => {
    const fixture = await wakeFixture({ stop });
    expect(fixture.advanceTurn).toHaveBeenLastCalledWith(expect.objectContaining({ status: "interrupted", interruptedReason: stop }));
    if (stop === "shutdown") expect(fixture.reportInterrupt).not.toHaveBeenCalled();
    else expect(fixture.reportInterrupt).toHaveBeenCalledWith("task", TASK, "user");
  });
});
