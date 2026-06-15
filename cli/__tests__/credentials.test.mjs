// cli/__tests__/credentials.test.mjs
// Covers cli-auth spec "Layered credential and address resolution".
import { describe, it, expect } from "vitest";
import { resolveCredentials, loginFilePath, claudeSettingsPath } from "../credentials.mjs";

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

describe("resolveCredentials precedence", () => {
  it("flags win over all other sources", () => {
    const r = resolveCredentials(
      { url: "https://flag", apiKey: "cho_flag" },
      deps({
        env: { CHORUS_URL: "https://env", CHORUS_API_KEY: "cho_env" },
        files: {
          [LOGIN_PATH]: { url: "https://file", apiKey: "cho_file" },
          [SETTINGS_PATH]: { env: { CHORUS_URL: "https://plug", CHORUS_API_KEY: "cho_plug" } },
        },
      })
    );
    expect(r).toEqual({ url: "https://flag", apiKey: "cho_flag", source: "flag" });
  });

  it("env used when no flags", () => {
    const r = resolveCredentials(
      {},
      deps({
        env: { CHORUS_URL: "https://env", CHORUS_API_KEY: "cho_env" },
        files: { [LOGIN_PATH]: { url: "https://file", apiKey: "cho_file" } },
      })
    );
    expect(r).toEqual({ url: "https://env", apiKey: "cho_env", source: "env" });
  });

  it("login file used when no flags or env", () => {
    const r = resolveCredentials(
      {},
      deps({ files: { [LOGIN_PATH]: { url: "https://file", apiKey: "cho_file" } } })
    );
    expect(r).toEqual({ url: "https://file", apiKey: "cho_file", source: "login-file" });
  });

  it("plugin settings env block used as last resort", () => {
    const r = resolveCredentials(
      {},
      deps({
        files: { [SETTINGS_PATH]: { env: { CHORUS_URL: "https://plug", CHORUS_API_KEY: "cho_plug" } } },
      })
    );
    expect(r).toEqual({ url: "https://plug", apiKey: "cho_plug", source: "plugin-fallback" });
  });

  it("partial pair at a higher tier falls through to the next complete source", () => {
    // env has only a URL; login file is complete → login file wins.
    const r = resolveCredentials(
      {},
      deps({
        env: { CHORUS_URL: "https://env-only" },
        files: { [LOGIN_PATH]: { url: "https://file", apiKey: "cho_file" } },
      })
    );
    expect(r.source).toBe("login-file");
  });

  it("blank/whitespace values are treated as absent", () => {
    const r = resolveCredentials(
      { url: "  ", apiKey: "" },
      deps({ env: { CHORUS_URL: "https://env", CHORUS_API_KEY: "cho_env" } })
    );
    expect(r.source).toBe("env");
  });

  it("malformed login file does not throw and falls through", () => {
    // login file path returns null (as if JSON.parse failed); settings has the pair.
    const r = resolveCredentials(
      {},
      {
        env: {},
        loginPath: LOGIN_PATH,
        settingsPath: SETTINGS_PATH,
        readJson: (p) =>
          p === SETTINGS_PATH
            ? { env: { CHORUS_URL: "https://plug", CHORUS_API_KEY: "cho_plug" } }
            : null,
      }
    );
    expect(r.source).toBe("plugin-fallback");
  });
});

describe("resolveCredentials failure", () => {
  it("throws a single actionable error listing every source tried", () => {
    let err;
    try {
      resolveCredentials({}, deps({ env: {}, files: {} }));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    const msg = err.message;
    // Lists all four sources in order
    expect(msg).toContain("--url/--api-key flags");
    expect(msg).toContain("CHORUS_URL / CHORUS_API_KEY environment variables");
    expect(msg).toContain("login file");
    expect(msg).toContain("Claude Code plugin config");
    // And tells the user how to supply credentials
    expect(msg).toContain("chorus login");
  });
});

describe("path helpers", () => {
  it("loginFilePath ends with .chorus/daemon.json", () => {
    expect(loginFilePath().replace(/\\/g, "/")).toMatch(/\.chorus\/daemon\.json$/);
  });
  it("claudeSettingsPath ends with .claude/settings.json", () => {
    expect(claudeSettingsPath().replace(/\\/g, "/")).toMatch(/\.claude\/settings\.json$/);
  });
});
