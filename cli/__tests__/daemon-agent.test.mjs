// cli/__tests__/daemon-agent.test.mjs
// Covers daemon-agent-selection spec (MODIFIED for add-daemon-codex-backend):
// resolveAgentType now accepts BOTH claude-code and codex; unknown values are
// still rejected non-zero with no silent fallback; default stays claude-code.
import { describe, it, expect } from "vitest";
import { resolveAgentType, KNOWN_AGENTS, DEFAULT_AGENT } from "../daemon-agent.mjs";

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

  it("lists both backends in KNOWN_AGENTS and keeps claude-code default", () => {
    expect(KNOWN_AGENTS).toContain("claude-code");
    expect(KNOWN_AGENTS).toContain("codex");
    expect(DEFAULT_AGENT).toBe("claude-code");
  });
});

describe("resolveAgentType — unknown rejected (no silent fallback)", () => {
  it("rejects an unknown --agent value with a clear error naming accepted types", () => {
    const r = resolveAgentType({ agent: "gemini" }, {});
    expect(r.ok).toBe(false);
    expect(r.value).toBe("gemini");
    expect(r.error).toContain("codex");
    expect(r.error).toContain("claude-code");
  });

  it("rejects an unknown CHORUS_AGENT value", () => {
    const r = resolveAgentType({}, { CHORUS_AGENT: "nope" });
    expect(r.ok).toBe(false);
    expect(r.value).toBe("nope");
  });
});
