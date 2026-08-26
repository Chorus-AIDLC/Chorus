// cli/__tests__/init-credential-seed.test.mjs
// Covers the credential-seed step (spec: chorus-init "per-selected-agent credential
// seeding into centralized daemon config", idea broaden-init-plugin-install). The
// step loops ctx.selection and captures ONE key per selected agent, appending each
// as its own agents[] entry tagged with the mapped daemon agentType. Validation /
// append / write are injected; two tests drive the REAL appendAgentConfig +
// writeLoginFile against a temp file to prove agents[] shape + merge-safety.
import { describe, it, expect, vi } from "vitest";
import { existsSync, mkdtempSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import {
  seedCredentials,
  credentialSeedStep,
  writeDshCredentialsEnv,
  writeClaudeSettingsEnv,
  readClaudeSettingsProfile,
  writeCodexShellEnvCreds,
} from "../init/steps/credential-seed.mjs";
import { appendAgentConfig, writeLoginFile } from "../login.mjs";
import { OUTCOME_ACTIONS } from "../init/contracts.mjs";

const { SEEDED, SKIPPED, FAILED } = OUTCOME_ACTIONS;

/** Identity keyed by apiKey so multi-agent tests get distinct identities. */
function identityFor(apiKey) {
  return { uuid: `uuid-${apiKey}`, name: `Agent ${apiKey}` };
}

/** A fake appendAgentConfig that records calls and dedups by key. */
function fakeAppend() {
  const calls = [];
  const keys = new Set();
  const fn = (obj) => {
    calls.push(obj);
    if (keys.has(obj.apiKey)) return { ok: false, reason: "duplicate" };
    keys.add(obj.apiKey);
    const index = keys.size - 1;
    return { ok: true, path: "/x/daemon.json", agents: [...keys], index };
  };
  fn.calls = calls;
  return fn;
}

function baseCtx(over = {}) {
  return {
    env: {},
    io: { log: () => {}, isTTY: false },
    flags: {},
    selection: ["claude"],
    validateCredentials: async ({ apiKey }) => identityFor(apiKey),
    appendAgent: fakeAppend(),
    writeLogin: vi.fn(),
    // Default: no served cwds (per-agent cwds is opt-in via this resolver). Tests that
    // check per-agent cwds override it. Stubbed so the real resolveInstallCwds (which
    // reads process.cwd / daemon.json) never runs in unit tests.
    resolveInstallCwds: async () => ({ cwds: [] }),
    // Stub the Claude Code settings.json sink so `claude`-selection tests never touch the
    // REAL ~/.claude/settings.json. Tests that assert on the write override these (a
    // recording fake, or the real writer against a temp dir). readClaudeSettingsProfile
    // defaults to "no prior identity" → the write path (no repoint prompt).
    writeClaudeSettings: vi.fn(({ settingsPath }) => settingsPath),
    readClaudeSettingsProfile: () => undefined,
    // Stub the Codex config.toml sink so `codex`-selection tests never touch the REAL
    // ~/.codex/config.toml. Tests that assert on the write override this (a recording
    // fake, or the real writer against a temp CODEX_HOME).
    writeCodexEnv: vi.fn(({ configPath }) => configPath),
    ...over,
  };
}

describe("credentialSeedStep shape", () => {
  it("is a once-scoped step ordered before plugin-install", () => {
    expect(credentialSeedStep.scope).toBe("once");
    expect(credentialSeedStep.order).toBeLessThan(20);
  });
});

describe("seedCredentials — single agent", () => {
  it("seeds the first agent from --url/--api-key, appending an agents[] entry with the mapped agentType", async () => {
    const append = fakeAppend();
    const writeLogin = vi.fn();
    const res = await seedCredentials(
      baseCtx({ flags: { url: "https://c", apiKey: "cho_k" }, append: undefined, appendAgent: append, writeLogin }),
    );
    const outcomes = [].concat(res);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].action).toBe(SEEDED);
    // claude → claude-code (explicit rename), appended as an agents[] entry.
    expect(append.calls[0]).toMatchObject({ url: "https://c", apiKey: "cho_k", agentType: "claude-code" });
    // The flat top-level agent config is DEPRECATED — credentials go ONLY into
    // agents[], never the flat url/apiKey (that duplicated the first agent).
    expect(writeLogin).not.toHaveBeenCalled();
  });

  it("stamps the resolved cwds set PER-AGENT into each agents[] entry (not the top level)", async () => {
    const append = fakeAppend();
    const res = await seedCredentials(
      baseCtx({
        selection: ["claude", "kiro"],
        io: { log: () => {}, isTTY: true },
        flags: { url: "https://c" },
        promptFn: async (q) => (q.includes("claude") ? "cho_c" : "cho_k"),
        appendAgent: append,
        resolveInstallCwds: async () => ({ cwds: ["/repo", "/work"] }),
      }),
    );
    expect([].concat(res).map((o) => o.action)).toEqual([SEEDED, SEEDED]);
    // Each appended agent carries its OWN cwds (the daemon reads cwds per agent).
    expect(append.calls[0].cwds).toEqual(["/repo", "/work"]);
    expect(append.calls[1].cwds).toEqual(["/repo", "/work"]);
  });

  it("omits cwds from the entry when none resolve (daemon then defaults to the process cwd)", async () => {
    const append = fakeAppend();
    await seedCredentials(
      baseCtx({ flags: { url: "https://c", apiKey: "cho_k" }, appendAgent: append, resolveInstallCwds: async () => ({ cwds: [] }) }),
    );
    expect(append.calls[0]).not.toHaveProperty("cwds");
  });

  it("pre-fills the first agent from CHORUS_URL/CHORUS_API_KEY env when no flags", async () => {
    const append = fakeAppend();
    const res = await seedCredentials(
      baseCtx({ env: { CHORUS_URL: "https://e", CHORUS_API_KEY: "cho_e" }, appendAgent: append }),
    );
    expect([].concat(res)[0].action).toBe(SEEDED);
    expect(append.calls[0]).toMatchObject({ url: "https://e", apiKey: "cho_e", agentType: "claude-code" });
  });

  it("prompts for URL once + a key per agent on a TTY", async () => {
    const asked = [];
    const append = fakeAppend();
    const res = await seedCredentials(
      baseCtx({
        io: { log: () => {}, isTTY: true },
        selection: ["claude"],
        promptFn: async (q) => {
          asked.push(q);
          return q.includes("URL") ? "https://p" : "cho_p";
        },
        appendAgent: append,
      }),
    );
    expect([].concat(res)[0].action).toBe(SEEDED);
    expect(asked.some((q) => q.includes("URL"))).toBe(true);
    expect(asked.some((q) => q.includes("API key for claude"))).toBe(true);
    expect(append.calls[0]).toMatchObject({ url: "https://p", apiKey: "cho_p" });
  });

  it("classifies a non-wakeable selection (opencode) as offline", async () => {
    const append = fakeAppend();
    const res = await seedCredentials(
      baseCtx({ selection: ["opencode"], flags: { url: "https://c", apiKey: "cho_o" }, appendAgent: append }),
    );
    expect([].concat(res)[0].action).toBe(SEEDED);
    expect(append.calls[0]).toMatchObject({ agentType: "offline" });
  });
});

