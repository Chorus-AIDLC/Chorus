import { describe, it, expect, vi } from "vitest";
import { resolveSessionKey, resolveAgentId, resolveModelRef, createWake } from "../wake.js";

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/** Flush the fire-and-forget wake promise chain. */
async function flush() {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

describe("resolveSessionKey", () => {
  it("returns 'global' when session.scope is global", () => {
    const api = { config: { session: { scope: "global" } } } as never;
    expect(resolveSessionKey(api)).toBe("global");
  });

  it("builds agent:<default>:<mainKey> from the default-flagged agent", () => {
    const api = {
      config: {
        session: { mainKey: "main" },
        agents: { list: [{ id: "alpha" }, { id: "beta", default: true }] },
      },
    } as never;
    expect(resolveSessionKey(api)).toBe("agent:beta:main");
  });

  it("falls back to the first agent when none is flagged default", () => {
    const api = {
      config: { agents: { list: [{ id: "first" }, { id: "second" }] } },
    } as never;
    expect(resolveSessionKey(api)).toBe("agent:first:main");
  });

  it("falls back to 'main' agent id and 'main' key when no agents configured", () => {
    const api = { config: {} } as never;
    expect(resolveSessionKey(api)).toBe("agent:main:main");
  });

  it("normalizes a messy agent id to a path-safe slug", () => {
    const api = {
      config: { agents: { list: [{ id: "My Agent!!", default: true }] } },
    } as never;
    expect(resolveSessionKey(api)).toBe("agent:my-agent:main");
  });

  it("returns null when api.config is absent", () => {
    const api = {} as never;
    expect(resolveSessionKey(api)).toBeNull();
  });
});

describe("resolveAgentId", () => {
  it("returns the default-flagged agent id", () => {
    const api = {
      config: { agents: { list: [{ id: "alpha" }, { id: "beta", default: true }] } },
    } as never;
    expect(resolveAgentId(api)).toBe("beta");
  });

  it("falls back to first, then 'main'", () => {
    expect(resolveAgentId({ config: { agents: { list: [{ id: "first" }] } } } as never)).toBe("first");
    expect(resolveAgentId({ config: {} } as never)).toBe("main");
  });
});

describe("resolveModelRef", () => {
  it("splits the { primary } object form on the first slash", () => {
    const api = {
      config: { agents: { defaults: { model: { primary: "amazon-bedrock/global.anthropic.claude-sonnet-4-6" } } } },
    } as never;
    expect(resolveModelRef(api)).toEqual({
      provider: "amazon-bedrock",
      model: "global.anthropic.claude-sonnet-4-6",
    });
  });

  it("splits the bare-string form", () => {
    const api = { config: { agents: { defaults: { model: "openai/gpt-5.5" } } } } as never;
    expect(resolveModelRef(api)).toEqual({ provider: "openai", model: "gpt-5.5" });
  });

  it("returns null when no default model is configured", () => {
    expect(resolveModelRef({ config: {} } as never)).toBeNull();
    expect(resolveModelRef({ config: { agents: { defaults: {} } } } as never)).toBeNull();
  });

  it("returns null for a ref without a usable provider/model split", () => {
    expect(resolveModelRef({ config: { agents: { defaults: { model: "nopslash" } } } } as never)).toBeNull();
    expect(resolveModelRef({ config: { agents: { defaults: { model: "/leading" } } } } as never)).toBeNull();
    expect(resolveModelRef({ config: { agents: { defaults: { model: "trailing/" } } } } as never)).toBeNull();
  });
});

/** A fully-wired runtime.agent fake. */
function makeAgentRuntime(over: Record<string, unknown> = {}) {
  const runEmbeddedAgent = vi.fn().mockResolvedValue({ status: "ok" });
  const getSessionEntry = vi.fn().mockReturnValue({ sessionId: "sid-1", sessionFile: "f.jsonl" });
  const resolveSessionFilePath = vi.fn().mockReturnValue("/ws/sessions/f.jsonl");
  const resolveAgentWorkspaceDir = vi.fn().mockReturnValue("/ws");
  const resolveAgentDir = vi.fn().mockReturnValue("/ws/agent");
  const resolveAgentTimeoutMs = vi.fn().mockReturnValue(120000);
  return {
    runEmbeddedAgent,
    getSessionEntry,
    resolveSessionFilePath,
    resolveAgentWorkspaceDir,
    resolveAgentDir,
    resolveAgentTimeoutMs,
    agent: {
      runEmbeddedAgent,
      resolveAgentDir,
      resolveAgentWorkspaceDir,
      resolveAgentTimeoutMs,
      session: { getSessionEntry, resolveSessionFilePath },
      ...over,
    },
  };
}

describe("createWake", () => {
  const CFG_WITH_MODEL = {
    session: { scope: "global" },
    agents: { defaults: { model: { primary: "amazon-bedrock/claude-sonnet-4-6" } } },
  };

  it("runs an embedded agent turn with the wake text as the prompt + configured model", async () => {
    const r = makeAgentRuntime();
    const logger = makeLogger();
    const api = { config: CFG_WITH_MODEL, runtime: { agent: r.agent } } as never;

    const wake = createWake(api, logger);
    wake("[Chorus] You were @mentioned …", "chorus:mentioned:m1");
    await flush();

    expect(r.runEmbeddedAgent).toHaveBeenCalledOnce();
    const params = r.runEmbeddedAgent.mock.calls[0][0];
    expect(params.prompt).toBe("[Chorus] You were @mentioned …");
    expect(params.sessionKey).toBe("global");
    expect(params.sessionId).toBe("sid-1");
    expect(params.sessionFile).toBe("/ws/sessions/f.jsonl");
    expect(params.workspaceDir).toBe("/ws");
    expect(params.trigger).toBe("manual");
    expect(params.disableMessageTool).toBe(true);
    // The configured model is passed explicitly (else runEmbeddedAgent falls
    // back to DEFAULT_MODEL "gpt-5.5" → "Unknown model").
    expect(params.provider).toBe("amazon-bedrock");
    expect(params.model).toBe("claude-sonnet-4-6");
    expect(typeof params.timeoutMs).toBe("number");
    expect(typeof params.runId).toBe("string");
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("Waking agent via embedded run"));
  });

  it("warns and omits model override when no default model is configured", async () => {
    const r = makeAgentRuntime();
    const logger = makeLogger();
    const api = { config: { session: { scope: "global" } }, runtime: { agent: r.agent } } as never;

    createWake(api, logger)("hi", "ctx");
    await flush();

    const params = r.runEmbeddedAgent.mock.calls[0][0];
    expect(params.provider).toBeUndefined();
    expect(params.model).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("No agents.defaults.model configured"));
  });

  it("logs completion after the turn resolves", async () => {
    const r = makeAgentRuntime();
    const logger = makeLogger();
    const api = { config: { session: { scope: "global" } }, runtime: { agent: r.agent } } as never;

    createWake(api, logger)("hi", "ctx");
    await flush();

    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("Wake turn completed"));
  });

  it("uses a fresh sessionId when no existing session entry is found", async () => {
    const r = makeAgentRuntime();
    r.getSessionEntry.mockReturnValue(undefined);
    r.resolveSessionFilePath.mockReturnValue("/ws/sessions/new.jsonl");
    const logger = makeLogger();
    const api = { config: { session: { scope: "global" } }, runtime: { agent: r.agent } } as never;

    createWake(api, logger)("hi", "ctx-new");
    await flush();

    expect(r.runEmbeddedAgent).toHaveBeenCalledOnce();
    const params = r.runEmbeddedAgent.mock.calls[0][0];
    // fresh id is derived from the contextKey, not the (absent) entry
    expect(params.sessionId).toContain("ctx-new");
    expect(r.resolveSessionFilePath).toHaveBeenCalledWith(params.sessionId, undefined, { agentId: "main" });
  });

  it("DROPS the wake (warn, no throw) when no session key resolves", () => {
    const r = makeAgentRuntime();
    const logger = makeLogger();
    const api = { runtime: { agent: r.agent } } as never; // no config → no session key

    expect(() => createWake(api, logger)("hi", "ctx")).not.toThrow();
    expect(r.runEmbeddedAgent).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("could not resolve a main agent session key"),
    );
  });

  it("DROPS the wake when runEmbeddedAgent is unavailable on the host", () => {
    const logger = makeLogger();
    const api = { config: { session: { scope: "global" } }, runtime: { agent: {} } } as never;

    expect(() => createWake(api, logger)("hi", "ctx")).not.toThrow();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("runEmbeddedAgent (or a required session helper) is unavailable"),
    );
  });

  it("does not crash when runEmbeddedAgent rejects (e.g. a turn already in flight)", async () => {
    const r = makeAgentRuntime();
    r.runEmbeddedAgent.mockRejectedValue(new Error("reply run already active"));
    const logger = makeLogger();
    const api = { config: { session: { scope: "global" } }, runtime: { agent: r.agent } } as never;

    expect(() => createWake(api, logger)("hi", "ctx")).not.toThrow();
    await flush();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Wake turn failed"));
  });

  it("DROPS the wake when session resolution throws", () => {
    const r = makeAgentRuntime();
    r.getSessionEntry.mockImplementation(() => {
      throw new Error("store corrupt");
    });
    const logger = makeLogger();
    const api = { config: { session: { scope: "global" } }, runtime: { agent: r.agent } } as never;

    expect(() => createWake(api, logger)("hi", "ctx")).not.toThrow();
    expect(r.runEmbeddedAgent).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("session resolution failed"));
  });
});
