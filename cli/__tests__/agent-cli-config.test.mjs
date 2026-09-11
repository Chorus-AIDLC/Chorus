import { describe, it, expect } from "vitest";
import { validateAgentCliConfig as validate, overlayAgentEnv, getAgentEnv, mergeAgentArgs, assertConfiguredShimArgs } from "../agent-cli-config.mjs";
import { resolveAgentConfigs } from "../daemon-config.mjs";
import { resolveClaudePath } from "../claude-spawner.mjs";
import { resolveCodexPath } from "../codex-spawner.mjs";
import { resolveKiroPath } from "../kiro-spawner.mjs";
import { resolvePiPath } from "../pi-spawner.mjs";
import { resolveDshPath, resolveDshHome } from "../dsh-spawner.mjs";

const deps = (file) => ({ env: {}, loginPath: "/config", settingsPath: "/settings", readJson: (p) => p === "/config" ? file : null });

describe("per-agent literal config", () => {
  it.each([
    { args: null }, { args: "secret" }, { args: [123] }, { args: ["secret\0"] },
    { env: null }, { env: [] }, { env: { SECRET: 1 } }, { env: { SECRET: "secret\0" } },
    { env: { "secret=value": "secret" } }, { env: { "CHORUS_API_KEY": "secret" } },
    { env: { "chorus_daemon_headless": "secret" } },
  ])("rejects malformed values without disclosing them: %#", (config) => {
    expect(() => validate(config, "pi", "profile-1")).toThrow(/Agent profile-1: (args|env)/);
    try { validate(config, "pi", "profile-1"); } catch (e) { expect(e.message).not.toContain("secret"); }
  });
  it("clones empty/absent and literal values without mutation", () => {
    expect(validate()).toEqual({ args: [], env: {} });
    const config = { args: ["--other= space $HOME `cmd` ; & | % ! ", "--empty="], env: { VALUE: "${HOME} $(cmd)", EMPTY: "" } };
    const copy = structuredClone(config);
    const result = validate(config, "pi");
    result.args.push("changed"); result.env.VALUE = "changed";
    expect(config).toEqual(copy);
  });
  it("flat config works, multi-agent does not inherit, and results are snapshots", () => {
    const flat = { url: "u", apiKey: "k", agent: "pi", args: ["--model", "a"], env: { PROVIDER: "a" } };
    expect(resolveAgentConfigs({}, deps(flat))[0]).toMatchObject({ args: flat.args, env: flat.env });
    const file = { url: "u", apiKey: "k", agents: [{ agentType: "pi", args: flat.args, env: flat.env }, { agentType: "pi" }] };
    const configs = resolveAgentConfigs({}, deps(file));
    flat.args[1] = "b"; flat.env.PROVIDER = "b";
    expect(configs[0]).toMatchObject({ args: ["--model", "a"], env: { PROVIDER: "a" } });
    expect(configs[1]).toMatchObject({ args: [], env: {} });
    for (const field of ["args", "env"]) expect(() => resolveAgentConfigs({}, deps({ ...file, [field]: null }))).toThrow(/move them into each agent/);
  });
  it("reads Windows env names case-insensitively without changing POSIX or empty values", () => {
    const env = { dSh_HoMe: "custom", home: "", PaTh: "bin" };
    expect(getAgentEnv(env, "DSH_HOME", "win32")).toBe("custom");
    expect(getAgentEnv(env, "HOME", "win32")).toBe("");
    expect(getAgentEnv(env, "PATH", "win32")).toBe("bin");
    expect(getAgentEnv(env, "DSH_HOME", "linux")).toBeUndefined();
    expect(getAgentEnv(env, "dSh_HoMe", "linux")).toBe("custom");
    expect(getAgentEnv(env, "MISSING", "win32")).toBeUndefined();
    expect(getAgentEnv({ DSH_HOME: "first", dsh_home: "second" }, "DSH_HOME", "win32")).toBe("first");
  });
  it("overlays Windows names case-insensitively, retains POSIX case and never mutates the parent", () => {
    const base = { Path: "old", TOKEN: "old", chorus_daemon_headless: "1" };
    expect(overlayAgentEnv(base, { path: "new", token: "" }, "win32")).toEqual({ PATH: "new", token: "", CHORUS_DAEMON_HEADLESS: "1" });
    expect(overlayAgentEnv(base, { path: "new" }, "linux")).toMatchObject({ Path: "old", path: "new" });
    expect(base.Path).toBe("old");
  });
});