describe("seedCredentials — multiple agents (one key each)", () => {
  it("captures a distinct key per agent on a TTY and tags each with its agentType", async () => {
    const append = fakeAppend();
    const res = await seedCredentials(
      baseCtx({
        io: { log: () => {}, isTTY: true },
        selection: ["claude", "codex", "opencode"],
        flags: { url: "https://c" },
        promptFn: async (q) => {
          if (q.includes("claude")) return "cho_claude";
          if (q.includes("codex")) return "cho_codex";
          if (q.includes("opencode")) return "cho_open";
          return "";
        },
        appendAgent: append,
      }),
    );
    const outcomes = [].concat(res);
    expect(outcomes.map((o) => o.action)).toEqual([SEEDED, SEEDED, SEEDED]);
    expect(append.calls.map((c) => [c.apiKey, c.agentType])).toEqual([
      ["cho_claude", "claude-code"],
      ["cho_codex", "codex"],
      ["cho_open", "offline"],
    ]);
  });

  it("non-TTY: seeds the first (pre-filled) agent but REPORTS the others as still needing a key — never reuses one", async () => {
    const append = fakeAppend();
    const res = await seedCredentials(
      baseCtx({
        io: { log: () => {}, isTTY: false },
        selection: ["claude", "codex"],
        flags: { url: "https://c", apiKey: "cho_a" },
        appendAgent: append,
      }),
    );
    const outcomes = [].concat(res);
    expect(outcomes[0].action).toBe(SEEDED); // claude, from --api-key
    expect(outcomes[1].action).toBe(FAILED); // codex — reported, not silently reused
    expect(outcomes[1].detail).toMatch(/still needs its own key/);
    // The first agent's key was NEVER reused for codex.
    expect(append.calls).toHaveLength(1);
    expect(append.calls[0].apiKey).toBe("cho_a");
  });
});

describe("seedCredentials — daemonWake opt-in (default off; offline omits the field)", () => {
  it("defaults daemonWake:false for a wakeable agent (non-TTY, no flag)", async () => {
    const append = fakeAppend();
    await seedCredentials(baseCtx({ selection: ["kiro"], flags: { url: "https://c", apiKey: "cho_k" }, appendAgent: append }));
    expect(append.calls[0].agentType).toBe("kiro");
    expect(append.calls[0].daemonWake).toBe(false);
  });

  it("opts in via --daemon-wake <ids>", async () => {
    const append = fakeAppend();
    await seedCredentials(
      baseCtx({ selection: ["kiro"], flags: { url: "https://c", apiKey: "cho_k", daemonWake: ["kiro"] }, appendAgent: append }),
    );
    expect(append.calls[0].daemonWake).toBe(true);
  });

  it("opts in via --daemon-wake-all", async () => {
    const append = fakeAppend();
    await seedCredentials(
      baseCtx({ selection: ["kiro"], flags: { url: "https://c", apiKey: "cho_k", daemonWakeAll: true }, appendAgent: append }),
    );
    expect(append.calls[0].daemonWake).toBe(true);
  });

  it("prompts per wakeable agent on a TTY (Yes → true, default No)", async () => {
    const append = fakeAppend();
    await seedCredentials(
      baseCtx({
        selection: ["kiro"],
        io: { log: () => {}, isTTY: true },
        flags: { url: "https://c", apiKey: "cho_k" },
        promptFn: async (q) => (String(q).includes("daemon waking") ? "y" : "cho_k"),
        appendAgent: append,
      }),
    );
    expect(append.calls[0].daemonWake).toBe(true);
  });

  it("an offline agent gets NO daemonWake field (can never wake)", async () => {
    const append = fakeAppend();
    await seedCredentials(
      baseCtx({ selection: ["opencode"], flags: { url: "https://c", apiKey: "cho_o", daemonWakeAll: true }, appendAgent: append }),
    );
    expect(append.calls[0].agentType).toBe("offline");
    expect(append.calls[0]).not.toHaveProperty("daemonWake");
  });
});

