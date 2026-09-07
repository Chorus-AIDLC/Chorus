// cli/__tests__/daemon-banner.test.mjs
// Covers daemon-startup-output spec "Boxed startup banner" + daemon-agent-selection.
import { describe, it, expect } from "vitest";
import { formatBanner, bannerRows } from "../daemon-banner.mjs";
import { resolveAgentType, KNOWN_AGENTS, DEFAULT_AGENT, backendCli } from "../daemon-agent.mjs";

const INFO = {
  version: "0.11.0",
  url: "https://chorus.example",
  agentName: "Daemon Bot",
  agentUuid: "agent-123",
  permissionMode: "yolo",
  credentialSource: "login-file",
  agentType: "claude-code",
  cliPath: "/usr/bin/claude",
  connection: "connecting…",
};

const SECRET = "cho_supersecretkey";

describe("formatBanner — content", () => {
  it("shows all required fields in both TTY and non-TTY modes", () => {
    for (const isTTY of [true, false]) {
      const out = formatBanner(INFO, { isTTY });
      expect(out).toContain("0.11.0");
      expect(out).toContain("https://chorus.example");
      expect(out).toContain("Daemon Bot");
      expect(out).toContain("agent-123");
      expect(out).toContain("claude-code");
      expect(out).toContain("login-file");
      expect(out).toContain("/usr/bin/claude");
      expect(out.toLowerCase()).toContain("daemon");
    }
  });

  it("labels the CLI row for the SELECTED backend — claude-code → 'claude CLI'", () => {
    const out = formatBanner(INFO, { isTTY: false });
    expect(out).toContain("claude CLI");
    expect(out).not.toContain("codex CLI");
  });

  it("labels the CLI row 'codex CLI' and shows the codex path when agentType is codex", () => {
    const out = formatBanner(
      { ...INFO, agentType: "codex", cliPath: "/home/u/.nvm/bin/codex" },
      { isTTY: false }
    );
    expect(out).toContain("codex CLI");
    expect(out).toContain("/home/u/.nvm/bin/codex");
    // must NOT mislabel a codex run as claude
    expect(out).not.toMatch(/claude CLI/);
  });

  it("labels the dsh runtime and its path override", () => {
    const out = formatBanner(
      { ...INFO, agentType: "dsh", cliPath: null },
      { isTTY: false },
    );
    expect(out).toContain("dsh CLI");
    expect(out).toContain("CHORUS_DSH_PATH");
    expect(out).not.toMatch(/claude CLI/);
  });

  it("highlights yolo permission mode", () => {
    const out = formatBanner(INFO, { isTTY: false });
    expect(out).toMatch(/YOLO/);
  });

  it("never prints the raw API key (no masking needed — key is simply absent)", () => {
    const out = formatBanner({ ...INFO, credentialSource: "env" }, { isTTY: true });
    expect(out).not.toContain(SECRET);
  });

  it("shows a clear not-found message when claude is missing", () => {
    const out = formatBanner({ ...INFO, cliPath: null }, { isTTY: false });
    expect(out).toMatch(/NOT FOUND/i);
    expect(out).toContain("CHORUS_CLAUDE_PATH");
  });

  it("not-found message names the CODEX override when the codex backend is missing", () => {
    const out = formatBanner(
      { ...INFO, agentType: "codex", cliPath: null },
      { isTTY: false }
    );
    expect(out).toMatch(/NOT FOUND/i);
    expect(out).toContain("CHORUS_CODEX_PATH");
    expect(out).not.toContain("CHORUS_CLAUDE_PATH");
  });
});

