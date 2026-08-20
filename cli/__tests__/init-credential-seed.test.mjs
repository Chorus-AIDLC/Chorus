// cli/__tests__/init-credential-seed.test.mjs
// Covers the credential-seed step (spec: chorus-init "per-selected-agent credential
// seeding into centralized daemon config", idea broaden-init-plugin-install). The
// step loops ctx.selection and captures ONE key per selected agent, appending each
// as its own agents[] entry tagged with the mapped daemon agentType. Validation /
// append / write are injected; two tests drive the REAL appendAgentConfig +
// writeLoginFile against a temp file to prove agents[] shape + merge-safety.
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedCredentials, credentialSeedStep } from "../init/steps/credential-seed.mjs";
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
    // Flat top-level creds also persisted (resolveCredentials / daemon-setup gate rely on it).
    expect(writeLogin).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://c", apiKey: "cho_k", agentUuid: "uuid-cho_k" }),
    );
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
    // Flat top-level creds present (for resolveCredentials / daemon-setup gate).
    expect(after.url).toBe("https://c");
    expect(after.apiKey).toBe("cho_k");
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
