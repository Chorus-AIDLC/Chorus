import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Config,
  apply,
  chorusMcpCallPath,
  detectOpenspecActive,
  isDaemonOrigin,
  normalizeChorusToolName,
  resolveConnectionConfig,
} from "../src/index.js";

type Handler = (...args: any[]) => any;

class FakeContext {
  readonly handlers = new Map<string, Handler[]>();
  readonly disposers: Array<() => void | Promise<void>> = [];
  readonly calls: any[] = [];
  readonly services = new Map<string, unknown>();
  readonly logs = { info: [] as string[], warn: [] as string[], debug: [] as string[] };
  toolResult: any = {
    isError: false,
    value: { ok: true },
    content: [{ type: "text", text: "checked in" }],
  };
  tools = {
    execute: vi.fn(async (exec: any) => {
      this.calls.push(exec);
      return this.toolResult;
    }),
  };
  logger = {
    info: (message: string) => this.logs.info.push(message),
    warn: (message: string) => this.logs.warn.push(message),
    debug: (message: string) => this.logs.debug.push(message),
  };

  on(name: string, handler: Handler): () => void {
    const handlers = this.handlers.get(name) ?? [];
    handlers.push(handler);
    this.handlers.set(name, handlers);
    return () => this.handlers.set(name, handlers.filter((entry) => entry !== handler));
  }

  effect(effect: () => () => void | Promise<void>): () => void | Promise<void> {
    const disposer = effect();
    this.disposers.push(disposer);
    return disposer;
  }

  provide(name: string, value: unknown): () => void {
    this.services.set(name, value);
    const dispose = () => {
      this.services.delete(name);
    };
    this.disposers.push(dispose);
    return dispose;
  }

  emit(name: string, ...args: any[]): void {
    for (const handler of this.handlers.get(name) ?? []) handler(...args);
  }

  async waterfall(name: string, args: any[], terminal: () => Promise<any>): Promise<any> {
    const handlers = this.handlers.get(name) ?? [];
    const run = (index: number): Promise<any> =>
      index === handlers.length
        ? terminal()
        : handlers[index](...args, () => run(index + 1));
    return run(0);
  }

  async serial(name: string, ...args: any[]): Promise<void> {
    for (const handler of this.handlers.get(name) ?? []) await handler(...args);
  }

  async dispose(): Promise<void> {
    for (const disposer of [...this.disposers].reverse()) await disposer();
    this.handlers.clear();
  }
}

function fakeAgent() {
  return {
    id: "agent-1",
    steered: [] as any[],
    injected: [] as any[],
    steer(message: any) {
      this.steered.push(message);
    },
    inject(message: any) {
      this.injected.push(message);
    },
  } as any;
}

function config(overrides: Partial<ReturnType<typeof Config>> = {}) {
  return Config(overrides);
}

function execution(agent: any, name: string, args: Record<string, unknown>, callId = "call-1") {
  return {
    callId,
    rootCallId: callId,
    token: Symbol(callId),
    name,
    arguments: args,
    agent,
    signal: new AbortController().signal,
  } as any;
}

const success = {
  isError: false,
  value: { ok: true },
  content: [{ type: "text", text: "ok" }],
} as any;

beforeEach(() => {
  process.env.CHORUS_URL = "https://chorus.test";
  process.env.CHORUS_API_KEY = "cho_test";
});

afterEach(() => {
  delete process.env.CHORUS_DAEMON_HEADLESS;
  delete process.env.CHORUS_URL;
  delete process.env.CHORUS_API_KEY;
  delete process.env.CHORUS_MCP_CALL;
  delete process.env.CHORUS_OPENSPEC_ACTIVE;
  delete process.env.CHORUS_OPENSPEC_MODE;
});

