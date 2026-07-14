// cli/__tests__/daemon-agent.test.mjs
// Covers daemon-agent-selection spec (MODIFIED for add-daemon-codex-backend, then
// add-daemon-kiro-backend): resolveAgentType now accepts claude-code, codex, AND
// kiro; unknown values are still rejected non-zero with no silent fallback;
// default stays claude-code.
import { describe, it, expect } from "vitest";
import { resolveAgentType, KNOWN_AGENTS, DEFAULT_AGENT, backendClientType, backendCli } from "../daemon-agent.mjs";

describe("resolveAgentType — known backends", () => {
  it("defaults to claude-code with no flag and no env", () => {
    expect(resolveAgentType({}, {})).toEqual({ ok: true, agent: "claude-code" });
  });

  it("accepts explicit claude-code (flag and env)", () => {
    expect(resolveAgentType({ agent: "claude-code" }, {})).toEqual({ ok: true, agent: "claude-code" });
    expect(resolveAgentType({}, { CHORUS_AGENT: "claude-code" })).toEqual({ ok: true, agent: "claude-code" });
  });

  it("accepts codex via --agent flag", () => {
    expect(resolveAgentType({ agent: "codex" }, {})).toEqual({ ok: true, agent: "codex" });
  });

  it("accepts codex via CHORUS_AGENT env", () => {
    expect(resolveAgentType({}, { CHORUS_AGENT: "codex" })).toEqual({ ok: true, agent: "codex" });
  });

  it("flag wins over env (codex flag overrides claude-code env)", () => {
    expect(resolveAgentType({ agent: "codex" }, { CHORUS_AGENT: "claude-code" })).toEqual({
      ok: true,
      agent: "codex",
    });
  });

  it("accepts kiro via --agent flag", () => {
    expect(resolveAgentType({ agent: "kiro" }, {})).toEqual({ ok: true, agent: "kiro" });
  });

  it("accepts kiro via CHORUS_AGENT env", () => {
    expect(resolveAgentType({}, { CHORUS_AGENT: "kiro" })).toEqual({ ok: true, agent: "kiro" });
  });

  it("lists all backends in KNOWN_AGENTS and keeps claude-code default", () => {
    expect(KNOWN_AGENTS).toContain("claude-code");
    expect(KNOWN_AGENTS).toContain("codex");
    expect(KNOWN_AGENTS).toContain("kiro");
    expect(DEFAULT_AGENT).toBe("claude-code");
  });
});

describe("resolveAgentType — unknown rejected (no silent fallback)", () => {
  it("rejects an unknown --agent value with a clear error naming accepted types", () => {
    const r = resolveAgentType({ agent: "gemini" }, {});
    expect(r.ok).toBe(false);
    expect(r.value).toBe("gemini");
    expect(r.error).toContain("codex");
    expect(r.error).toContain("kiro");
    expect(r.error).toContain("claude-code");
  });

  it("rejects an unknown CHORUS_AGENT value", () => {
    const r = resolveAgentType({}, { CHORUS_AGENT: "nope" });
    expect(r.ok).toBe(false);
    expect(r.value).toBe("nope");
  });
});

describe("backendClientType — agentType → self-reported clientType", () => {
  it("maps codex → codex", () => {
    expect(backendClientType("codex")).toBe("codex");
  });
  it("maps kiro → kiro", () => {
    expect(backendClientType("kiro")).toBe("kiro");
  });
  it("maps claude-code → claude_code", () => {
    expect(backendClientType("claude-code")).toBe("claude_code");
  });
  it("falls back to claude_code for unknown/undefined", () => {
    expect(backendClientType(undefined)).toBe("claude_code");
    expect(backendClientType("whatever")).toBe("claude_code");
  });
});

describe("backendCli — agentType → executable descriptor", () => {
  it("maps codex → codex / CHORUS_CODEX_PATH", () => {
    expect(backendCli("codex")).toEqual({ name: "codex", envVar: "CHORUS_CODEX_PATH" });
  });
  it("maps kiro → kiro-cli / CHORUS_KIRO_PATH", () => {
    expect(backendCli("kiro")).toEqual({ name: "kiro-cli", envVar: "CHORUS_KIRO_PATH" });
  });
  it("falls back to claude / CHORUS_CLAUDE_PATH for default/unknown", () => {
    expect(backendCli("claude-code")).toEqual({ name: "claude", envVar: "CHORUS_CLAUDE_PATH" });
    expect(backendCli(undefined)).toEqual({ name: "claude", envVar: "CHORUS_CLAUDE_PATH" });
  });
});
