import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  DshSpawner,
  addDshUsage,
  resolveDshHome,
  resolveDshPath,
} from "../dsh-spawner.mjs";

const CREDS = { url: "https://chorus.test", apiKey: "cho_secret" };
const UUID = "11111111-2222-4333-8444-555555555555";
const SID = "chorus-11111111222243338444555555555555";
const UUID2 = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const SID2 = "chorus-aaaaaaaabbbb4ccc8dddeeeeeeeeeeee";

function response(id, result) {
  return `${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`;
}

function notification(method, params) {
  return `${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`;
}

function fakeChild(onRequest) {
  const child = new EventEmitter();
  child.pid = 4321;
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = vi.fn();
  child.stderr = new EventEmitter();
  child.stderr.setEncoding = vi.fn();
  child.kill = vi.fn();
  child.stdin = new EventEmitter();
  child.stdin.writes = [];
  child.stdin.write = vi.fn((chunk) => {
    child.stdin.writes.push(String(chunk));
    onRequest?.(JSON.parse(String(chunk)), child);
    return true;
  });
  child.stdin.end = vi.fn(() => {
    queueMicrotask(() => child.emit("close", 0));
  });
  return child;
}

function successfulRuntime(sessionId = SID) {
  return fakeChild((request, child) => {
    queueMicrotask(() => {
      if (request.method === "initialize") {
        const frame = response(request.id, {
          serverInfo: { name: "deepseek-harness-sdk-runtime", version: "0.0.1" },
        });
        child.stdout.emit("data", frame.slice(0, 12));
        child.stdout.emit("data", frame.slice(12));
      } else if (request.method === "session/prompt") {
        // These can arrive before the prompt response; the bridge buffers them
        // until the response identifies the durable inbox receipt.
        child.stdout.emit(
          "data",
          notification("session.event", {
            sessionId,
            event: {
              type: "agent/inbox/spliced",
              data: { inserted: [{ id: "msg-1" }] },
            },
          }) +
            notification("session.event", {
              sessionId,
              event: {
                type: "user/message",
                data: { message: { role: "user", content: [{ type: "text", text: "hello" }] } },
              },
            }),
        );
        child.stdout.emit(
          "data",
          notification("session.event", {
            sessionId: "child-session",
            event: {
              type: "assistant/message",
              data: {
                message: { role: "assistant", content: [{ type: "text", text: "ignore child" }] },
                usage: { inputTokens: 999 },
              },
            },
          }),
        );
        child.stdout.emit(
          "data",
          notification("session.event", {
            sessionId,
            event: {
              type: "assistant/message",
              data: {
                message: { role: "assistant", content: [] },
                usage: { inputTokens: 2, outputTokens: 3, reasoningTokens: 100 },
              },
            },
          }) +
            notification("session.event", {
              sessionId,
              event: {
                type: "assistant/message",
                data: {
                  message: {
                    role: "assistant",
                    content: [{ type: "text", text: "answer" }],
                    source: { kind: "model", provider: "deepseek-official", model: "model-x" },
                  },
                  usage: {
                    inputTokens: 5,
                    outputTokens: 7,
                    cacheWriteTokens: 11,
                    cacheReadTokens: 13,
                  },
                },
              },
            }),
        );
        child.stdout.emit("data", response(request.id, { messageId: "msg-1" }));
        child.stdout.emit(
          "data",
          notification("session.status", { sessionId, status: "idle" }),
        );
      } else if (request.method === "shutdown") {
        child.stdout.emit("data", response(request.id, {}));
        queueMicrotask(() => child.emit("close", 0));
      }
    });
  });
}

function makeSpawner(overrides = {}) {
  const child = overrides.child ?? successfulRuntime();
  const calls = {};
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const spawner = new DshSpawner({
    dshPath: "/opt/dsh",
    env: {
      PATH: "/bin",
      CHORUS_DSH_HOME: "/managed/home",
      CHORUS_DSH_MODEL: "model-x",
    },
    platform: "linux",
    creds: CREDS,
    uuidFn: () => UUID,
    timeoutMs: 100,
    shutdownTimeoutMs: 100,
    logger,
    spawnImpl: (command, argv, opts) => {
      Object.assign(calls, { command, argv, opts });
      return child;
    },
    ...overrides,
  });
  return { spawner, child, calls, logger };
}