describe("configuration and helpers", () => {
  it("applies defaults and validates ranges", () => {
    expect(Config({})).toEqual({
      daemonOriginEnv: "CHORUS_DAEMON_HEADLESS",
      checkinTimeoutMs: 1500,
      maxPendingActions: 8,
    });
    for (const value of [99, 30001, 100.5]) {
      expect(() => Config({ checkinTimeoutMs: value })).toThrow();
    }
    for (const value of [0, 65, 1.5]) {
      expect(() => Config({ maxPendingActions: value })).toThrow();
    }
    expect(() => Config({ daemonOriginEnv: "not-valid" })).toThrow();
  });

  it("requires an exact daemon marker and exact Chorus prefix", () => {
    expect(isDaemonOrigin({ MARKER: "1" }, "MARKER")).toBe(true);
    expect(isDaemonOrigin({ MARKER: "true" }, "MARKER")).toBe(false);
    expect(normalizeChorusToolName("mcp__chorus__chorus_checkin")).toBe("chorus_checkin");
    expect(normalizeChorusToolName("chorus_checkin")).toBeUndefined();
  });

  it("resolves explicit connection fields before independent environment fallbacks", () => {
    expect(
      resolveConnectionConfig(
        { url: " https://configured.example/ ", apiKey: "" },
        {
          CHORUS_URL: "https://environment.example",
          CHORUS_API_KEY: "cho_environment",
        },
      ),
    ).toEqual({
      url: "https://configured.example",
      apiKey: "cho_environment",
    });
    expect(() => resolveConnectionConfig({}, {})).toThrow("url is required");
  });

  it("treats openspec as inactive when opted out or missing the workspace", () => {
    process.env.CHORUS_OPENSPEC_MODE = "off";
    expect(detectOpenspecActive()).toBe(false);
    delete process.env.CHORUS_OPENSPEC_MODE;
    expect(detectOpenspecActive("/nonexistent-openspec-root-xyz")).toBe(false);
  });

  it("falls back to $DSH_HOME/.env for creds absent from config and env", () => {
    const dir = mkdtempSync(join(tmpdir(), "chorus-dsh-env-"));
    writeFileSync(
      join(dir, ".env"),
      "# creds\nexport CHORUS_URL=https://from-dotenv.example/\nCHORUS_API_KEY='cho_dotenv'\n",
    );
    expect(resolveConnectionConfig({}, { DSH_HOME: dir })).toEqual({
      url: "https://from-dotenv.example",
      apiKey: "cho_dotenv",
    });
    // process env still wins over the .env fallback
    expect(
      resolveConnectionConfig({}, { DSH_HOME: dir, CHORUS_API_KEY: "cho_env" }).apiKey,
    ).toBe("cho_env");
    // throws when neither env nor .env provides creds
    const empty = mkdtempSync(join(tmpdir(), "chorus-dsh-empty-"));
    expect(() => resolveConnectionConfig({}, { DSH_HOME: empty })).toThrow("url is required");
  });
});

