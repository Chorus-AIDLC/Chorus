// cli/__tests__/login-add-agent.test.mjs
// T4 — registration UX: `chorus login --add` + install-wizard multi-add.
// Covers appendAgentConfig (empty/flat-migrate/append/duplicate), the runLogin
// --add branch (validate-before-write, invalid/duplicate no-write), and the
// install wizard loop adding more than one agent in a run.

import { describe, it, expect, vi } from "vitest";
import { appendAgentConfig, runLogin } from "../login.mjs";
import { resolveInstallCredentials } from "../daemon-install-config.mjs";

/** Injected IO for updateDaemonConfig: read returns fileContent (or throws when null). */
function mkIO(fileContent) {
  const written = {};
  const io = {
    path: "/cfg/daemon.json",
    read: () => {
      if (fileContent === null) throw new Error("ENOENT");
      return fileContent;
    },
    write: (p, c) => {
      written.path = p;
      written.content = c;
    },
    mkdir: () => {},
    rename: (from, to) => {
      written.renamedTo = to;
    },
  };
  return { io, written };
}

const parseWritten = (written) => JSON.parse(written.content);

describe("appendAgentConfig", () => {
  it("empty/missing file → agents:[newAgent] at index 0", () => {
    const { io, written } = mkIO(null);
    const res = appendAgentConfig({ url: "u1", apiKey: "k1" }, io);
    expect(res.ok).toBe(true);
    expect(res.index).toBe(0);
    expect(parseWritten(written).agents).toEqual([{ url: "u1", apiKey: "k1" }]);
  });

  it("flat single-agent file → migrates flat into agents[0]; new key is agents[1]", () => {
    const flat = JSON.stringify({ url: "u0", apiKey: "k0", agent: "kiro", cwds: ["/a"], agentName: "Bot0", agentUuid: "id0" });
    const { io, written } = mkIO(flat);
    const res = appendAgentConfig({ url: "u1", apiKey: "k1", agentName: "Bot1", agentUuid: "id1" }, io);
    expect(res.ok).toBe(true);
    expect(res.index).toBe(1);
    const agents = parseWritten(written).agents;
    expect(agents).toHaveLength(2);
    // agents[0] carries the migrated flat fields (agent→agentType, cwds, identity)
    expect(agents[0]).toMatchObject({ url: "u0", apiKey: "k0", agentType: "kiro", cwds: ["/a"] });
    expect(agents[1]).toMatchObject({ url: "u1", apiKey: "k1" });
  });

  it("existing agents[] → appends without altering existing agents", () => {
    const file = JSON.stringify({ url: "top", agents: [{ url: "u0", apiKey: "k0" }] });
    const { io, written } = mkIO(file);
    const res = appendAgentConfig({ url: "u1", apiKey: "k1" }, io);
    expect(res.ok).toBe(true);
    const agents = parseWritten(written).agents;
    expect(agents[0]).toEqual({ url: "u0", apiKey: "k0" }); // unchanged
    expect(agents[1]).toEqual({ url: "u1", apiKey: "k1" });
  });

  it("duplicate apiKey (flat) → not written", () => {
    const { io, written } = mkIO(JSON.stringify({ url: "u0", apiKey: "dup" }));
    const res = appendAgentConfig({ url: "u1", apiKey: "dup" }, io);
    expect(res.ok).toBe(false);
    expect(written.content).toBeUndefined();
  });

  it("duplicate apiKey (in agents[]) → not written", () => {
    const { io, written } = mkIO(JSON.stringify({ agents: [{ url: "u0", apiKey: "dup" }] }));
    const res = appendAgentConfig({ url: "u1", apiKey: "dup" }, io);
    expect(res.ok).toBe(false);
    expect(written.content).toBeUndefined();
  });
});