describe("dsh runtime discovery and usage", () => {
  it("uses CHORUS_DSH_PATH before PATH and resolves the `dsh` CLI (not the removed agent bin)", () => {
    expect(
      resolveDshPath({
        env: { CHORUS_DSH_PATH: "/override/dsh", PATH: "/a:/b" },
        platform: "linux",
        isFile: (path) => path === "/override/dsh",
      }),
    ).toBe("/override/dsh");
    expect(
      resolveDshPath({
        env: { PATH: "/a:/b" },
        platform: "linux",
        isFile: (path) => path === "/b/dsh",
      }),
    ).toBe("/b/dsh");
    // Windows probes the .cmd/.exe shims for `dsh`.
    expect(
      resolveDshPath({
        env: { PATH: "C:\\a;C:\\b" },
        platform: "win32",
        isFile: (path) => path === "C:\\b\\dsh.cmd",
      }),
    ).toBe("C:\\b\\dsh.cmd");
    // The explicit managed-home override (replacing the removed cordis config override).
    expect(resolveDshHome({ CHORUS_DSH_HOME: " /operator/dsh " })).toBe("/operator/dsh");
    expect(resolveDshHome({})).toBe(null);
  });

  it("aggregates valid disjoint categories and never adds reasoning", () => {
    const total = {
      inputTokens: null,
      outputTokens: null,
      cacheCreationTokens: null,
      cacheReadTokens: null,
    };
    addDshUsage(total, {
      inputTokens: 4,
      outputTokens: 3,
      reasoningTokens: 100,
      cacheWriteTokens: 2,
      cacheReadTokens: -1,
    });
    addDshUsage(total, { inputTokens: 6, outputTokens: "bad", cacheReadTokens: 5 });
    expect(total).toEqual({
      inputTokens: 10,
      outputTokens: 3,
      cacheCreationTokens: 2,
      cacheReadTokens: 5,
    });
  });
});

