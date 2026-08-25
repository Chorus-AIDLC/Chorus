// cli/__tests__/mcp-credentials.test.mjs
// Covers cli-mcp-client spec "Credential resolution and multi-agent selection".
import { describe, it, expect } from "vitest";
import { resolveMcpCredentials } from "../credentials.mjs";

const LOGIN_PATH = "/home/u/.chorus/daemon.json";
const SETTINGS_PATH = "/home/u/.claude/settings.json";

/** Build deps with a fake filesystem keyed by path. */
function deps({ env = {}, files = {} } = {}) {
  return {
    env,
    loginPath: LOGIN_PATH,
    settingsPath: SETTINGS_PATH,
    readJson: (p) => (p in files ? files[p] : null),
  };
}

describe("resolveMcpCredentials — explicit flag/env win", () => {
  it("flag pair wins over env and agents[]", () => {
    const r = resolveMcpCredentials(
      { url: "https://flag", apiKey: "cho_flag" },
      deps({
        env: { CHORUS_URL: "https://env", CHORUS_API_KEY: "cho_env" },
        files: { [LOGIN_PATH]: { agents: [{ label: "a", url: "https://a", apiKey: "cho_a" }] } },
      }),
    );
    expect(r).toEqual({ url: "https://flag", apiKey: "cho_flag", label: "flag" });
  });

  it("env pair wins over agents[] and does not require --agent", () => {
    const r = resolveMcpCredentials(
      {},
      deps({
        env: { CHORUS_URL: "https://env", CHORUS_API_KEY: "cho_env" },
        files: {
          [LOGIN_PATH]: {
            agents: [
              { label: "a", url: "https://a", apiKey: "cho_a" },
              { label: "b", url: "https://b", apiKey: "cho_b" },
            ],
          },
        },
      }),
    );
    expect(r).toEqual({ url: "https://env", apiKey: "cho_env", label: "env" });
  });

  it("explicit --agent label rides along on the flag/env path as the diagnostic label", () => {
    const r = resolveMcpCredentials(
      { agent: "worker-b" },
      deps({ env: { CHORUS_URL: "https://env", CHORUS_API_KEY: "cho_env" } }),
    );
    expect(r).toEqual({ url: "https://env", apiKey: "cho_env", label: "worker-b" });
  });
});

describe("resolveMcpCredentials — multi-agent selection", () => {
  const twoAgents = {
    [LOGIN_PATH]: {
      agents: [
        { label: "worker-a", url: "https://a", apiKey: "cho_a" },
        { name: "worker-b", url: "https://b", apiKey: "cho_b" },
      ],
    },
  };

  it("--agent selects the matching entry (by label or name)", () => {
    expect(resolveMcpCredentials({ agent: "worker-a" }, deps({ files: twoAgents }))).toEqual({
      url: "https://a",
      apiKey: "cho_a",
      label: "worker-a",
    });
    expect(resolveMcpCredentials({ agent: "worker-b" }, deps({ files: twoAgents }))).toEqual({
      url: "https://b",
      apiKey: "cho_b",
      label: "worker-b",
    });
  });

  it("ambiguous multi-agent with no --agent throws listing labels", () => {
    expect(() => resolveMcpCredentials({}, deps({ files: twoAgents }))).toThrow(
      /Multiple agents.*worker-a, worker-b.*--agent/s,
    );
  });

  it("a missing --agent label throws listing available labels", () => {
    expect(() => resolveMcpCredentials({ agent: "ghost" }, deps({ files: twoAgents }))).toThrow(
      /--agent "ghost" not found.*worker-a, worker-b/s,
    );
  });

  it("single agent + no --agent resolves without asking", () => {
    const r = resolveMcpCredentials(
      {},
      deps({ files: { [LOGIN_PATH]: { agents: [{ label: "solo", url: "https://s", apiKey: "cho_s" }] } } }),
    );
    expect(r).toEqual({ url: "https://s", apiKey: "cho_s", label: "solo" });
  });

  it("an agent inherits the top-level url/apiKey default when it omits a field", () => {
    const r = resolveMcpCredentials(
      { agent: "inherits" },
      deps({
        files: {
          [LOGIN_PATH]: { url: "https://top", apiKey: "cho_top", agents: [{ label: "inherits" }] },
        },
      }),
    );
    expect(r).toEqual({ url: "https://top", apiKey: "cho_top", label: "inherits" });
  });

  it("throws when a selected agent has neither its own nor a default credential", () => {
    expect(() =>
      resolveMcpCredentials(
        { agent: "bare" },
        deps({ files: { [LOGIN_PATH]: { agents: [{ label: "bare", url: "https://b" }] } } }),
      ),
    ).toThrow(/Agent "bare".*missing a url or apiKey/s);
  });
});

