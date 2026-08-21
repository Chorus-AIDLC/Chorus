// cli/__tests__/daemon-multi-agent-config.test.mjs
// Unit tests for resolveAgentConfigs (daemon-multi-agent — N independent agents
// per daemon). Covers: flat back-compat (no agents[] → exactly one agent,
// behavior-equivalent to today), agents[] parsing, default inheritance,
// per-agent override, maxConcurrency default, and strict per-agent validation.
// All IO is injected — env:{} isolates from the real CHORUS_* environment.

import { describe, expect, it } from "vitest";
import { resolveAgentConfigs, DEFAULT_MAX_CONCURRENCY } from "../daemon-config.mjs";
import { DEFAULT_SIGINT_TIMEOUT_MS } from "../daemon-config.mjs";

const HOME = "/home/tester";

/** Build deps with a path-aware readJson: daemon.json → fileObj, everything else → null. */
function mkDeps(fileObj, extra = {}) {
  return {
    env: {},
    home: HOME,
    loginPath: "/cfg/daemon.json",
    settingsPath: "/cfg/settings.json",
    readJson: (p) => (p === "/cfg/daemon.json" ? fileObj : null),
    ...extra,
  };
}

describe("resolveAgentConfigs — flat back-compat (no agents[])", () => {
  it("synthesizes exactly one agent from flat login-file fields", () => {
    const out = resolveAgentConfigs({}, mkDeps({ url: "https://c.example.com", apiKey: "cho_flat" }));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      url: "https://c.example.com",
      apiKey: "cho_flat",
      agentType: "claude-code", // default
      permissionMode: "yolo", // default posture (no --chorus-only / CHORUS_YOLO=0)
      maxConcurrency: DEFAULT_MAX_CONCURRENCY,
      sigintTimeoutMs: DEFAULT_SIGINT_TIMEOUT_MS,
      label: "agent",
    });
    expect(out[0].cwds).toEqual([undefined]); // single connection at process cwd
    expect(Array.isArray(out[0].browseRoots)).toBe(true);
  });

  it("flags/env still resolve the single agent's fields", () => {
    const viaFlags = resolveAgentConfigs(
      { url: "https://flag.example.com", apiKey: "cho_flag", agent: "codex" },
      mkDeps(null),
    );
    expect(viaFlags[0]).toMatchObject({ url: "https://flag.example.com", apiKey: "cho_flag", agentType: "codex" });

    const viaEnv = resolveAgentConfigs(
      {},
      mkDeps(null, { env: { CHORUS_URL: "https://env.example.com", CHORUS_API_KEY: "cho_env" } }),
    );
    expect(viaEnv[0]).toMatchObject({ url: "https://env.example.com", apiKey: "cho_env" });
  });

  it("empty agents[] is treated as no agents[] (flat path)", () => {
    const out = resolveAgentConfigs({}, mkDeps({ url: "https://c", apiKey: "cho_x", agents: [] }));
    expect(out).toHaveLength(1);
    expect(out[0].label).toBe("agent");
  });

  it("throws (today's behavior) when no source yields a complete credential pair", () => {
    expect(() => resolveAgentConfigs({}, mkDeps(null))).toThrow(/Could not resolve Chorus credentials/);
  });

  it("propagates an invalid top-level agent type as a throw", () => {
    expect(() =>
      resolveAgentConfigs({}, mkDeps({ url: "https://c", apiKey: "cho_x", agent: "gpt" })),
    ).toThrow(/Unknown --agent "gpt"/);
  });

  it("honors --chorus-only for the default permission posture", () => {
    const out = resolveAgentConfigs({ chorusOnly: true }, mkDeps({ url: "https://c", apiKey: "cho_x" }));
    expect(out[0].permissionMode).toBe("chorus");
  });

  it("top-level maxConcurrency applies to the flat agent", () => {
    const out = resolveAgentConfigs({}, mkDeps({ url: "https://c", apiKey: "cho_x", maxConcurrency: 7 }));
    expect(out[0].maxConcurrency).toBe(7);
  });
});

describe("resolveAgentConfigs — agents[] default inheritance", () => {
  it("each agent inherits omitted fields from the top-level defaults", () => {
    const file = {
      url: "https://top.example.com",
      sigintTimeoutMs: 3000,
      maxConcurrency: 6,
      agents: [{ apiKey: "cho_a" }, { apiKey: "cho_b", cwds: ["/srv/b"] }],
    };
    const out = resolveAgentConfigs({}, mkDeps(file));
    expect(out).toHaveLength(2);
    // Agent 0 inherits top-level url, default agentType, top-level sigint + maxConcurrency.
    expect(out[0]).toMatchObject({
      url: "https://top.example.com",
      apiKey: "cho_a",
      agentType: "claude-code",
      permissionMode: "yolo",
      maxConcurrency: 6,
      sigintTimeoutMs: 3000,
      label: "agents[0]",
    });
    // Agent 1 has its own cwds; still inherits url + defaults.
    expect(out[1]).toMatchObject({ url: "https://top.example.com", apiKey: "cho_b", label: "agents[1]" });
    expect(out[1].cwds).toEqual(["/srv/b"]);
  });

  it("agent without cwds inherits the top-level default cwd set", () => {
    const file = { url: "https://t", cwds: ["/srv/shared"], agents: [{ apiKey: "cho_a" }] };
    const out = resolveAgentConfigs({}, mkDeps(file));
    expect(out[0].cwds).toEqual(["/srv/shared"]);
  });

  it("maxConcurrency defaults to 4 when neither agent nor top-level sets it", () => {
    const file = { url: "https://t", agents: [{ apiKey: "cho_a" }] };
    const out = resolveAgentConfigs({}, mkDeps(file));
    expect(out[0].maxConcurrency).toBe(DEFAULT_MAX_CONCURRENCY);
  });

  it("uses agent.name / agent.label for the diagnostic label when present", () => {
    const file = { url: "https://t", agents: [{ apiKey: "cho_a", name: "pm-bot" }, { apiKey: "cho_b", label: "dev-bot" }] };
    const out = resolveAgentConfigs({}, mkDeps(file));
    expect(out[0].label).toBe("pm-bot");
    expect(out[1].label).toBe("dev-bot");
  });
});