describe("seedCredentials — failure & idempotency", () => {
  it("returns FAILED for an agent whose key fails validation and does NOT append it", async () => {
    const append = fakeAppend();
    const res = await seedCredentials(
      baseCtx({
        flags: { url: "https://c", apiKey: "cho_bad" },
        validateCredentials: async () => {
          throw new Error("401 invalid key");
        },
        appendAgent: append,
      }),
    );
    const outcomes = [].concat(res);
    expect(outcomes[0].action).toBe(FAILED);
    expect(outcomes[0].detail).toContain("401 invalid key");
    expect(append.calls).toHaveLength(0);
  });

  it("reports SKIPPED when an agent's key already backs a configured agent (idempotent re-run)", async () => {
    const append = fakeAppend();
    const res = await seedCredentials(
      baseCtx({
        selection: ["claude", "codex"],
        io: { log: () => {}, isTTY: true },
        flags: { url: "https://c" },
        // Same key typed for both agents → the second append dedups.
        promptFn: async () => "cho_same",
        appendAgent: append,
      }),
    );
    const outcomes = [].concat(res);
    expect(outcomes[0].action).toBe(SEEDED);
    expect(outcomes[1].action).toBe(SKIPPED);
    expect(outcomes[1].detail).toMatch(/already configured/);
  });

  it("skips entirely (single SKIPPED) when the selection is empty", async () => {
    const res = await seedCredentials(baseCtx({ selection: [] }));
    expect(res.action).toBe(SKIPPED);
    expect(res.detail).toMatch(/no agents selected/);
  });

  it("skips when ctx.selection is absent (not an array)", async () => {
    const res = await seedCredentials(baseCtx({ selection: undefined }));
    expect(res.action).toBe(SKIPPED);
    expect(res.detail).toMatch(/no agents selected/);
  });

  it("non-TTY with NO url at all reports the missing URL + API key and appends nothing", async () => {
    const append = fakeAppend();
    const res = await seedCredentials(baseCtx({ flags: {}, env: {}, appendAgent: append }));
    const outcomes = [].concat(res);
    expect(outcomes[0].action).toBe(FAILED);
    expect(outcomes[0].detail).toMatch(/URL \+ API key/);
    expect(append.calls).toHaveLength(0);
  });
});

describe("seedCredentials — real appendAgentConfig + writeLoginFile (agents[] shape & merge-safety)", () => {
  it("writes each selected agent as an agents[] entry with agentType and preserves yoloAckAt/cwds", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chorus-cfg-"));
    const path = join(dir, "daemon.json");
    writeFileSync(path, JSON.stringify({ yoloAckAt: "2026-01-01T00:00:00Z", cwds: ["/repo"] }));

    const res = await seedCredentials(
      baseCtx({
        selection: ["claude"],
        flags: { url: "https://c", apiKey: "cho_k" },
        appendAgent: (obj) => appendAgentConfig(obj, { path }),
        writeLogin: (data) => writeLoginFile(data, { path }),
      }),
    );
    expect([].concat(res)[0].action).toBe(SEEDED);

    const after = JSON.parse(readFileSync(path, "utf8"));
    // agents[] entry carries the mapped agentType (claude → claude-code).
    expect(after.agents).toHaveLength(1);
    expect(after.agents[0]).toMatchObject({
      url: "https://c",
      apiKey: "cho_k",
      agentType: "claude-code",
      agentUuid: "uuid-cho_k",
    });
    // Flat top-level creds are NOT written (deprecated) — credentials live ONLY in
    // agents[]; resolveCredentials falls back to agents[0] for the flat consumers.
    expect(after.url).toBeUndefined();
    expect(after.apiKey).toBeUndefined();
    // Pre-existing fields preserved.
    expect(after.yoloAckAt).toBe("2026-01-01T00:00:00Z");
    expect(after.cwds).toEqual(["/repo"]);
  });

  it("appends two selected agents to agents[] without disturbing each other", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chorus-cfg-"));
    const path = join(dir, "daemon.json");

    const res = await seedCredentials(
      baseCtx({
        io: { log: () => {}, isTTY: true },
        selection: ["claude", "kiro"],
        flags: { url: "https://c" },
        promptFn: async (q) => (q.includes("claude") ? "cho_c" : "cho_k"),
        appendAgent: (obj) => appendAgentConfig(obj, { path }),
        writeLogin: (data) => writeLoginFile(data, { path }),
      }),
    );
    expect([].concat(res).map((o) => o.action)).toEqual([SEEDED, SEEDED]);

    const after = JSON.parse(readFileSync(path, "utf8"));
    expect(after.agents.map((a) => [a.apiKey, a.agentType])).toEqual([
      ["cho_c", "claude-code"],
      ["cho_k", "kiro"],
    ]);
  });
});