describe("backendCli — per-backend CLI descriptor", () => {
  it("claude-code → claude binary + CHORUS_CLAUDE_PATH override", () => {
    expect(backendCli("claude-code")).toEqual({ name: "claude", envVar: "CHORUS_CLAUDE_PATH" });
  });
  it("codex → codex binary + CHORUS_CODEX_PATH override", () => {
    expect(backendCli("codex")).toEqual({ name: "codex", envVar: "CHORUS_CODEX_PATH" });
  });
  it("unknown/undefined falls back to the claude descriptor (default backend)", () => {
    expect(backendCli(undefined)).toEqual({ name: "claude", envVar: "CHORUS_CLAUDE_PATH" });
  });
});

describe("formatBanner — rendering modes", () => {
  it("non-TTY output has no box-drawing characters", () => {
    const out = formatBanner(INFO, { isTTY: false });
    expect(out).not.toMatch(/[┌┐└┘├┤│─]/);
  });

  it("TTY output draws a box and does not throw", () => {
    const out = formatBanner(INFO, { isTTY: true });
    expect(out).toMatch(/[┌┐└┘│─]/);
  });

  it("does not throw on a missing optional connection field", () => {
    const noConn = { ...INFO };
    delete noConn.connection;
    expect(() => formatBanner(noConn, { isTTY: true })).not.toThrow();
    expect(formatBanner(noConn, { isTTY: false })).toContain("connecting…");
  });
});

describe("bannerRows", () => {
  it("emits chorus-only wording for the restricted mode", () => {
    const rows = bannerRows({ ...INFO, permissionMode: "chorus" });
    const perm = rows.find(([k]) => k === "Permission")[1];
    expect(perm).toMatch(/chorus-only/);
  });

  it("shows the daemon.json config path when one is provided", () => {
    const rows = bannerRows({ ...INFO, configPath: "/home/u/.chorus/daemon.json", configExists: true });
    const config = rows.find(([k]) => k === "Config")[1];
    expect(config).toBe("/home/u/.chorus/daemon.json");
  });

  it("flags an absent config file so the operator knows it fell back to flags/env", () => {
    const rows = bannerRows({ ...INFO, configPath: "/home/u/.chorus/daemon.json", configExists: false });
    const config = rows.find(([k]) => k === "Config")[1];
    expect(config).toContain("/home/u/.chorus/daemon.json");
    expect(config).toMatch(/not found/i);
  });

  it("omits the Config row entirely when no path is known", () => {
    const rows = bannerRows(INFO);
    expect(rows.find(([k]) => k === "Config")).toBeUndefined();
  });
});

describe("resolveAgentType", () => {
  it("defaults to claude-code", () => {
    expect(resolveAgentType({}, {}, { readJson: () => null })).toEqual({
      ok: true,
      agent: "claude-code",
    });
    expect(DEFAULT_AGENT).toBe("claude-code");
    expect(KNOWN_AGENTS).toContain("claude-code");
  });

  it("accepts an explicit known agent via flag or env (flag wins)", () => {
    expect(resolveAgentType({ agent: "claude-code" }, {})).toEqual({ ok: true, agent: "claude-code" });
    expect(resolveAgentType({}, { CHORUS_AGENT: "claude-code" })).toEqual({ ok: true, agent: "claude-code" });
    // flag precedence over env
    expect(resolveAgentType({ agent: "claude-code" }, { CHORUS_AGENT: "bogus" }).ok).toBe(true);
  });

  it("accepts codex as a known backend", () => {
    expect(resolveAgentType({ agent: "codex" }, {})).toEqual({ ok: true, agent: "codex" });
    expect(KNOWN_AGENTS).toContain("codex");
  });

  it("rejects an unknown agent with a non-silent actionable error", () => {
    const r = resolveAgentType({ agent: "gemini" }, {});
    expect(r.ok).toBe(false);
    expect(r.value).toBe("gemini");
    expect(r.error).toContain("codex");
    expect(r.error).toContain("claude-code");
  });

  it("rejects an unknown CHORUS_AGENT env value too", () => {
    expect(resolveAgentType({}, { CHORUS_AGENT: "gpt" }).ok).toBe(false);
  });
});