describe("Windows environment consumers", () => {
  it.each([
    ["claude", resolveClaudePath, "CHORUS_CLAUDE_PATH"],
    ["codex", resolveCodexPath, "CHORUS_CODEX_PATH"],
    ["kiro-cli", resolveKiroPath, "CHORUS_KIRO_PATH"],
    ["pi", resolvePiPath, "CHORUS_PI_PATH"],
    ["dsh", resolveDshPath, "CHORUS_DSH_PATH"],
  ])("%s discovery uses mixed-case PATH and inherited binary override", (name, resolve, override) => {
    expect(resolve({ platform: "win32", env: { pAtH: "C:\\profile" }, isFile: () => true })).toBe(`C:\\profile\\${name}.cmd`);
    expect(resolve({ platform: "win32", env: { [override.toLowerCase()]: "C:\\custom.exe" }, isFile: () => true })).toBe("C:\\custom.exe");
  });
  it("dsh home remains case-sensitive on POSIX and honors managed override precedence", () => {
    expect(resolveDshHome({ dsh_home: "custom" }, "linux")).toBeNull();
    expect(resolveDshHome({ dsh_home: "custom" }, "win32")).toBe("custom");
    expect(resolveDshHome({ dsh_home: "custom", cHoRuS_dSh_HoMe: "managed-override" }, "win32")).toBe("managed-override");
  });
});

const protectedCases = {
  "claude-code": ["--output-format=secret", "-psecret", "-rsecret", "-c", "--allowedTools=secret", "--allowed-tools=secret", "--permission-mode=secret", "--mcp-config=secret", "--input-format=secret", "--session-id=secret", "--settings=secret", "-wsecret"],
  codex: ["--json=secret", "--sandbox=secret", "-ssecret", "-asecret", "-Csecret", "-osecret", "--full-auto", "--profile=secret", "-psecret", "-csandbox_mode=secret", "--config=mcp_servers.chorus.url=secret", "--config=\"sandbox_mode\"=secret", "--config=approval_policy=secret", "--yolo", "--not-so-yolo", "--experimental-json=secret", "-cdeveloper_instructions=secret", "--ignore-user-config"],
  kiro: ["--resume-id=secret", "-rsecret", "-a", "--trust-tools=secret", "--agent=secret", "--no-interactive", "--v3", "-vva", "-vr"],
  pi: ["--mode=rpc", "-psecret", "-rsecret", "-c", "--session=secret", "--session-id=secret", "--session-dir=secret", "--no-session", "--list-models", "--list-models=secret"],
  dsh: ["--profile=secret", "--patch=secret", "--dump-config", "--session=secret", "--cwd=secret"],
  opencode: ["-ssecret", "--session=secret", "--prompt=secret"],
  openclaw: ["--session-id=secret", "--message=secret", "-msecret"],
};
describe("managed controls", () => {
  for (const [type, tokens] of Object.entries(protectedCases)) {
    it.each([...tokens, "--", "-", "--help", "--version", "resume"])(`${type} rejects %s`, (token) => {
      expect(() => validate({ args: [token] }, type)).toThrow();
      try { validate({ args: [token] }, type); } catch (e) { expect(e.message).not.toContain("secret"); }
    });
  }
  it("keeps unrelated Codex config keys", () => {
    expect(validate({ args: ["-c", "model_reasoning_effort=high", "--config=features.foo=true"] }, "codex").args).toHaveLength(3);
  });
  it.each(["a b", "a&b", "%TEMP%", "!TOKEN!", "a^b", 'a"b', "x|y", "x>y", "x<y", "(x)", "a\nb", ""])("fails safely on shim token %#", (token) => {
    expect(() => assertConfiguredShimArgs("C:\\bin\\pi.cmd", [token], "win32")).toThrow(/native executable/);
    expect(() => assertConfiguredShimArgs("C:\\bin\\pi.exe", [token], "win32")).not.toThrow();
    expect(() => assertConfiguredShimArgs("/bin/pi", [token], "linux")).not.toThrow();
  });
});

