// cli/__tests__/daemon-install-config.test.mjs
// Unit tests for the `chorus daemon install` pre-install config phase
// (fix-daemon-install-config, task 2). Both helpers are pure with injected IO —
// no real disk / network / TTY. Covers the credential preflight
// (resolve → persist → validate → abort) and the multi-cwd wizard
// (configured-detection, blank-terminated loop, normalize+dedup, persist), plus
// the --yes / non-TTY skip semantics.
import { describe, it, expect, vi } from "vitest";
import {
  resolveInstallCredentials,
  resolveInstallCwds,
  resolveInstallAgent,
  resolveInstallBrowseRoots,
} from "../daemon-install-config.mjs";

// ---- resolveInstallCredentials ------------------------------------------

describe("resolveInstallCredentials", () => {
  function deps(over = {}) {
    return {
      resolve: vi.fn(() => ({ url: "https://x", apiKey: "cho_k", source: "env" })),
      validate: vi.fn(async () => ({ uuid: "agent-1", name: "Bot" })),
      writeConfig: vi.fn(() => "/home/u/.chorus/daemon.json"),
      prompt: vi.fn(async () => ""),
      log: vi.fn(),
      errLog: vi.fn(),
      ...over,
    };
  }

  it("resolved-from-any-source: validates then persists creds + identity, returns ok", async () => {
    const d = deps();
    const r = await resolveInstallCredentials({}, {}, { isTTY: true, skip: false, ...d });
    expect(r.ok).toBe(true);
    expect(d.validate).toHaveBeenCalledWith({ url: "https://x", apiKey: "cho_k" });
    // persisted the credential + identity fields via the merge writer
    expect(d.writeConfig).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://x", apiKey: "cho_k", agentUuid: "agent-1", agentName: "Bot" })
    );
    expect(d.prompt).not.toHaveBeenCalled();
  });

  it("validation failure: aborts (ok:false), writes nothing", async () => {
    const d = deps({ validate: vi.fn(async () => { throw new Error("invalid key"); }) });
    const r = await resolveInstallCredentials({}, {}, { isTTY: true, skip: false, ...d });
    expect(r.ok).toBe(false);
    expect(d.writeConfig).not.toHaveBeenCalled();
    expect(d.errLog).toHaveBeenCalled();
  });

  it("unresolved on a TTY (no skip): prompts login-style (masked), then validates + persists", async () => {
    const resolve = vi.fn(() => { throw new Error("Could not resolve Chorus credentials (url + cho_ API key)."); });
    const prompt = vi.fn()
      .mockResolvedValueOnce("https://typed")   // URL
      .mockResolvedValueOnce("cho_typed");       // masked key
    const d = deps({ resolve, prompt });
    const r = await resolveInstallCredentials({}, {}, { isTTY: true, skip: false, ...d });
    expect(r.ok).toBe(true);
    // second prompt (key) must be masked
    expect(prompt).toHaveBeenNthCalledWith(2, expect.any(String), { mask: true });
    expect(d.validate).toHaveBeenCalledWith({ url: "https://typed", apiKey: "cho_typed" });
    expect(d.writeConfig).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://typed", apiKey: "cho_typed" })
    );
  });

  it("unresolved + skip: aborts with the multi-source hint, no prompt, no write", async () => {
    const resolve = vi.fn(() => { throw new Error("Could not resolve Chorus credentials — tried flags, env, login file, plugin."); });
    const d = deps({ resolve });
    const r = await resolveInstallCredentials({}, {}, { isTTY: true, skip: true, ...d });
    expect(r.ok).toBe(false);
    expect(d.prompt).not.toHaveBeenCalled();
    expect(d.writeConfig).not.toHaveBeenCalled();
    expect(d.errLog.mock.calls.join(" ")).toMatch(/Could not resolve Chorus credentials/);
  });

  it("unresolved + non-TTY: aborts without prompting even when skip is false", async () => {
    const resolve = vi.fn(() => { throw new Error("Could not resolve Chorus credentials."); });
    const d = deps({ resolve });
    const r = await resolveInstallCredentials({}, {}, { isTTY: false, skip: false, ...d });
    expect(r.ok).toBe(false);
    expect(d.prompt).not.toHaveBeenCalled();
    expect(d.writeConfig).not.toHaveBeenCalled();
  });

  it("skip mode still validates the key (does not bypass server validation)", async () => {
    const d = deps({ validate: vi.fn(async () => { throw new Error("revoked key"); }) });
    const r = await resolveInstallCredentials({}, {}, { isTTY: false, skip: true, ...d });
    expect(r.ok).toBe(false);
    expect(d.validate).toHaveBeenCalledOnce();
    expect(d.writeConfig).not.toHaveBeenCalled();
  });
});

