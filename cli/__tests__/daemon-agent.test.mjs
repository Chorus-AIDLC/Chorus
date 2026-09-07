// cli/__tests__/daemon-agent.test.mjs
// Covers daemon-agent-selection spec (MODIFIED for add-daemon-codex-backend, then
// add-daemon-kiro-backend): resolveAgentType now accepts claude-code, codex, AND
// kiro; unknown values are still rejected non-zero with no silent fallback;
// default stays claude-code.
import { describe, it, expect } from "vitest";
import { resolveAgentType, KNOWN_AGENTS, DEFAULT_AGENT, backendClientType, backendCli } from "../daemon-agent.mjs";

// A deps bundle whose config file is empty — pins the file layer to a no-op so
// the flag/env/default cases below never touch the operator's real daemon.json.
const NO_FILE = { readJson: () => null, loginPath: "/tmp/none.json" };

describe("resolveAgentType — known backends", () => {
  it("defaults to claude-code with no flag and no env", () => {
    expect(resolveAgentType({}, {}, NO_FILE)).toEqual({ ok: true, agent: "claude-code" });
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

  it("accepts dsh via --agent flag and CHORUS_AGENT env", () => {
    expect(resolveAgentType({ agent: "dsh" }, {})).toEqual({ ok: true, agent: "dsh" });
    expect(resolveAgentType({}, { CHORUS_AGENT: "dsh" })).toEqual({ ok: true, agent: "dsh" });
  });

  it("accepts pi via --agent flag, CHORUS_AGENT env, and daemon.json", () => {
    expect(resolveAgentType({ agent: "pi" }, {})).toEqual({ ok: true, agent: "pi" });
    expect(resolveAgentType({}, { CHORUS_AGENT: "pi" })).toEqual({ ok: true, agent: "pi" });
    expect(resolveAgentType({}, {}, { readJson: () => ({ agent: "pi" }), loginPath: "/x" })).toEqual({
      ok: true,
      agent: "pi",
    });
  });

  it("lists all backends in KNOWN_AGENTS and keeps claude-code default", () => {
    expect(KNOWN_AGENTS).toContain("claude-code");
    expect(KNOWN_AGENTS).toContain("codex");
    expect(KNOWN_AGENTS).toContain("kiro");
    expect(KNOWN_AGENTS).toContain("dsh");
    expect(KNOWN_AGENTS).toContain("pi");
    expect(DEFAULT_AGENT).toBe("claude-code");
  });

  it("accepts the non-wakeable 'offline' classification (KNOWN_AGENTS, flag/env/file), default unchanged", () => {
    // 'offline' is a valid agentType so an agents[] entry / --agent can carry it;
    // the daemon's fail-closed no-wake handling for it lives in spawner-select.
    expect(KNOWN_AGENTS).toContain("offline");
    expect(resolveAgentType({ agent: "offline" }, {})).toEqual({ ok: true, agent: "offline" });
    expect(resolveAgentType({}, { CHORUS_AGENT: "offline" })).toEqual({ ok: true, agent: "offline" });
    expect(resolveAgentType({}, {}, { readJson: () => ({ agent: "offline" }), loginPath: "/x" })).toEqual({
      ok: true,
      agent: "offline",
    });
    // Default is still claude-code — offline is never chosen implicitly.
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

  it("rejects an unknown `agent` in daemon.json", () => {
    const r = resolveAgentType({}, {}, { readJson: () => ({ agent: "gpt" }), loginPath: "/x" });
    expect(r.ok).toBe(false);
    expect(r.value).toBe("gpt");
    expect(r.error).toContain("codex");
  });
});

describe("resolveAgentType — daemon.json config-file layer", () => {
  it("reads `agent` from daemon.json when no flag and no env", () => {
    const r = resolveAgentType({}, {}, { readJson: () => ({ agent: "codex" }), loginPath: "/x" });
    expect(r).toEqual({ ok: true, agent: "codex" });
  });

  it("accepts kiro from daemon.json", () => {
    const r = resolveAgentType({}, {}, { readJson: () => ({ agent: "kiro" }), loginPath: "/x" });
    expect(r).toEqual({ ok: true, agent: "kiro" });
  });

  it("flag wins over daemon.json", () => {
    const r = resolveAgentType({ agent: "claude-code" }, {}, { readJson: () => ({ agent: "codex" }), loginPath: "/x" });
    expect(r).toEqual({ ok: true, agent: "claude-code" });
  });

  it("env wins over daemon.json", () => {
    const r = resolveAgentType({}, { CHORUS_AGENT: "kiro" }, { readJson: () => ({ agent: "codex" }), loginPath: "/x" });
    expect(r).toEqual({ ok: true, agent: "kiro" });
  });

  it("falls back to the default when daemon.json has no `agent` field", () => {
    const r = resolveAgentType({}, {}, { readJson: () => ({ cwds: ["/a"] }), loginPath: "/x" });
    expect(r).toEqual({ ok: true, agent: "claude-code" });
  });

  it("falls back to the default when daemon.json is missing / unreadable", () => {
    const r = resolveAgentType({}, {}, { readJson: () => null, loginPath: "/x" });
    expect(r).toEqual({ ok: true, agent: "claude-code" });
  });

  it("treats a blank `agent` string in daemon.json as absent (falls through to default)", () => {
    const r = resolveAgentType({}, {}, { readJson: () => ({ agent: "   " }), loginPath: "/x" });
    expect(r).toEqual({ ok: true, agent: "claude-code" });
  });

  it("does NOT read the config file when a flag is present (short-circuit)", () => {
    let reads = 0;
    const readJson = () => {
      reads += 1;
      return { agent: "codex" };
    };
    const r = resolveAgentType({ agent: "kiro" }, {}, { readJson, loginPath: "/x" });
    expect(r).toEqual({ ok: true, agent: "kiro" });
    expect(reads).toBe(0);
  });

  it("does NOT read the config file when the env var is present (short-circuit)", () => {
    let reads = 0;
    const readJson = () => {
      reads += 1;
      return { agent: "codex" };
    };
    const r = resolveAgentType({}, { CHORUS_AGENT: "kiro" }, { readJson, loginPath: "/x" });
    expect(r).toEqual({ ok: true, agent: "kiro" });
    expect(reads).toBe(0);
  });
});

describe("backendClientType — agentType → self-reported clientType", () => {
  it("maps codex → codex", () => {
    expect(backendClientType("codex")).toBe("codex");
  });
  it("maps kiro → kiro", () => {
    expect(backendClientType("kiro")).toBe("kiro");
  });
  it("maps dsh → dsh", () => {
    expect(backendClientType("dsh")).toBe("dsh");
  });
  it("maps pi → pi", () => {
    expect(backendClientType("pi")).toBe("pi");
  });
  it("maps claude-code → claude_code", () => {
    expect(backendClientType("claude-code")).toBe("claude_code");
  });
  it("maps offline → offline (NOT claude_code — never self-reports as wakeable)", () => {
    // offline must have an EXPLICIT case so it never falls through to the
    // claude_code default and presents as a wakeable connection. The value is
    // intentionally distinct from claude_code and outside the server's
    // DAEMON_CLIENT_TYPES allowlist (fail-closed if ever sent).
    expect(backendClientType("offline")).toBe("offline");
    expect(backendClientType("offline")).not.toBe("claude_code");
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
  it("maps dsh → dsh / CHORUS_DSH_PATH", () => {
    expect(backendCli("dsh")).toEqual({ name: "dsh", envVar: "CHORUS_DSH_PATH" });
  });
  it("maps pi → pi / CHORUS_PI_PATH", () => {
    expect(backendCli("pi")).toEqual({ name: "pi", envVar: "CHORUS_PI_PATH" });
  });
  it("maps offline → offline / CHORUS_AGENT (no real CLI, not mislabeled as claude)", () => {
    expect(backendCli("offline")).toEqual({ name: "offline", envVar: "CHORUS_AGENT" });
  });
  it("falls back to claude / CHORUS_CLAUDE_PATH for default/unknown", () => {
    expect(backendCli("claude-code")).toEqual({ name: "claude", envVar: "CHORUS_CLAUDE_PATH" });
    expect(backendCli(undefined)).toEqual({ name: "claude", envVar: "CHORUS_CLAUDE_PATH" });
  });
});
