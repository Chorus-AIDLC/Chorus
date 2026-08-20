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