describe("resolveInstallBrowseRoots", () => {
  it("normalizes, deduplicates, and field-merges explicit roots", async () => {
    const writeConfig = vi.fn();
    const result = await resolveInstallBrowseRoots(
      { browseRoot: ["~/src", "/opt", "~/src"] },
      { home: "/home/u", readJson: () => ({ cwds: ["/served"] }), writeConfig },
    );
    expect(result.browseRoots).toEqual(["/home/u/src", "/opt"]);
    expect(writeConfig).toHaveBeenCalledWith({ browseRoots: ["/home/u/src", "/opt"] });
  });

  it("preserves stored roots and defaults to OS home when absent", async () => {
    const writeConfig = vi.fn();
    expect(await resolveInstallBrowseRoots({}, {
      home: "/home/u", readJson: () => ({ browseRoots: ["/stored"] }), writeConfig,
    })).toEqual({ browseRoots: ["/stored"] });
    expect(writeConfig).not.toHaveBeenCalled();

    expect(await resolveInstallBrowseRoots({}, {
      home: "/home/u", readJson: () => null, writeConfig,
    })).toEqual({ browseRoots: ["/home/u"] });
    expect(writeConfig).toHaveBeenCalledWith({ browseRoots: ["/home/u"] });
  });
});

// ---- resolveInstallCwds -------------------------------------------------

describe("resolveInstallCwds", () => {
  function deps(over = {}) {
    return {
      // readJson stands in for reading ~/.chorus/daemon.json
      readJson: vi.fn(() => null),
      writeConfig: vi.fn(() => "/home/u/.chorus/daemon.json"),
      prompt: vi.fn(async () => ""),
      home: "/home/u",
      processCwd: "/home/u/proj",
      log: vi.fn(),
      ...over,
    };
  }

  it("--cwd flag present: uses it, no prompt, persists normalized+deduped set", async () => {
    const d = deps();
    const r = await resolveInstallCwds({ cwd: ["/a", "/a", "~/b"] }, { isTTY: true, skip: false, ...d });
    expect(d.prompt).not.toHaveBeenCalled();
    expect(r.cwds).toEqual(["/a", "/home/u/b"]);
    expect(d.writeConfig).toHaveBeenCalledWith(expect.objectContaining({ cwds: ["/a", "/home/u/b"] }));
  });

  it("existing daemon.json cwds: uses them, no prompt", async () => {
    const d = deps({ readJson: vi.fn(() => ({ cwds: ["/x", "/y"] })) });
    const r = await resolveInstallCwds({}, { isTTY: true, skip: false, ...d });
    expect(d.prompt).not.toHaveBeenCalled();
    expect(r.cwds).toEqual(["/x", "/y"]);
  });

  it("unconfigured + TTY (no skip): wizard pre-seeds cwd, loops until blank, dedups", async () => {
    // Enter: accept preseed (blank first → takes processCwd), then add /b, /b (dup), ~/c, blank ends.
    // Simpler: first prompt returns "" meaning "accept preseeded current dir"; then add loop.
    const prompt = vi.fn()
      .mockResolvedValueOnce("")          // accept preseeded current dir → /home/u/proj
      .mockResolvedValueOnce("/b")        // add /b
      .mockResolvedValueOnce("/b")        // dup, deduped away
      .mockResolvedValueOnce("~/c")       // add ~/c → /home/u/c
      .mockResolvedValueOnce("");         // blank → finish
    const d = deps({ prompt });
    const r = await resolveInstallCwds({}, { isTTY: true, skip: false, ...d });
    expect(r.cwds).toEqual(["/home/u/proj", "/b", "/home/u/c"]);
    expect(d.writeConfig).toHaveBeenCalledWith(expect.objectContaining({ cwds: ["/home/u/proj", "/b", "/home/u/c"] }));
  });

  it("unconfigured + skip: no prompt, falls back to process cwd, persists it", async () => {
    const d = deps();
    const r = await resolveInstallCwds({}, { isTTY: true, skip: true, ...d });
    expect(d.prompt).not.toHaveBeenCalled();
    expect(r.cwds).toEqual(["/home/u/proj"]);
  });

  it("unconfigured + non-TTY: no prompt, falls back to process cwd", async () => {
    const d = deps();
    const r = await resolveInstallCwds({}, { isTTY: false, skip: false, ...d });
    expect(d.prompt).not.toHaveBeenCalled();
    expect(r.cwds).toEqual(["/home/u/proj"]);
  });
});