describe("resolveMcpCredentials — profile by uuid/name (real daemon.json shape)", () => {
  // The real ~/.chorus/daemon.json (written by chorus init / login) tags each
  // entry with agentUuid + agentName — NOT label/name.
  const realShape = {
    [LOGIN_PATH]: {
      agents: [
        {
          url: "https://c",
          apiKey: "cho_admin",
          agentType: "claude-code",
          agentUuid: "daee0667-8487-4810-9cc0-8e4a0b2174c9",
          agentName: "Admin Claude",
        },
        {
          url: "https://c",
          apiKey: "cho_codex",
          agentType: "codex",
          agentUuid: "b0e3a413-d812-44b7-a512-8c6dacd9e180",
          agentName: "Codex",
        },
      ],
    },
  };

  it("--agent selects by agentUuid", () => {
    expect(
      resolveMcpCredentials({ agent: "b0e3a413-d812-44b7-a512-8c6dacd9e180" }, deps({ files: realShape })),
    ).toEqual({ url: "https://c", apiKey: "cho_codex", label: "Codex" });
  });

  it("--agent selects by agentName", () => {
    expect(resolveMcpCredentials({ agent: "Admin Claude" }, deps({ files: realShape }))).toEqual({
      url: "https://c",
      apiKey: "cho_admin",
      label: "Admin Claude",
    });
  });

  it("--agent flag is PREFERRED over an explicit --url/--api-key pair (prefer profile)", () => {
    expect(
      resolveMcpCredentials(
        { agent: "Codex", url: "https://flag", apiKey: "cho_flag" },
        deps({ files: realShape }),
      ),
    ).toEqual({ url: "https://c", apiKey: "cho_codex", label: "Codex" });
  });

  it("an ambiguous agentName match throws listing candidates", () => {
    const dup = {
      [LOGIN_PATH]: {
        agents: [
          { apiKey: "cho_1", url: "https://c", agentUuid: "u1", agentName: "Twin" },
          { apiKey: "cho_2", url: "https://c", agentUuid: "u2", agentName: "Twin" },
        ],
      },
    };
    expect(() => resolveMcpCredentials({ agent: "Twin" }, deps({ files: dup }))).toThrow(
      /--agent "Twin" is ambiguous.*Twin, Twin.*UUID/s,
    );
    // ...but the unique uuid still resolves cleanly.
    expect(resolveMcpCredentials({ agent: "u2" }, deps({ files: dup }))).toEqual({
      url: "https://c",
      apiKey: "cho_2",
      label: "Twin",
    });
  });
});