// dsh needs a SECOND credential sink beyond ~/.chorus/daemon.json — $DSH_HOME/.env,
// the channel the retired public/dsh-credentials.sh used to write and the dsh
// doc-mirror wrapper reads when the `chorus` CLI is off PATH. These tests exercise
// the REAL writer against a temp $DSH_HOME (0600 + merge-preserving + idempotent),
// and confirm non-dsh agents get NO .env.
describe("seedCredentials — dsh $DSH_HOME/.env credential channel", () => {
  it("dsh selection: seeds $DSH_HOME/.env (both keys, 0600) AND still seeds daemon.json unchanged; no secret in the outcome", async () => {
    const dshHome = mkdtempSync(join(tmpdir(), "dsh-home-"));
    const append = fakeAppend();
    const res = await seedCredentials(
      baseCtx({
        selection: ["dsh"],
        env: { DSH_HOME: dshHome },
        flags: { url: "https://c", apiKey: "cho_secret" },
        appendAgent: append,
        // Fixed identity name (NOT derived from the key) so the leak assertion below
        // tests the code, not the fake identity helper (which embeds the key in name).
        validateCredentials: async () => ({ uuid: "u-dsh", name: "DSH Agent" }),
      }),
    );
    const outcomes = [].concat(res);
    expect(outcomes[0].action).toBe(SEEDED);

    // daemon.json seeding is UNCHANGED — dsh still maps to the shared "offline"
    // agentType and is appended to agents[] exactly as before.
    expect(append.calls[0]).toMatchObject({ url: "https://c", apiKey: "cho_secret", agentType: "offline" });

    // $DSH_HOME/.env carries both keys and is parseable by node:util parseEnv
    // (matching how chorus-mcp-call.mjs reads it).
    const envPath = join(dshHome, ".env");
    expect(existsSync(envPath)).toBe(true);
    const parsed = parseEnv(readFileSync(envPath, "utf8"));
    expect(parsed.CHORUS_URL).toBe("https://c");
    expect(parsed.CHORUS_API_KEY).toBe("cho_secret");
    // The agent's UUID is persisted as CHORUS_AGENT_PROFILE (a UUID, not a secret) so
    // dsh loads it into the session env; the wrapper reads it from process.env.
    expect(parsed.CHORUS_AGENT_PROFILE).toBe("u-dsh");

    // Owner-only permissions; the secret is NEVER in the reported outcome (only the path).
    expect(statSync(envPath).mode & 0o777).toBe(0o600);
    expect(outcomes[0].detail).not.toContain("cho_secret");
    expect(outcomes[0].detail).toContain(envPath);
    expect(outcomes[0].detail).toContain("CHORUS_AGENT_PROFILE");
    // Flagged so init.mjs skips the manual `export CHORUS_AGENT_PROFILE=…` hint for dsh.
    expect(outcomes[0].profileInEnv).toBe(true);
  });

  it("merge-preserving + idempotent: keeps unrelated keys, upserts CHORUS_* in place (no duplicate lines), stable across re-runs", async () => {
    const dshHome = mkdtempSync(join(tmpdir(), "dsh-home-"));
    const envPath = join(dshHome, ".env");
    writeFileSync(envPath, "FOO=bar\nCHORUS_URL=http://old\nBAZ=qux\n");

    const runSeed = () =>
      seedCredentials(
        baseCtx({
          selection: ["dsh"],
          env: { DSH_HOME: dshHome },
          flags: { url: "https://new", apiKey: "cho_new" },
          appendAgent: fakeAppend(),
        }),
      );

    await runSeed();
    const after1 = readFileSync(envPath, "utf8");
    const parsed = parseEnv(after1);
    expect(parsed.FOO).toBe("bar"); // unrelated line preserved
    expect(parsed.BAZ).toBe("qux"); // unrelated line preserved
    expect(parsed.CHORUS_URL).toBe("https://new"); // upserted in place
    expect(parsed.CHORUS_API_KEY).toBe("cho_new"); // appended
    expect(parsed.CHORUS_AGENT_PROFILE).toBe("uuid-cho_new"); // identity persisted
    // Exactly one CHORUS_URL line — replaced in place, not duplicated.
    expect((after1.match(/^CHORUS_URL=/gm) || []).length).toBe(1);
    expect(after1).not.toContain("http://old");

    // Idempotent: a second run reproduces byte-identical content and keeps 0600.
    await runSeed();
    expect(readFileSync(envPath, "utf8")).toBe(after1);
    expect(statSync(envPath).mode & 0o777).toBe(0o600);
  });

  it("replaces an `export CHORUS_API_KEY=` line in place (dropping the export prefix), preserving other lines", async () => {
    const dshHome = mkdtempSync(join(tmpdir(), "dsh-home-"));
    const envPath = join(dshHome, ".env");
    writeFileSync(envPath, "export CHORUS_API_KEY=cho_old\nOTHER=1\n");

    await seedCredentials(
      baseCtx({
        selection: ["dsh"],
        env: { DSH_HOME: dshHome },
        flags: { url: "https://c", apiKey: "cho_secret" },
        appendAgent: fakeAppend(),
      }),
    );

    const after = readFileSync(envPath, "utf8");
    const parsed = parseEnv(after);
    expect(parsed.OTHER).toBe("1");
    expect(parsed.CHORUS_API_KEY).toBe("cho_secret");
    expect(parsed.CHORUS_URL).toBe("https://c");
    expect(after).not.toContain("cho_old");
    expect((after.match(/CHORUS_API_KEY=/g) || []).length).toBe(1);
  });

  it("non-dsh selection: writes NO $DSH_HOME/.env even when DSH_HOME is set", async () => {
    const dshHome = mkdtempSync(join(tmpdir(), "dsh-home-"));
    await seedCredentials(
      baseCtx({
        selection: ["claude"],
        env: { DSH_HOME: dshHome },
        flags: { url: "https://c", apiKey: "cho_k" },
        appendAgent: fakeAppend(),
      }),
    );
    expect(existsSync(join(dshHome, ".env"))).toBe(false);
  });

  it("writeDshCredentialsEnv creates $DSH_HOME when absent and writes both keys at 0600", () => {
    const base = mkdtempSync(join(tmpdir(), "dsh-base-"));
    const dshHome = join(base, "nested", ".dsh"); // does not exist yet
    const p = writeDshCredentialsEnv({ dshHome, url: "https://c", apiKey: "cho_k" });
    expect(p).toBe(join(dshHome, ".env"));
    expect(existsSync(p)).toBe(true);
    expect(parseEnv(readFileSync(p, "utf8"))).toMatchObject({
      CHORUS_URL: "https://c",
      CHORUS_API_KEY: "cho_k",
    });
    // No agentProfile passed → no CHORUS_AGENT_PROFILE line (the key is optional).
    expect(parseEnv(readFileSync(p, "utf8")).CHORUS_AGENT_PROFILE).toBeUndefined();
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });

  it("writeDshCredentialsEnv upserts CHORUS_AGENT_PROFILE when provided; a later profile-less write preserves it", () => {
    const base = mkdtempSync(join(tmpdir(), "dsh-prof-"));
    const dshHome = join(base, ".dsh");
    const p = writeDshCredentialsEnv({ dshHome, url: "https://c", apiKey: "cho_k", agentProfile: "agent-uuid-1" });
    expect(parseEnv(readFileSync(p, "utf8")).CHORUS_AGENT_PROFILE).toBe("agent-uuid-1");
    // Exactly one profile line — no duplication.
    expect((readFileSync(p, "utf8").match(/^CHORUS_AGENT_PROFILE=/gm) || []).length).toBe(1);
    // A later write WITHOUT a profile upserts the credential keys and leaves the
    // existing profile line untouched (managed-keys-only rewrite; unrelated preserved).
    writeDshCredentialsEnv({ dshHome, url: "https://c2", apiKey: "cho_k2" });
    const parsed = parseEnv(readFileSync(p, "utf8"));
    expect(parsed.CHORUS_URL).toBe("https://c2");
    expect(parsed.CHORUS_API_KEY).toBe("cho_k2");
    expect(parsed.CHORUS_AGENT_PROFILE).toBe("agent-uuid-1");
  });
});