describe("runLogin --add", () => {
  const baseDeps = (over = {}) => ({
    prompt: async () => "",
    log: () => {},
    errLog: () => {},
    ...over,
  });

  it("appends a validated agent and returns 0", async () => {
    const appendAgent = vi.fn(() => ({ ok: true, path: "/cfg/daemon.json", agents: [{}, {}], index: 1 }));
    const rc = await runLogin(
      { url: "u1", apiKey: "k1", agent: "kiro", add: true },
      baseDeps({ validate: async () => ({ name: "Bot", uuid: "id1" }), appendAgent }),
    );
    expect(rc).toBe(0);
    expect(appendAgent).toHaveBeenCalledWith({ url: "u1", apiKey: "k1", agentUuid: "id1", agentName: "Bot", agentType: "kiro" });
  });

  it("invalid key → does NOT append, returns 1", async () => {
    const appendAgent = vi.fn();
    const rc = await runLogin(
      { url: "u1", apiKey: "bad", add: true },
      baseDeps({ validate: async () => { throw new Error("401"); }, appendAgent }),
    );
    expect(rc).toBe(1);
    expect(appendAgent).not.toHaveBeenCalled();
  });

  it("duplicate → returns 1 (append refused)", async () => {
    const appendAgent = vi.fn(() => ({ ok: false, reason: "duplicate" }));
    const rc = await runLogin(
      { url: "u1", apiKey: "k1", add: true },
      baseDeps({ validate: async () => ({ name: "Bot", uuid: "id1" }), appendAgent }),
    );
    expect(rc).toBe(1);
  });
});

describe("runLogin — agent backend capture", () => {
  const baseDeps = (over = {}) => ({
    validate: async () => ({ name: "Bot", uuid: "id1" }),
    prompt: async () => "",
    log: () => {},
    errLog: () => {},
    ...over,
  });

  it("--add: a TTY menu pick sets agentType on the appended entry", async () => {
    const appendAgent = vi.fn(() => ({ ok: true, path: "/cfg/daemon.json", agents: [{}, {}], index: 1 }));
    const rc = await runLogin(
      { url: "u1", apiKey: "k1", add: true },
      baseDeps({ appendAgent, isTTY: true, promptBackend: async () => "codex" }),
    );
    expect(rc).toBe(0);
    expect(appendAgent).toHaveBeenCalledWith({
      url: "u1", apiKey: "k1", agentUuid: "id1", agentName: "Bot", agentType: "codex",
    });
  });

  it("--add: Enter at the menu (undefined) appends WITHOUT an agentType key", async () => {
    const appendAgent = vi.fn(() => ({ ok: true, path: "/cfg/daemon.json", agents: [{}, {}], index: 1 }));
    const rc = await runLogin(
      { url: "u1", apiKey: "k1", add: true },
      baseDeps({ appendAgent, isTTY: true, promptBackend: async () => undefined }),
    );
    expect(rc).toBe(0);
    expect(appendAgent).toHaveBeenCalledWith({
      url: "u1", apiKey: "k1", agentUuid: "id1", agentName: "Bot",
    });
  });

  it("single-agent: --agent kiro writes the top-level `agent` field", async () => {
    const written = [];
    const write = vi.fn((data) => { written.push(data); return "/p"; });
    const rc = await runLogin(
      { url: "u1", apiKey: "k1", agent: "kiro" },
      baseDeps({ write }),
    );
    expect(rc).toBe(0);
    expect(written).toEqual([
      { url: "u1", apiKey: "k1", agentUuid: "id1", agentName: "Bot", agent: "kiro" },
    ]);
  });

  it("single-agent: no choice (undefined) writes NO top-level `agent` key", async () => {
    const written = [];
    const write = vi.fn((data) => { written.push(data); return "/p"; });
    const rc = await runLogin(
      { url: "u1", apiKey: "k1" },
      baseDeps({ write, isTTY: true, promptBackend: async () => undefined }),
    );
    expect(rc).toBe(0);
    expect(written).toEqual([
      { url: "u1", apiKey: "k1", agentUuid: "id1", agentName: "Bot" },
    ]);
  });

  it("single-agent non-TTY with no --agent: no menu, no block, no backend key", async () => {
    // Uses the REAL promptAgentBackend (not injected). isTTY:false must make it
    // return immediately without touching `prompt`, and write no `agent` key.
    const written = [];
    const write = vi.fn((data) => { written.push(data); return "/p"; });
    const prompt = vi.fn(async () => { throw new Error("prompt must not be called on non-TTY"); });
    const rc = await runLogin(
      { url: "u1", apiKey: "k1" },
      baseDeps({ write, prompt, isTTY: false }),
    );
    expect(rc).toBe(0);
    expect(written).toEqual([
      { url: "u1", apiKey: "k1", agentUuid: "id1", agentName: "Bot" },
    ]);
  });
});