describe("resolveMcpCredentials — CHORUS_AGENT_PROFILE env", () => {
  const realShape = {
    [LOGIN_PATH]: {
      agents: [
        { apiKey: "cho_admin", url: "https://c", agentUuid: "u-admin", agentName: "Admin Claude" },
        { apiKey: "cho_codex", url: "https://c", agentUuid: "u-codex", agentName: "Codex" },
      ],
    },
  };

  it("selects the agent named by CHORUS_AGENT_PROFILE (by name or uuid)", () => {
    expect(
      resolveMcpCredentials({}, deps({ env: { CHORUS_AGENT_PROFILE: "Codex" }, files: realShape })),
    ).toEqual({ url: "https://c", apiKey: "cho_codex", label: "Codex" });
    expect(
      resolveMcpCredentials({}, deps({ env: { CHORUS_AGENT_PROFILE: "u-admin" }, files: realShape })),
    ).toEqual({ url: "https://c", apiKey: "cho_admin", label: "Admin Claude" });
  });

  it("profile env WINS over the CHORUS_URL/CHORUS_API_KEY env pair", () => {
    expect(
      resolveMcpCredentials(
        {},
        deps({
          env: { CHORUS_AGENT_PROFILE: "Codex", CHORUS_URL: "https://env", CHORUS_API_KEY: "cho_env" },
          files: realShape,
        }),
      ),
    ).toEqual({ url: "https://c", apiKey: "cho_codex", label: "Codex" });
  });

  it("an explicit --agent flag takes precedence over CHORUS_AGENT_PROFILE", () => {
    expect(
      resolveMcpCredentials(
        { agent: "Admin Claude" },
        deps({ env: { CHORUS_AGENT_PROFILE: "Codex" }, files: realShape }),
      ),
    ).toEqual({ url: "https://c", apiKey: "cho_admin", label: "Admin Claude" });
  });

  it("a profile env naming no agent falls back to url-mode (label = profile name)", () => {
    expect(
      resolveMcpCredentials(
        {},
        deps({
          env: { CHORUS_AGENT_PROFILE: "ghost", CHORUS_URL: "https://env", CHORUS_API_KEY: "cho_env" },
          files: realShape,
        }),
      ),
    ).toEqual({ url: "https://env", apiKey: "cho_env", label: "ghost" });
  });

  it("a profile env with no agents[] rides along the env pair as the label", () => {
    expect(
      resolveMcpCredentials(
        {},
        deps({ env: { CHORUS_AGENT_PROFILE: "whoever", CHORUS_URL: "https://env", CHORUS_API_KEY: "cho_env" } }),
      ),
    ).toEqual({ url: "https://env", apiKey: "cho_env", label: "whoever" });
  });

  it("an ambiguous CHORUS_AGENT_PROFILE match throws", () => {
    const dup = {
      [LOGIN_PATH]: {
        agents: [
          { apiKey: "cho_1", url: "https://c", agentUuid: "u1", agentName: "Twin" },
          { apiKey: "cho_2", url: "https://c", agentUuid: "u2", agentName: "Twin" },
        ],
      },
    };
    expect(() =>
      resolveMcpCredentials({}, deps({ env: { CHORUS_AGENT_PROFILE: "Twin" }, files: dup })),
    ).toThrow(/CHORUS_AGENT_PROFILE "Twin" is ambiguous/s);
  });
});

describe("resolveMcpCredentials — flat (no agents[])", () => {
  it("resolves flat login-file credentials with no --agent", () => {
    const r = resolveMcpCredentials(
      {},
      deps({ files: { [LOGIN_PATH]: { url: "https://file", apiKey: "cho_file" } } }),
    );
    expect(r).toEqual({ url: "https://file", apiKey: "cho_file", label: "login-file" });
  });

  it("throws when --agent is given but there is no agents[] to match", () => {
    expect(() =>
      resolveMcpCredentials(
        { agent: "x" },
        deps({ files: { [LOGIN_PATH]: { url: "https://file", apiKey: "cho_file" } } }),
      ),
    ).toThrow(/--agent "x".*declares no agents\[\]/s);
  });

  it("propagates the detailed 'could not resolve' error when nothing resolves", () => {
    expect(() => resolveMcpCredentials({}, deps({}))).toThrow(/Could not resolve Chorus credentials/);
  });
});