// ---------------------------------------------------------------------------
// Claude Code — the user-global ~/.claude/settings.json `env` sink. The writer
// mirrors writeDshCredentialsEnv (idempotent, 0600, atomic, key never echoed) but
// targets a JSON object. Interactive Claude Code injects settings.json env at
// session start, so this one write feeds native MCP + hooks + skill CLI.
// ---------------------------------------------------------------------------
describe("writeClaudeSettingsEnv (real writer)", () => {
  it("creates a missing settings.json with the 3 managed keys under env, at 0600", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-home-"));
    const p = join(dir, "nested", ".claude", "settings.json"); // dir does not exist yet
    const ret = writeClaudeSettingsEnv({ settingsPath: p, url: "https://c", apiKey: "cho_k", agentProfile: "u-1" });
    expect(ret).toBe(p);
    expect(existsSync(p)).toBe(true);
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    expect(parsed.env).toMatchObject({ CHORUS_URL: "https://c", CHORUS_API_KEY: "cho_k", CHORUS_AGENT_PROFILE: "u-1" });
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });

  it("preserves other env keys AND every other top-level field verbatim", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-home-"));
    const p = join(dir, "settings.json");
    writeFileSync(
      p,
      JSON.stringify({ model: "opus", env: { FOO: "bar", CHORUS_URL: "http://old" }, permissions: { allow: ["Read"] } }),
    );
    writeClaudeSettingsEnv({ settingsPath: p, url: "https://new", apiKey: "cho_new", agentProfile: "u-2" });
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    expect(parsed.model).toBe("opus"); // top-level preserved
    expect(parsed.permissions).toEqual({ allow: ["Read"] }); // top-level preserved
    expect(parsed.env.FOO).toBe("bar"); // unrelated env key preserved
    expect(parsed.env.CHORUS_URL).toBe("https://new"); // managed key upserted in place
    expect(parsed.env.CHORUS_API_KEY).toBe("cho_new");
    expect(parsed.env.CHORUS_AGENT_PROFILE).toBe("u-2");
  });

  it("THROWS on existing malformed JSON and does NOT clobber the file", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-home-"));
    const p = join(dir, "settings.json");
    writeFileSync(p, "{ this is not json ");
    expect(() => writeClaudeSettingsEnv({ settingsPath: p, url: "https://c", apiKey: "cho_k", agentProfile: "u" })).toThrow(
      /not valid JSON/,
    );
    expect(readFileSync(p, "utf8")).toBe("{ this is not json "); // untouched
  });

  it("THROWS on a present-but-non-object env block (no clobber)", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-home-"));
    const p = join(dir, "settings.json");
    writeFileSync(p, JSON.stringify({ env: "oops" }));
    expect(() => writeClaudeSettingsEnv({ settingsPath: p, url: "https://c", apiKey: "cho_k", agentProfile: "u" })).toThrow(
      /non-object "env"/,
    );
  });

  it("is idempotent: a re-run reproduces byte-identical content and keeps 0600", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-home-"));
    const p = join(dir, "settings.json");
    writeClaudeSettingsEnv({ settingsPath: p, url: "https://c", apiKey: "cho_k", agentProfile: "u-1" });
    const first = readFileSync(p, "utf8");
    writeClaudeSettingsEnv({ settingsPath: p, url: "https://c", apiKey: "cho_k", agentProfile: "u-1" });
    expect(readFileSync(p, "utf8")).toBe(first);
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });
});

describe("readClaudeSettingsProfile", () => {
  it("returns the CHORUS_AGENT_PROFILE from an existing env block", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-home-"));
    const p = join(dir, "settings.json");
    writeFileSync(p, JSON.stringify({ env: { CHORUS_AGENT_PROFILE: "u-42", FOO: "bar" } }));
    expect(readClaudeSettingsProfile(p)).toBe("u-42");
  });

  it("returns undefined for a missing file, malformed JSON, or an env-less file", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-home-"));
    expect(readClaudeSettingsProfile(join(dir, "nope.json"))).toBeUndefined();
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{ not json");
    expect(readClaudeSettingsProfile(bad)).toBeUndefined();
    const noenv = join(dir, "noenv.json");
    writeFileSync(noenv, JSON.stringify({ model: "opus" }));
    expect(readClaudeSettingsProfile(noenv)).toBeUndefined();
  });
});