describe("option arity boundaries", () => {
  const booleans = {
    "claude-code": ["--brief", "--chrome", "--no-chrome", "--ide", "--disable-slash-commands", "--ax-screen-reader"],
    codex: ["--oss", "--search", "--no-alt-screen", "--strict-config"],
    kiro: ["--require-mcp-startup"],
    pi: ["--verbose", "--offline", "--no-tools", "-nt", "-nbt", "-ne", "-ns", "-np", "--no-themes", "-nc", "-a", "-na"],
    opencode: ["--print-logs", "--pure"],
    openclaw: ["--deliver", "--dry-run", "--best-effort-deliver", "--no-color"],
  };
  for (const [type, flags] of Object.entries(booleans)) {
    it.each(flags)(`${type} %s cannot consume a positional prompt`, (flag) => {
      expect(validate({ args: [flag] }, type).args).toEqual([flag]);
      expect(() => validate({ args: [flag, "PRIVATE-PROMPT"] }, type)).toThrow(/positional/);
      expect(() => validate({ args: [flag, "--model", "x", "PRIVATE-PROMPT"] }, type)).toThrow(/positional/);
      expect(mergeAgentArgs(type, ["--model", "old"], [flag, "--model", "new"])).toEqual([flag, "--model", "new"]);
    });
  }
  const values = {
    "claude-code": ["--fallback-model", "--debug-file", "--plugin-dir", "--plugin-url", "--autocompact", "--max-budget-usd", "-n"],
    codex: ["--enable", "--disable", "--local-provider", "--image", "-i"],
    kiro: ["--wrap", "-w"],
    pi: ["--api-key", "--models", "--tools", "-t", "--exclude-tools", "-xt", "--extension", "-e", "--skill", "--theme", "--prompt-template"],
    opencode: ["--log-level"],
    openclaw: ["--timeout", "--verbose", "--channel", "--reply-to", "--reply-channel", "--reply-account", "--log-level"],
  };
  for (const [type, flags] of Object.entries(values)) {
    it.each(flags)(`${type} %s consumes exactly one literal value`, (flag) => {
      const configured = [flag, "--model", "--model", "old"];
      expect(validate({ args: configured }, type).args).toEqual(configured);
      expect(mergeAgentArgs(type, configured, ["--model", "new"])).toEqual([flag, "--model", "--model", "new"]);
      const explicit = [flag, "--model"];
      expect(mergeAgentArgs(type, ["--model", "old"], explicit)).toEqual(["--model", "old", ...explicit]);
      expect(() => validate({ args: [flag] }, type)).toThrow(/requires a value/);
      expect(() => validate({ args: [flag, "value", "PRIVATE-PROMPT"] }, type)).toThrow(/positional/);
    });
  }
  it.each(["claude-code", "codex", "kiro", "pi", "dsh", "opencode", "openclaw"])("%s never guesses unknown option arity", (type) => {
    expect(validate({ args: ["--future", "--custom=value"] }, type).args).toEqual(["--future", "--custom=value"]);
    expect(() => validate({ args: ["--future", "PRIVATE-PROMPT"] }, type)).toThrow(/ambiguous/);
    const explicit = ["--future", "--model", "new"];
    expect(mergeAgentArgs(type, ["--model=old"], explicit)).toEqual(["--model=old", ...explicit]);
    expect(mergeAgentArgs(type, ["--model=old"], ["--future=value", "--model=new"]))
      .toEqual([...(type === "dsh" ? ["--model=old"] : []), "--future=value", "--model=new"]);
  });
  it("distinguishes optional and variadic values from subsequent switches", () => {
    expect(validate({ args: ["--debug", "api", "--betas", "one", "two", "--file=x", "y"] }, "claude").args).toHaveLength(7);
    expect(() => validate({ args: ["--debug", "api", "PROMPT"] }, "claude")).toThrow(/positional/);
    for (const explicit of [["--debug", "--model", "new"], ["-dapi", "--model", "new"], ["--betas", "one", "two", "--model", "new"]]) {
      expect(mergeAgentArgs("claude", ["--model", "old"], explicit)).toEqual(explicit);
    }
    expect(mergeAgentArgs("claude", ["--model", "old"], ["--append-system-prompt", "--model"]))
      .toEqual(["--model", "old", "--append-system-prompt", "--model"]);
    expect(mergeAgentArgs("claude", ["--model", "old"], ["--append-system-prompt", "--", "--model", "new"]))
      .toEqual(["--model", "old", "--append-system-prompt", "--", "--model", "new"]);
    expect(mergeAgentArgs("codex", ["--model", "old"], ["-ifile", "-mnew"])).toEqual(["-ifile", "-mnew"]);
  });
  it("Pi option-looking prompt values are not switches, including aliases and sentinels", () => {
    const configured = ["--model", "old"];
    for (const explicit of [["--append-system-prompt", "--model"], ["-e", "--model"], ["-t", "--model"], ["--append-system-prompt", "-", "--", "--model", "new"]]) {
      expect(mergeAgentArgs("pi", configured, explicit)).toEqual([...configured, ...explicit]);
    }
    // Chorus stops at the first bare -- regardless of the backend's parser.
    const explicit = ["--append-system-prompt", "--", "--model", "new"];
    expect(mergeAgentArgs("pi", configured, explicit)).toEqual([...configured, ...explicit]);
    for (const args of [["--api-key", "--"], ["--api-key", "-"], ["--verbose", "--", "PROMPT"]]) {
      expect(() => validate({ args }, "pi")).toThrow(/terminator|stdin/);
    }
    expect(validate({ args: ["--api-key", "--session", "--verbose"] }, "pi").args)
      .toEqual(["--api-key", "--session", "--verbose"]);
    expect(mergeAgentArgs("pi", configured, ["--use-theme", "--model", "new"]))
      .toEqual(["--use-theme", "--model", "new"]);
  });
});