describe("install wizard — multi-add loop", () => {
  it("adds a second agent when the operator answers yes once (Enter at backend = inherit)", async () => {
    // prompt sequence: "add another?"→y, url, key, backend-menu→Enter(inherit), "add another?"→n
    const answers = ["y", "u2", "k2", "", "n"];
    const prompt = vi.fn(async () => answers.shift() ?? "");
    const appendAgent = vi.fn(() => ({ ok: true, agents: [{}, {}], index: 1 }));
    const res = await resolveInstallCredentials(
      { url: "u1", apiKey: "k1", add: true },
      {},
      {
        isTTY: true,
        skip: false,
        resolve: () => ({ url: "u1", apiKey: "k1", source: "flag" }),
        validate: async () => ({ uuid: "id", name: "Bot" }),
        writeConfig: () => {},
        prompt,
        appendAgent,
        log: () => {},
        errLog: () => {},
      },
    );
    expect(res.ok).toBe(true);
    expect(appendAgent).toHaveBeenCalledTimes(1);
    // Enter at the backend menu → no agentType (entry inherits the daemon default).
    expect(appendAgent).toHaveBeenCalledWith({ url: "u2", apiKey: "k2", agentUuid: "id", agentName: "Bot" });
  });

  it("install loop: a backend menu pick sets agentType on the appended entry", async () => {
    // "add another?"→y, url, key, backend-menu→"2" (Codex), "add another?"→n
    const answers = ["y", "u2", "k2", "2", "n"];
    const prompt = vi.fn(async () => answers.shift() ?? "");
    const appendAgent = vi.fn(() => ({ ok: true, agents: [{}, {}], index: 1 }));
    const res = await resolveInstallCredentials(
      { url: "u1", apiKey: "k1", add: true },
      {},
      {
        isTTY: true,
        skip: false,
        resolve: () => ({ url: "u1", apiKey: "k1", source: "flag" }),
        validate: async () => ({ uuid: "id", name: "Bot" }),
        writeConfig: () => {},
        prompt,
        appendAgent,
        log: () => {},
        errLog: () => {},
      },
    );
    expect(res.ok).toBe(true);
    expect(appendAgent).toHaveBeenCalledWith({
      url: "u2", apiKey: "k2", agentUuid: "id", agentName: "Bot", agentType: "codex",
    });
  });

  it("install loop: --agent is honored (no backend menu prompt)", async () => {
    // With --agent kiro, the loop must NOT ask a backend question — sequence is
    // "add another?"→y, url, key, "add another?"→n (no backend slot consumed).
    const answers = ["y", "u2", "k2", "n"];
    const prompt = vi.fn(async () => answers.shift() ?? "");
    const appendAgent = vi.fn(() => ({ ok: true, agents: [{}, {}], index: 1 }));
    const res = await resolveInstallCredentials(
      { url: "u1", apiKey: "k1", agent: "kiro", add: true },
      {},
      {
        isTTY: true,
        skip: false,
        resolve: () => ({ url: "u1", apiKey: "k1", source: "flag" }),
        validate: async () => ({ uuid: "id", name: "Bot" }),
        writeConfig: () => {},
        prompt,
        appendAgent,
        log: () => {},
        errLog: () => {},
      },
    );
    expect(res.ok).toBe(true);
    expect(appendAgent).toHaveBeenCalledTimes(1);
    expect(appendAgent).toHaveBeenCalledWith({
      url: "u2", apiKey: "k2", agentUuid: "id", agentName: "Bot", agentType: "kiro",
    });
  });

  it("non-TTY / skip run never prompts for extra agents (single-agent install unchanged)", async () => {
    const prompt = vi.fn(async () => "y");
    const appendAgent = vi.fn();
    const res = await resolveInstallCredentials(
      { url: "u1", apiKey: "k1" },
      {},
      {
        isTTY: false,
        skip: true,
        resolve: () => ({ url: "u1", apiKey: "k1", source: "flag" }),
        validate: async () => ({ uuid: "id", name: "Bot" }),
        writeConfig: () => {},
        prompt,
        appendAgent,
        log: () => {},
        errLog: () => {},
      },
    );
    expect(res.ok).toBe(true);
    expect(appendAgent).not.toHaveBeenCalled();
  });
});