describe("resolveAgentConfigs — per-agent overrides", () => {
  it("per-agent fields win over top-level defaults", () => {
    const file = {
      url: "https://top",
      maxConcurrency: 4,
      agents: [
        {
          apiKey: "cho_a",
          url: "https://agentA",
          agentType: "kiro",
          permissionMode: "chorus",
          maxConcurrency: 8,
          sigintTimeoutMs: 2500,
          cwds: ["/srv/a1", "/srv/a2"],
          browseRoots: ["/srv"],
        },
      ],
    };
    const out = resolveAgentConfigs({}, mkDeps(file));
    expect(out[0]).toMatchObject({
      url: "https://agentA",
      apiKey: "cho_a",
      agentType: "kiro",
      permissionMode: "chorus",
      maxConcurrency: 8,
      sigintTimeoutMs: 2500,
    });
    expect(out[0].cwds).toEqual(["/srv/a1", "/srv/a2"]);
    expect(out[0].browseRoots).toEqual(["/srv"]);
  });

  it("an agent with a blank cwds list degrades to [undefined] (process cwd)", () => {
    const file = { url: "https://t", agents: [{ apiKey: "cho_a", cwds: ["", "   "] }] };
    const out = resolveAgentConfigs({}, mkDeps(file));
    expect(out[0].cwds).toEqual([undefined]);
  });

  it("carries daemonWake per agent as a pass-through (true / false / absent→undefined)", () => {
    const file = {
      url: "https://t",
      agents: [
        { apiKey: "cho_on", agentType: "kiro", daemonWake: true },
        { apiKey: "cho_off", agentType: "kiro", daemonWake: false },
        { apiKey: "cho_abs", agentType: "kiro" }, // no daemonWake ⇒ undefined (woken)
      ],
    };
    const out = resolveAgentConfigs({}, mkDeps(file));
    expect(out[0].daemonWake).toBe(true);
    expect(out[1].daemonWake).toBe(false);
    expect(out[2].daemonWake).toBeUndefined();
  });

  it("mixed backends resolve independently in one daemon", () => {
    const file = {
      url: "https://t",
      agents: [
        { apiKey: "cho_claude", agentType: "claude-code" },
        { apiKey: "cho_kiro", agentType: "kiro" },
      ],
    };
    const out = resolveAgentConfigs({}, mkDeps(file));
    expect(out.map((a) => a.agentType)).toEqual(["claude-code", "kiro"]);
  });
});

describe("resolveAgentConfigs — strict per-agent validation", () => {
  it("throws naming the agent when apiKey is missing and no default exists", () => {
    const file = { url: "https://t", agents: [{ apiKey: "cho_ok" }, { cwds: ["/srv/x"] }] };
    expect(() => resolveAgentConfigs({}, mkDeps(file))).toThrow(/agents\[1\]: missing apiKey/);
  });

  it("inherits the top-level apiKey default when an agent omits it", () => {
    const file = { url: "https://t", apiKey: "cho_default", agents: [{ cwds: ["/srv/x"] }] };
    const out = resolveAgentConfigs({}, mkDeps(file));
    expect(out[0].apiKey).toBe("cho_default");
  });

  it("throws naming the agent when url is unresolvable", () => {
    const file = { agents: [{ apiKey: "cho_a" }] }; // no top-level url, no per-agent url
    expect(() => resolveAgentConfigs({}, mkDeps(file))).toThrow(/agents\[0\]: missing\/unresolvable url/);
  });

  it("throws on an unknown per-agent agentType", () => {
    const file = { url: "https://t", agents: [{ apiKey: "cho_a", agentType: "gemini" }] };
    expect(() => resolveAgentConfigs({}, mkDeps(file))).toThrow(/agents\[0\]: unknown agentType "gemini"/);
  });

  it("throws on an invalid per-agent permissionMode", () => {
    const file = { url: "https://t", agents: [{ apiKey: "cho_a", permissionMode: "loose" }] };
    expect(() => resolveAgentConfigs({}, mkDeps(file))).toThrow(/agents\[0\]: invalid permissionMode "loose"/);
  });

  it("throws when an agent omits agentType and the top-level default is invalid", () => {
    const file = { url: "https://t", agent: "gpt", agents: [{ apiKey: "cho_a" }] };
    expect(() => resolveAgentConfigs({}, mkDeps(file))).toThrow(/top-level agent default is invalid/);
  });
});
