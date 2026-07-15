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