/** A recording fake for ctx.writeClaudeSettings — captures args, returns the path. */
function fakeClaudeWrite(overrideFn) {
  const calls = [];
  const fn = (args) => {
    calls.push(args);
    if (overrideFn) return overrideFn(args);
    return args.settingsPath;
  };
  fn.calls = calls;
  return fn;
}

describe("seedCredentials — Claude Code settings.json env sink", () => {
  it("fresh claude (no prior profile): writes settings.json, sets settingsEnvWritten, never leaks the key", async () => {
    const write = fakeClaudeWrite();
    const res = await seedCredentials(
      baseCtx({
        selection: ["claude"],
        flags: { url: "https://c", apiKey: "cho_secret" },
        appendAgent: fakeAppend(),
        writeClaudeSettings: write,
        readClaudeSettingsProfile: () => undefined,
        validateCredentials: async () => ({ uuid: "u-new", name: "New Agent" }),
      }),
    );
    const o = [].concat(res)[0];
    expect(o.action).toBe(SEEDED);
    expect(o.settingsEnvWritten).toBe(true);
    expect(write.calls[0]).toMatchObject({ url: "https://c", apiKey: "cho_secret", agentProfile: "u-new" });
    expect(o.detail).not.toContain("cho_secret"); // key never echoed
    expect(o.detail).toMatch(/settings\.json \(0600\)/);
  });

  it("same identity: idempotent write with no repoint prompt/warning", async () => {
    const write = fakeClaudeWrite();
    const asked = [];
    const res = await seedCredentials(
      baseCtx({
        selection: ["claude"],
        flags: { url: "https://c", apiKey: "cho_k" },
        appendAgent: fakeAppend(),
        writeClaudeSettings: write,
        readClaudeSettingsProfile: () => "u-same",
        promptFn: async (q) => {
          asked.push(q);
          return "";
        },
        validateCredentials: async () => ({ uuid: "u-same", name: "Same Agent" }),
      }),
    );
    const o = [].concat(res)[0];
    expect(o.settingsEnvWritten).toBe(true);
    expect(write.calls).toHaveLength(1);
    expect(asked.some((q) => /repoint/i.test(q))).toBe(false);
    expect(o.detail).not.toMatch(/repoint|WARNING/);
  });

  it("different identity, non-TTY: overwrites and WARNS naming old→new", async () => {
    const write = fakeClaudeWrite();
    const res = await seedCredentials(
      baseCtx({
        selection: ["claude"],
        io: { log: () => {}, isTTY: false },
        flags: { url: "https://c", apiKey: "cho_k" },
        appendAgent: fakeAppend(),
        writeClaudeSettings: write,
        readClaudeSettingsProfile: () => "u-OLD",
        validateCredentials: async () => ({ uuid: "u-NEW", name: "New Agent" }),
      }),
    );
    const o = [].concat(res)[0];
    expect(write.calls).toHaveLength(1); // overwrote
    expect(o.settingsEnvWritten).toBe(true);
    expect(o.detail).toMatch(/repointed interactive Claude Code from u-OLD to u-NEW/);
  });

  it("different identity, TTY declined: no write, directs to edit the file (not export)", async () => {
    const write = fakeClaudeWrite();
    const res = await seedCredentials(
      baseCtx({
        selection: ["claude"],
        io: { log: () => {}, isTTY: true },
        flags: { url: "https://c", apiKey: "cho_k" },
        appendAgent: fakeAppend(),
        writeClaudeSettings: write,
        readClaudeSettingsProfile: () => "u-OLD",
        promptFn: async (q) => (/repoint/i.test(q) ? "n" : /daemon waking/i.test(q) ? "n" : ""),
        validateCredentials: async () => ({ uuid: "u-NEW", name: "New Agent" }),
      }),
    );
    const o = [].concat(res)[0];
    expect(write.calls).toHaveLength(0); // declined → not written
    expect(o.settingsEnvWritten).toBeUndefined();
    expect(o.detail).toMatch(/left interactive Claude Code as u-OLD/);
    expect(o.detail).toMatch(/edit .*settings\.json/);
    // Directs to the FILE and clarifies a shell export would be overridden — it does NOT
    // offer exporting as a remedy (settings.json env wins).
    expect(o.detail).toMatch(/export would be overridden by settings\.json/);
  });

  it("write failure: actionable WARNING, no settingsEnvWritten, key never printed", async () => {
    const write = fakeClaudeWrite(() => {
      throw new Error("EACCES: permission denied");
    });
    const res = await seedCredentials(
      baseCtx({
        selection: ["claude"],
        flags: { url: "https://c", apiKey: "cho_secret" },
        appendAgent: fakeAppend(),
        writeClaudeSettings: write,
        readClaudeSettingsProfile: () => undefined,
        validateCredentials: async () => ({ uuid: "u-new", name: "New Agent" }),
      }),
    );
    const o = [].concat(res)[0];
    expect(o.settingsEnvWritten).toBeUndefined();
    expect(o.detail).toMatch(/could not write/);
    expect(o.detail).toMatch(/CHORUS_URL, CHORUS_API_KEY and CHORUS_AGENT_PROFILE/);
    expect(o.detail).not.toContain("cho_secret");
  });

  it("ambient-shell heads-up: notes a different exported identity (non-secret)", async () => {
    const write = fakeClaudeWrite();
    const res = await seedCredentials(
      baseCtx({
        selection: ["claude"],
        env: { CHORUS_AGENT_PROFILE: "u-OTHER" }, // shell exports a different identity
        flags: { url: "https://c", apiKey: "cho_secret" },
        appendAgent: fakeAppend(),
        writeClaudeSettings: write,
        readClaudeSettingsProfile: () => undefined,
        validateCredentials: async () => ({ uuid: "u-new", name: "New Agent" }),
      }),
    );
    const o = [].concat(res)[0];
    expect(o.detail).toMatch(/your shell exports a different CHORUS_\* identity/);
    expect(o.detail).not.toContain("cho_secret");
  });

  it("no heads-up when the shell exports the SAME identity", async () => {
    const write = fakeClaudeWrite();
    const res = await seedCredentials(
      baseCtx({
        selection: ["claude"],
        env: { CHORUS_AGENT_PROFILE: "u-new" }, // same as the identity being written
        flags: { url: "https://c", apiKey: "cho_k" },
        appendAgent: fakeAppend(),
        writeClaudeSettings: write,
        readClaudeSettingsProfile: () => undefined,
        validateCredentials: async () => ({ uuid: "u-new", name: "New Agent" }),
      }),
    );
    expect([].concat(res)[0].detail).not.toMatch(/your shell exports a different/);
  });

  it("non-claude selection: never touches settings.json", async () => {
    const write = fakeClaudeWrite();
    await seedCredentials(
      baseCtx({
        selection: ["codex"],
        flags: { url: "https://c", apiKey: "cho_k" },
        appendAgent: fakeAppend(),
        writeClaudeSettings: write,
      }),
    );
    expect(write.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Codex — the ~/.codex/config.toml `[shell_environment_policy].set` sink. Codex's
// native MCP is already export-free (literal Bearer in config.toml), but the plugin
// hooks need CHORUS_URL/CHORUS_API_KEY/CHORUS_AGENT_PROFILE in the env (they never
// auto-single). The writer does a TARGETED TEXTUAL upsert (no TOML-parser dep) that
// preserves the literal [mcp_servers.chorus] block, 0600, idempotent, key never echoed.
// ---------------------------------------------------------------------------
describe("writeCodexShellEnvCreds (real writer)", () => {
  it("creates a missing config.toml with the 3 keys under [shell_environment_policy.set], at 0600", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-home-"));
    const p = join(dir, "nested", ".codex", "config.toml"); // dir does not exist yet
    const ret = writeCodexShellEnvCreds({ configPath: p, url: "https://c", apiKey: "cho_k", agentProfile: "u-1" });
    expect(ret).toBe(p);
    expect(existsSync(p)).toBe(true);
    const txt = readFileSync(p, "utf8");
    expect(txt).toMatch(/^\[shell_environment_policy\.set\]$/m);
    expect(txt).toContain('CHORUS_URL = "https://c"');
    expect(txt).toContain('CHORUS_API_KEY = "cho_k"');
    expect(txt).toContain('CHORUS_AGENT_PROFILE = "u-1"');
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });

  it("preserves the literal [mcp_servers.chorus] Bearer + upserts into an existing [shell_environment_policy.set] in place", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-home-"));
    const p = join(dir, "config.toml");
    writeFileSync(
      p,
      [
        "# my codex config",
        "[mcp_servers.chorus]",
        'url = "https://c/api/mcp"',
        "",
        "[mcp_servers.chorus.http_headers]",
        'Authorization = "Bearer cho_LITERAL"',
        "",
        "[shell_environment_policy.set]",
        'CHORUS_URL = "http://old"',
        'FOO = "keep"',
        "",
      ].join("\n"),
    );
    writeCodexShellEnvCreds({ configPath: p, url: "https://new", apiKey: "cho_new", agentProfile: "u-2" });
    const txt = readFileSync(p, "utf8");
    // Literal Bearer + its section + a leading comment survive verbatim.
    expect(txt).toContain("# my codex config");
    expect(txt).toContain("[mcp_servers.chorus.http_headers]");
    expect(txt).toContain('Authorization = "Bearer cho_LITERAL"');
    // Unrelated key inside the managed section is preserved.
    expect(txt).toContain('FOO = "keep"');
    // Managed keys upserted in place — no duplicate, old value gone.
    expect(txt).toContain('CHORUS_URL = "https://new"');
    expect(txt).not.toContain("http://old");
    expect(txt).toContain('CHORUS_API_KEY = "cho_new"');
    expect(txt).toContain('CHORUS_AGENT_PROFILE = "u-2"');
    expect((txt.match(/^CHORUS_URL = /gm) || []).length).toBe(1);
  });

  it("appends a fresh [shell_environment_policy.set] section when the file has content but no shell_environment_policy", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-home-"));
    const p = join(dir, "config.toml");
    writeFileSync(p, '[mcp_servers.chorus]\nurl = "https://c/api/mcp"\n');
    writeCodexShellEnvCreds({ configPath: p, url: "https://c", apiKey: "cho_k", agentProfile: "u-3" });
    const txt = readFileSync(p, "utf8");
    expect(txt).toContain("[mcp_servers.chorus]"); // preserved
    expect(txt).toMatch(/^\[shell_environment_policy\.set\]$/m); // appended
    expect(txt).toContain('CHORUS_AGENT_PROFILE = "u-3"');
  });

  it("THROWS on an ambiguous inline `set = { … }` under [shell_environment_policy] and does NOT clobber", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-home-"));
    const p = join(dir, "config.toml");
    const original = '[shell_environment_policy]\nset = { FOO = "bar" }\n';
    writeFileSync(p, original);
    expect(() => writeCodexShellEnvCreds({ configPath: p, url: "https://c", apiKey: "cho_k", agentProfile: "u" })).toThrow(
      /inline .*set|cannot safely edit|refus/i,
    );
    expect(readFileSync(p, "utf8")).toBe(original); // untouched
  });

  it("is idempotent: a re-run reproduces byte-identical content and keeps 0600", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-home-"));
    const p = join(dir, "config.toml");
    writeCodexShellEnvCreds({ configPath: p, url: "https://c", apiKey: "cho_k", agentProfile: "u-1" });
    const first = readFileSync(p, "utf8");
    writeCodexShellEnvCreds({ configPath: p, url: "https://c", apiKey: "cho_k", agentProfile: "u-1" });
    expect(readFileSync(p, "utf8")).toBe(first);
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });
});