// ---- resolveInstallAgent ------------------------------------------------

describe("resolveInstallAgent", () => {
  // A base opts bundle: all three CLI probes report "found" so tests that don't
  // care about the not-found path never trip the warning. Individual tests
  // override probes / readJson as needed.
  function baseOpts(over = {}) {
    return {
      writeConfig: vi.fn(),
      readJson: () => null,
      loginPath: "/tmp/none.json",
      probes: {
        resolveClaudePath: () => "/bin/claude",
        resolveCodexPath: () => "/bin/codex",
        resolveKiroPath: () => "/bin/kiro-cli",
        resolveDshPath: () => "/bin/dsh",
      },
      log: vi.fn(),
      errLog: vi.fn(),
      ...over,
    };
  }

  it("persists the --agent flag to daemon.json and returns it", async () => {
    const o = baseOpts();
    const r = await resolveInstallAgent({ agent: "codex" }, {}, o);
    expect(r.agent).toBe("codex");
    expect(o.writeConfig).toHaveBeenCalledWith({ agent: "codex" });
  });

  it("uses CHORUS_AGENT env when no flag is given", async () => {
    const o = baseOpts();
    const r = await resolveInstallAgent({}, { CHORUS_AGENT: "kiro" }, o);
    expect(r.agent).toBe("kiro");
    expect(o.writeConfig).toHaveBeenCalledWith({ agent: "kiro" });
  });

  it("flag wins over env", async () => {
    const o = baseOpts();
    const r = await resolveInstallAgent({ agent: "claude-code" }, { CHORUS_AGENT: "codex" }, o);
    expect(r.agent).toBe("claude-code");
  });

  it("keeps an existing valid daemon.json `agent` WITHOUT re-writing (idempotent re-install)", async () => {
    const o = baseOpts({ readJson: () => ({ agent: "codex" }) });
    const r = await resolveInstallAgent({}, {}, o);
    expect(r.agent).toBe("codex");
    expect(o.writeConfig).not.toHaveBeenCalled();
  });

  it("ignores an invalid stored `agent` and falls back to the default (non-TTY)", async () => {
    const o = baseOpts({ readJson: () => ({ agent: "gpt" }) });
    const r = await resolveInstallAgent({}, {}, { ...o, isTTY: false, skip: true });
    expect(r.agent).toBe("claude-code");
    expect(o.writeConfig).toHaveBeenCalledWith({ agent: "claude-code" });
  });

  it("non-TTY / skip with nothing configured persists the claude-code default", async () => {
    const o = baseOpts();
    const r = await resolveInstallAgent({}, {}, { ...o, isTTY: false, skip: true });
    expect(r.agent).toBe("claude-code");
    expect(o.writeConfig).toHaveBeenCalledWith({ agent: "claude-code" });
  });

  it("interactive menu: a numeric selection picks the matching backend", async () => {
    const prompt = vi.fn(async () => "2"); // 2) Codex CLI
    const o = baseOpts({ prompt });
    const r = await resolveInstallAgent({}, {}, { ...o, isTTY: true, skip: false });
    expect(r.agent).toBe("codex");
    expect(o.writeConfig).toHaveBeenCalledWith({ agent: "codex" });
    // The menu was actually shown.
    expect(o.log.mock.calls.flat().join("\n")).toMatch(/Codex CLI/);
  });

  it("interactive menu: a blank answer accepts the claude-code default (Enter)", async () => {
    const prompt = vi.fn(async () => "");
    const o = baseOpts({ prompt });
    const r = await resolveInstallAgent({}, {}, { ...o, isTTY: true, skip: false });
    expect(r.agent).toBe("claude-code");
  });

  it("interactive menu: accepts a backend typed by name", async () => {
    const prompt = vi.fn(async () => "kiro");
    const o = baseOpts({ prompt });
    const r = await resolveInstallAgent({}, {}, { ...o, isTTY: true, skip: false });
    expect(r.agent).toBe("kiro");
  });

  it("no longer offers the (de-listed) dsh backend in the interactive menu", async () => {
    // dsh daemon backend is temporarily offline: it is absent from AGENT_MENU.
    // The numbered menu is [claude-code, codex, kiro, pi] (pi is a wakeable backend
    // now, occupying slot 4), so slot "5" is out of range → falls back to the
    // claude-code default, and the dsh probe is never consulted. (resolveDshPath is
    // retained dormant for when the backend is brought back online.)
    const findDsh = vi.fn(() => "/opt/dsh");
    const o = baseOpts({
      prompt: vi.fn(async () => "5"),
      probes: {
        resolveClaudePath: () => "/bin/claude",
        resolveCodexPath: () => "/bin/codex",
        resolveKiroPath: () => "/bin/kiro-cli",
        resolveDshPath: findDsh,
      },
    });
    const r = await resolveInstallAgent({}, {}, { ...o, isTTY: true, skip: false });
    expect(r.agent).toBe("claude-code");
    expect(findDsh).not.toHaveBeenCalled();
  });

  it("interactive menu: an out-of-range / garbage answer falls back to the default", async () => {
    const prompt = vi.fn(async () => "9");
    const o = baseOpts({ prompt });
    const r = await resolveInstallAgent({}, {}, { ...o, isTTY: true, skip: false });
    expect(r.agent).toBe("claude-code");
  });

  it("does NOT prompt on a TTY when --yes/skip is set (uses default)", async () => {
    const prompt = vi.fn(async () => "2");
    const o = baseOpts({ prompt });
    const r = await resolveInstallAgent({}, {}, { ...o, isTTY: true, skip: true });
    expect(prompt).not.toHaveBeenCalled();
    expect(r.agent).toBe("claude-code");
  });

  it("probes the SELECTED backend's CLI and reports found", async () => {
    const findCodex = vi.fn(() => "/opt/codex");
    const o = baseOpts({ probes: { resolveClaudePath: () => "/bin/claude", resolveCodexPath: findCodex, resolveKiroPath: () => "/bin/kiro-cli" } });
    const r = await resolveInstallAgent({ agent: "codex" }, {}, o);
    expect(findCodex).toHaveBeenCalled();
    expect(r.cliFound).toBe(true);
    expect(r.cliPath).toBe("/opt/codex");
    expect(o.log.mock.calls.flat().join("\n")).toMatch(/found CLI at \/opt\/codex/);
  });

  it("warns (non-fatal) when the selected backend's CLI is missing", async () => {
    const o = baseOpts({ probes: { resolveClaudePath: () => "/bin/claude", resolveCodexPath: () => null, resolveKiroPath: () => "/bin/kiro-cli" } });
    const r = await resolveInstallAgent({ agent: "codex" }, {}, o);
    expect(r.cliFound).toBe(false);
    expect(r.cliPath).toBeNull();
    expect(o.errLog.mock.calls.flat().join("\n")).toMatch(/codex CLI NOT FOUND/);
    // Still resolved + persisted — a missing binary never blocks the install.
    expect(o.writeConfig).toHaveBeenCalledWith({ agent: "codex" });
  });
});