describe("runtime", () => {
  it("publishes the package-local MCP wrapper path without overwriting an operator value", () => {
    const ctx = new FakeContext();
    apply(ctx as any, config());
    expect(process.env.CHORUS_MCP_CALL).toBe(chorusMcpCallPath);
    process.env.CHORUS_MCP_CALL = "/operator/wrapper";
    apply(new FakeContext() as any, config());
    expect(process.env.CHORUS_MCP_CALL).toBe("/operator/wrapper");
  });

  it("publishes CHORUS_OPENSPEC_ACTIVE without overwriting an operator value", () => {
    apply(new FakeContext() as any, config());
    expect(["0", "1"]).toContain(process.env.CHORUS_OPENSPEC_ACTIVE);
    process.env.CHORUS_OPENSPEC_ACTIVE = "1";
    apply(new FakeContext() as any, config());
    expect(process.env.CHORUS_OPENSPEC_ACTIVE).toBe("1");
  });

  it("registers no lifecycle handlers or effects in daemon mode", () => {
    process.env.CHORUS_DAEMON_HEADLESS = "1";
    process.env.CHORUS_URL = "https://chorus.example";
    process.env.CHORUS_API_KEY = "cho_test";
    const ctx = new FakeContext();
    apply(ctx as any, config());
    expect(ctx.handlers.size).toBe(0);
    expect(ctx.disposers).toHaveLength(1);
    expect(ctx.tools.execute).not.toHaveBeenCalled();
    expect(ctx.logs.info[0]).toContain("lifecycle automation disabled");
    expect(ctx.services.get("chorusDshConfig")).toEqual({
      url: "https://chorus.example",
      apiKey: "cho_test",
    });
  });

  it("injects check-in context + session-start guidance into the first step exactly once", async () => {
    const ctx = new FakeContext();
    const agent = fakeAgent();
    apply(ctx as any, config());
    ctx.emit("agent/session-start", { agent, source: "startup" });

    const first = await ctx.waterfall(
      "agent/pre-step",
      [{ agent, messages: [], turn: 1, step: 1, signal: new AbortController().signal }],
      async () => ({ kind: "enter", messages: [] }),
    );
    const second = await ctx.waterfall(
      "agent/pre-step",
      [{ agent, messages: [], turn: 1, step: 2, signal: new AbortController().signal }],
      async () => ({ kind: "enter", messages: [] }),
    );

    expect(ctx.tools.execute).toHaveBeenCalledTimes(1);
    // First step injects the check-in context message + the one-line guidance.
    expect(first.messages).toHaveLength(2);
    expect(first.messages[0].content[0].text).toBe("checked in");
    expect(first.messages[1].content[0].text).toContain("AI-DLC");
    expect(second.messages).toHaveLength(0);
    await ctx.dispose();
  });

  it.each(["missing", "error", "timeout"])("fails open when check-in is %s", async (mode) => {
    vi.useFakeTimers();
    const ctx = new FakeContext();
    if (mode === "missing") {
      ctx.toolResult = {
        isError: true,
        error: { message: "unknown tool" },
        content: [{ type: "text", text: "unknown tool" }],
      };
    } else if (mode === "error") {
      ctx.tools.execute = vi.fn(async () => {
        throw new Error("offline");
      });
    } else {
      ctx.tools.execute = vi.fn(() => new Promise(() => {})) as any;
    }
    const agent = fakeAgent();
    apply(ctx as any, config({ checkinTimeoutMs: 100 }));
    ctx.emit("agent/session-start", { agent, source: "startup" });
    const pending = ctx.waterfall(
      "agent/pre-step",
      [{ agent, messages: [], turn: 1, step: 1, signal: new AbortController().signal }],
      async () => ({ kind: "enter", messages: [{ existing: true }] }),
    );
    await vi.advanceTimersByTimeAsync(100);
    await expect(pending).resolves.toEqual({ kind: "enter", messages: [{ existing: true }] });
    expect(ctx.logs.warn.length).toBeGreaterThan(0);
    if (mode !== "timeout") await ctx.dispose();
    vi.useRealTimers();
  });

  it("observes successful Chorus actions, deduplicates, and emits one combined steer", async () => {
    const ctx = new FakeContext();
    const agent = fakeAgent();
    apply(ctx as any, config());
    ctx.emit("agent/session-start", { agent, source: "startup" });

    const actions = [
      ["chorus_pm_submit_proposal", { proposalUuid: "proposal-1" }],
      ["chorus_submit_for_verify", { taskUuid: "task-1" }],
      ["chorus_admin_verify_task", { taskUuid: "task-1" }],
    ] as const;
    for (const [tool, args] of [...actions, actions[0]]) {
      const downstream = { kind: "accept" };
      await ctx.waterfall(
        "tools/post-execute",
        [execution(agent, `mcp__chorus__${tool}`, args), success],
        async () => downstream,
      );
    }
    await ctx.serial("agent/turn-stopping", { agent, turn: 1, signal: new AbortController().signal });

    expect(agent.steered).toHaveLength(1);
    const text = agent.steered[0].content[0].text;
    expect(text.match(/proposal reviewer/g)).toHaveLength(1);
    expect(text).toContain("task reviewer");
    expect(text).toContain("First verify whether task task-1 was the final task");
    await ctx.serial("agent/turn-stopping", { agent, turn: 1, signal: new AbortController().signal });
    expect(agent.steered).toHaveLength(1);
    await ctx.dispose();
  });

  it("ignores failed, blocked, synthetic, and non-Chorus tool results", async () => {
    const ctx = new FakeContext();
    const agent = fakeAgent();
    apply(ctx as any, config());
    ctx.emit("agent/session-start", { agent, source: "startup" });

    const cases = [
      [execution(agent, "ordinary", {}), success, { kind: "accept" }],
      [execution(agent, "mcp__chorus__chorus_submit_for_verify", { taskUuid: "x" }), { ...success, isError: true }, { kind: "accept" }],
      [execution(agent, "mcp__chorus__chorus_submit_for_verify", { taskUuid: "x" }), success, { kind: "block", feedback: [] }],
      [execution(agent, "mcp__chorus__chorus_submit_for_verify", { taskUuid: "x" }, "chorus-dsh:checkin:99"), success, { kind: "accept" }],
    ] as const;
    for (const [exec, result, downstream] of cases) {
      expect(
        await ctx.waterfall("tools/post-execute", [exec, result], async () => downstream),
      ).toBe(downstream);
    }
    await ctx.serial("agent/turn-stopping", { agent, turn: 1, signal: new AbortController().signal });
    expect(agent.steered).toHaveLength(0);
    await ctx.dispose();
  });

  it("bounds distinct pending actions and preserves duplicate capacity", async () => {
    const ctx = new FakeContext();
    const agent = fakeAgent();
    apply(ctx as any, config({ maxPendingActions: 1 }));
    ctx.emit("agent/session-start", { agent, source: "startup" });
    for (const taskUuid of ["task-1", "task-1", "task-2"]) {
      await ctx.waterfall(
        "tools/post-execute",
        [execution(agent, "mcp__chorus__chorus_submit_for_verify", { taskUuid }), success],
        async () => ({ kind: "accept" }),
      );
    }
    await ctx.serial("agent/turn-stopping", { agent, turn: 1, signal: new AbortController().signal });
    expect(agent.steered[0].content[0].text).toContain("task-1");
    expect(agent.steered[0].content[0].text).not.toContain("task-2");
    expect(ctx.logs.warn.some((line) => line.includes("limit"))).toBe(true);
    await ctx.dispose();
  });

  it("aborts in-flight work, clears state, and waits for settlement on disposal", async () => {
    const ctx = new FakeContext();
    let settled = false;
    ctx.tools.execute = vi.fn(
      (exec: any) =>
        new Promise((resolve) => {
          exec.signal.addEventListener(
            "abort",
            () => {
              settled = true;
              resolve({
                isError: true,
                error: { message: "aborted" },
                content: [{ type: "text", text: "aborted" }],
              });
            },
            { once: true },
          );
        }),
    ) as any;
    const agent = fakeAgent();
    apply(ctx as any, config());
    ctx.emit("agent/session-start", { agent, source: "startup" });
    await ctx.dispose();
    expect(settled).toBe(true);
  });
});