/** A recording fake for ctx.writeCodexEnv — captures args, returns the path. */
function fakeCodexWrite(overrideFn) {
  const calls = [];
  const fn = (args) => {
    calls.push(args);
    if (overrideFn) return overrideFn(args);
    return args.configPath;
  };
  fn.calls = calls;
  return fn;
}

describe("seedCredentials — Codex config.toml env sink", () => {
  it("single codex: writes config.toml under CODEX_HOME, sets codexEnvWritten, never leaks the key", async () => {
    const write = fakeCodexWrite();
    const res = await seedCredentials(
      baseCtx({
        selection: ["codex"],
        env: { CODEX_HOME: "/tmp/xyz-codex-home" },
        flags: { url: "https://c", apiKey: "cho_secret" },
        appendAgent: fakeAppend(),
        writeCodexEnv: write,
        validateCredentials: async () => ({ uuid: "u-new", name: "Codex Agent" }),
      }),
    );
    const o = [].concat(res)[0];
    expect(o.action).toBe(SEEDED);
    expect(o.codexEnvWritten).toBe(true);
    expect(write.calls[0]).toMatchObject({
      configPath: join("/tmp/xyz-codex-home", "config.toml"),
      url: "https://c",
      apiKey: "cho_secret",
      agentProfile: "u-new",
    });
    expect(o.detail).not.toContain("cho_secret"); // key never echoed
    expect(o.detail).toMatch(/config\.toml \(0600\)/);
  });

  it("success note surfaces the interactive-hook residual (task-2 spike): names the 3 keys + export, no key value, no wrapper", async () => {
    // Verified in the task-2 spike: [shell_environment_policy].set reaches Codex's shell
    // tool but NOT its plugin hooks (they inherit Codex's process env). So the success note
    // must tell the operator how to wire the hooks interactively — surfaced, not suppressed.
    const write = fakeCodexWrite();
    const res = await seedCredentials(
      baseCtx({
        selection: ["codex"],
        flags: { url: "https://c", apiKey: "cho_secret" },
        appendAgent: fakeAppend(),
        writeCodexEnv: write,
        validateCredentials: async () => ({ uuid: "u-new", name: "Codex Agent" }),
      }),
    );
    const o = [].concat(res)[0];
    expect(o.codexEnvWritten).toBe(true);
    expect(o.detail).toMatch(/hook/i); // the residual is named
    expect(o.detail).toMatch(/CHORUS_URL/);
    expect(o.detail).toMatch(/CHORUS_API_KEY/);
    expect(o.detail).toMatch(/CHORUS_AGENT_PROFILE/);
    expect(o.detail).toMatch(/export/i); // directs to export for interactive hooks
    expect(o.detail).not.toContain("cho_secret"); // key value never echoed
    expect(o.detail).not.toMatch(/wrapper|chorus launch/i); // owner rejected the wrapper
  });

  it("multi-agent (claude+codex): the codex entry is written via writeCodexEnv with its own identity", async () => {
    const codexWrite = fakeCodexWrite();
    const claudeWrite = fakeClaudeWrite();
    const res = await seedCredentials(
      baseCtx({
        io: { log: () => {}, isTTY: true },
        selection: ["claude", "codex"],
        flags: { url: "https://c" },
        promptFn: async (q) => (q.includes("claude") ? "cho_c" : "cho_x"),
        appendAgent: fakeAppend(),
        writeClaudeSettings: claudeWrite,
        writeCodexEnv: codexWrite,
        validateCredentials: async ({ apiKey }) => ({ uuid: `u-${apiKey}`, name: `Agent ${apiKey}` }),
      }),
    );
    const outcomes = [].concat(res);
    expect(outcomes.map((o) => o.action)).toEqual([SEEDED, SEEDED]);
    // Codex written exactly once, with the codex identity (not claude's).
    expect(codexWrite.calls).toHaveLength(1);
    expect(codexWrite.calls[0]).toMatchObject({ apiKey: "cho_x", agentProfile: "u-cho_x" });
    expect(outcomes[1].codexEnvWritten).toBe(true);
  });

  it("write failure: actionable WARNING names the 3 keys, no codexEnvWritten, key never printed, no wrapper", async () => {
    const write = fakeCodexWrite(() => {
      throw new Error("EACCES: permission denied");
    });
    const res = await seedCredentials(
      baseCtx({
        selection: ["codex"],
        flags: { url: "https://c", apiKey: "cho_secret" },
        appendAgent: fakeAppend(),
        writeCodexEnv: write,
        validateCredentials: async () => ({ uuid: "u-new", name: "Codex Agent" }),
      }),
    );
    const o = [].concat(res)[0];
    expect(o.codexEnvWritten).toBeUndefined();
    expect(o.detail).toMatch(/could not write/);
    expect(o.detail).toMatch(/CHORUS_URL/);
    expect(o.detail).toMatch(/CHORUS_API_KEY/);
    expect(o.detail).toMatch(/CHORUS_AGENT_PROFILE/);
    expect(o.detail).not.toContain("cho_secret");
    expect(o.detail).not.toMatch(/wrapper|chorus launch/i);
  });

  it("non-codex selection (claude): never calls writeCodexEnv", async () => {
    const write = fakeCodexWrite();
    await seedCredentials(
      baseCtx({
        selection: ["claude"],
        flags: { url: "https://c", apiKey: "cho_k" },
        appendAgent: fakeAppend(),
        writeCodexEnv: write,
        writeClaudeSettings: fakeClaudeWrite(),
      }),
    );
    expect(write.calls).toHaveLength(0);
  });
});