describe("explicit recognizable singleton precedence", () => {
  it.each([
    ["claude-code", ["--model", "old", "--effort=low"], ["--model=new", "--effort", "high"]],
    ["kiro", ["--model=old", "--effort", "low"], ["--model", "new", "--effort=high"]],
    ["pi", ["--model", "old", "--thinking=low"], ["--model=new", "--thinking", "high"]],
    ["opencode", ["-mold"], ["--model=new"]],
    ["openclaw", ["--model=old", "--thinking", "low"], ["--model", "new", "--thinking=high"]],
    ["codex", ["-mold", "-cmodel_reasoning_effort=low"], ["--config=model=new", "-c", "model_reasoning_effort=high"]],
  ])("filters %s equivalents only", (type, configured, explicit) => {
    expect(mergeAgentArgs(type, [...configured, "--unknown=x"], explicit)).toEqual(["--unknown=x", ...explicit]);
  });
  it("preserves unrelated Codex -c, repeatable unknown args, and the explicit tail", () => {
    const explicit = ["-mnew", "--config=model_reasoning_effort=high", "--", "--model", "positional"];
    expect(mergeAgentArgs("codex", ["--config=model=old", "-c", "model_reasoning_effort=low", "-c", "features.foo=true", "--other=x"], explicit))
      .toEqual(["-c", "features.foo=true", "--other=x", ...explicit]);
    expect(mergeAgentArgs("pi", ["--model", "old"], ["--", "--model=new"])).toEqual(["--model", "old", "--", "--model=new"]);
    expect(mergeAgentArgs("codex", ["--model", "old"], ["-c", "--", "--model=new"])).toEqual(["--model", "old", "-c", "--", "--model=new"]);
    expect(() => validate({ args: ["--model=x", "resume"] }, "codex")).toThrow(/positional/);
    expect(() => validate({ args: ["-mx", "resume"] }, "codex")).toThrow(/positional/);
  });
});