describe("DshSpawner.wake", () => {
  it("drives initialize → prompt → root idle → shutdown with protocol-only stdout", async () => {
    const { spawner, child, calls } = makeSpawner();
    const onMessage = vi.fn();
    const onChild = vi.fn();
    const result = await spawner.wake({
      prompt: "secret prompt",
      sessionId: "chorus-anchor",
      cwd: "/workspace",
      onMessage,
      onChild,
    });

    expect(result).toEqual({
      sessionId: SID,
      backendSessionId: SID,
      exitCode: 0,
      isNew: true,
    });
    expect(onChild).toHaveBeenCalledWith(child);
    expect(calls.command).toBe("/opt/dsh");
    expect(calls.argv).toEqual(["--profile", "sdk"]);
    expect(calls.opts.detached).toBe(true);
    expect(calls.opts.stdio).toEqual(["pipe", "pipe", "pipe"]);
    expect(calls.opts.env.DSH_HOME).toBe("/managed/home");
    expect(calls.opts.env.DSH_CORDIS_CONFIG).toBeUndefined();
    expect(calls.opts.env.CHORUS_API_KEY).toBe("cho_secret");
    expect(JSON.stringify(calls.argv)).not.toContain("secret prompt");
    expect(JSON.stringify(calls.argv)).not.toContain("cho_secret");

    const requests = child.stdin.writes.map((line) => JSON.parse(line));
    expect(requests.map((request) => request.method)).toEqual([
      "initialize",
      "session/prompt",
      "shutdown",
    ]);
    expect(requests[0].params).toEqual({
      cwd: "/workspace",
      provider: "deepseek-official",
      model: "model-x",
    });
    expect(requests[1].params).toEqual({
      sessionId: SID,
      contentBlocks: [{ type: "text", text: "secret prompt" }],
    });

    expect(onMessage).toHaveBeenCalledTimes(3);
    expect(onMessage.mock.calls[0][0]).toMatchObject({
      type: "user/message",
      session_id: SID,
    });
    expect(onMessage.mock.calls[1][0]).toMatchObject({
      type: "assistant/message",
      session_id: SID,
      data: { message: { content: [{ type: "text", text: "answer" }] } },
    });
    expect(onMessage.mock.calls[2][0]).toEqual({
      type: "dsh.turn.completed",
      session_id: SID,
      usage: {
        inputTokens: 7,
        outputTokens: 10,
        cacheCreationTokens: 11,
        cacheReadTokens: 13,
        model: "model-x",
        source: "dsh",
      },
    });
  });

  it("passes CJK/space cwd values verbatim while isolating every runtime session", async () => {
    const fixtures = [
      { cwd: "/workspaces/项目 alpha", uuid: UUID, sid: SID },
      { cwd: "/workspaces/space only", uuid: UUID2, sid: SID2 },
    ];
    const calls = [];
    let index = 0;
    const { spawner } = makeSpawner({
      uuidFn: () => fixtures[index].uuid,
      spawnImpl: (command, argv, opts) => {
        const fixture = fixtures[index++];
        const child = successfulRuntime(fixture.sid);
        calls.push({ command, argv, opts, child });
        return child;
      },
    });

    const results = [];
    for (const fixture of fixtures) {
      results.push(await spawner.wake({
        prompt: "continue",
        sessionId: "shared-claude-anchor",
        cwd: fixture.cwd,
        isNew: false,
      }));
    }

    expect(spawner.sessionDecision).toEqual({ probeIsAuthoritative: false });
    expect(results.map((result) => result.backendSessionId)).toEqual([SID, SID2]);
    for (const [fixtureIndex, fixture] of fixtures.entries()) {
      const call = calls[fixtureIndex];
      expect(call.opts.cwd).toBe(fixture.cwd);
      expect(call.opts.env.DSH_CWD).toBe(fixture.cwd);
      const requests = call.child.stdin.writes.map((line) => JSON.parse(line));
      expect(requests[0].params.cwd).toBe(fixture.cwd);
      expect(requests[1].params.sessionId).toBe(fixture.sid);
      expect(requests[1].params.sessionId).not.toBe("shared-claude-anchor");
      expect(results[fixtureIndex]).toMatchObject({
        sessionId: fixture.sid,
        backendSessionId: fixture.sid,
        isNew: true,
      });
    }
  });

  it("contains callback exceptions and logs stderr diagnostics", async () => {
    const { spawner, child, logger } = makeSpawner();
    const wake = spawner.wake({
      prompt: "x",
      sessionId: "anchor",
      onChild: () => {
        throw new Error("child callback");
      },
      onMessage: () => {
        throw new Error("message callback");
      },
    });
    child.stderr.emit("data", "runtime diagnostic\n");
    await expect(wake).resolves.toMatchObject({ exitCode: 0, isNew: true });
    expect(logger.warn.mock.calls.flat().join("\n")).toMatch(/child callback/);
    expect(logger.warn.mock.calls.flat().join("\n")).toMatch(/message callback/);
    expect(logger.warn.mock.calls.flat().join("\n")).toMatch(/runtime diagnostic/);
  });

  it("fails visibly when the dsh CLI or managed preparation are absent", async () => {
    const missingRuntime = new DshSpawner({
      resolveDshPathFn: () => null,
      env: { CHORUS_DSH_HOME: "/x" },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    await expect(missingRuntime.wake({ prompt: "x", sessionId: "a" })).resolves.toMatchObject({
      exitCode: null,
      isNew: true,
    });

    // dsh present, no CHORUS_DSH_HOME override → managed prep runs; the default
    // preparer aborts before spawning (no bundle version) and the wake fails loud.
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const missingManaged = new DshSpawner({ dshPath: "/bin/dsh", env: {}, logger });
    await expect(missingManaged.wake({ prompt: "x", sessionId: "a" })).resolves.toMatchObject({
      exitCode: null,
    });
    expect(logger.error.mock.calls.flat().join("\n")).toMatch(/managed dsh profile/);
  });

  it("boots a prepared managed DSH_HOME with the external dsh CLI and any provider --patch", async () => {
    const prepareManagedConfigFn = vi.fn(async () => ({
      home: "/managed/home",
      patchPath: "/managed/home/chorus-provider.patch.yml",
    }));
    const { spawner, calls } = makeSpawner({
      env: { PATH: "/bin" },
      bundleVersion: "0.16.3",
      prepareManagedConfigFn,
    });
    await spawner.wake({
      prompt: "hello",
      sessionId: "anchor",
      cwd: "/workspace",
      onMessage: vi.fn(),
    });
    expect(prepareManagedConfigFn).toHaveBeenCalledWith(expect.objectContaining({
      bundleVersion: "0.16.3",
      dshPath: "/opt/dsh",
      creds: CREDS,
    }));
    // The external dsh CLI drives the launch — the managed prep composes only a
    // profile home, never a runtime bin.
    expect(calls.command).toBe("/opt/dsh");
    expect(calls.opts.env.DSH_HOME).toBe("/managed/home");
    expect(calls.opts.env.DSH_CORDIS_CONFIG).toBeUndefined();
    expect(calls.argv).toEqual([
      "--profile",
      "sdk",
      "--patch",
      "/managed/home/chorus-provider.patch.yml",
    ]);
  });

  it("omits --patch when the managed prep returns no provider overlay", async () => {
    const prepareManagedConfigFn = vi.fn(async () => ({ home: "/managed/home", patchPath: null }));
    const { spawner, calls } = makeSpawner({
      env: { PATH: "/bin" },
      bundleVersion: "0.16.3",
      prepareManagedConfigFn,
    });
    await spawner.wake({ prompt: "hi", sessionId: "anchor", cwd: "/workspace", onMessage: vi.fn() });
    expect(calls.argv).toEqual(["--profile", "sdk"]);
    expect(calls.opts.env.DSH_HOME).toBe("/managed/home");
  });

  it("fails malformed stdout and bounds a runtime that never reaches idle", async () => {
    const malformedChild = fakeChild((request, child) => {
      if (request.method === "initialize") queueMicrotask(() => child.stdout.emit("data", "not json\n"));
    });
    const malformed = makeSpawner({ child: malformedChild });
    await expect(
      malformed.spawner.wake({ prompt: "x", sessionId: "a" }),
    ).resolves.toMatchObject({ exitCode: null });
    expect(malformed.logger.error.mock.calls.flat().join("\n")).toMatch(/malformed JSON/);

    const hungChild = fakeChild((request, child) => {
      queueMicrotask(() => {
        if (request.method === "initialize") {
          child.stdout.emit(
            "data",
            response(request.id, {
              serverInfo: { name: "deepseek-harness-sdk-runtime", version: "0.0.1" },
            }),
          );
        } else if (request.method === "session/prompt") {
          child.stdout.emit("data", response(request.id, { messageId: "msg-hung" }));
          child.stdout.emit(
            "data",
            notification("session.event", {
              sessionId: SID,
              event: {
                type: "agent/inbox/spliced",
                data: { inserted: [{ id: "msg-hung" }] },
              },
            }),
          );
        }
      });
    });
    const hung = makeSpawner({ child: hungChild, timeoutMs: 10 });
    await expect(hung.spawner.wake({ prompt: "x", sessionId: "a" })).resolves.toMatchObject({
      exitCode: null,
    });
    expect(hung.logger.error.mock.calls.flat().join("\n")).toMatch(/timed out/);
  });

  it("surfaces JSON-RPC errors and premature runtime exits", async () => {
    const rpcErrorChild = fakeChild((request, child) => {
      if (request.method === "initialize") {
        queueMicrotask(() =>
          child.stdout.emit(
            "data",
            `${JSON.stringify({
              jsonrpc: "2.0",
              id: request.id,
              error: { code: -32603, message: "bad composition" },
            })}\n`,
          ),
        );
      }
    });
    const rpcError = makeSpawner({ child: rpcErrorChild });
    await expect(rpcError.spawner.wake({ prompt: "x", sessionId: "a" })).resolves.toMatchObject({
      exitCode: null,
    });
    expect(rpcError.logger.error.mock.calls.flat().join("\n")).toMatch(/bad composition/);

    const exitedChild = fakeChild((request, child) => {
      if (request.method === "initialize") queueMicrotask(() => child.emit("close", 23));
    });
    const exited = makeSpawner({ child: exitedChild });
    await expect(exited.spawner.wake({ prompt: "x", sessionId: "a" })).resolves.toMatchObject({
      exitCode: 23,
    });
    expect(exited.logger.error.mock.calls.flat().join("\n")).toMatch(/exited before protocol completion/);
  });
});
