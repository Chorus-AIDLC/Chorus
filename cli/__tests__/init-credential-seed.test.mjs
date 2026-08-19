// cli/__tests__/init-credential-seed.test.mjs
// Covers the credential-seed step (spec: chorus-init "One-time credential seeding
// into centralized daemon config"). Validation/write are injected; one test uses
// the REAL writeLoginFile against a temp file to prove merge-safety.
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedCredentials, credentialSeedStep } from "../init/steps/credential-seed.mjs";
import { writeLoginFile } from "../login.mjs";
import { OUTCOME_ACTIONS } from "../init/contracts.mjs";

const { SEEDED, SKIPPED, FAILED } = OUTCOME_ACTIONS;
const identity = { uuid: "agent-123", name: "Test Agent" };

function baseCtx(over = {}) {
  return {
    env: {},
    io: { log: () => {}, isTTY: false },
    flags: {},
    validateCredentials: async () => identity,
    writeLogin: () => {},
    ...over,
  };
}

describe("credentialSeedStep shape", () => {
  it("is a once-scoped step ordered before plugin-install", () => {
    expect(credentialSeedStep.scope).toBe("once");
    expect(credentialSeedStep.order).toBeLessThan(20);
  });
});

describe("seedCredentials — sources", () => {
  it("seeds from --url/--api-key flags, validating then writing", async () => {
    const writes = [];
    const res = await seedCredentials(baseCtx({
      flags: { url: "https://c", apiKey: "cho_k" },
      writeLogin: (d) => writes.push(d),
    }));
    expect(res.action).toBe(SEEDED);
    expect(writes[0]).toEqual({ url: "https://c", apiKey: "cho_k", agentUuid: "agent-123", agentName: "Test Agent" });
  });

  it("seeds from CHORUS_URL/CHORUS_API_KEY env when no flags", async () => {
    const writes = [];
    const res = await seedCredentials(baseCtx({
      env: { CHORUS_URL: "https://e", CHORUS_API_KEY: "cho_e" },
      writeLogin: (d) => writes.push(d),
    }));
    expect(res.action).toBe(SEEDED);
    expect(writes[0].url).toBe("https://e");
  });

  it("prompts on a TTY when flags/env are missing", async () => {
    const asked = [];
    const res = await seedCredentials(baseCtx({
      io: { log: () => {}, isTTY: true },
      promptFn: async (q) => {
        asked.push(q);
        return q.includes("URL") ? "https://p" : "cho_p";
      },
      writeLogin: () => {},
    }));
    expect(res.action).toBe(SEEDED);
    expect(asked.some((q) => q.includes("URL"))).toBe(true);
    expect(asked.some((q) => q.includes("API key"))).toBe(true);
  });
});

describe("seedCredentials — failure & skip", () => {
  it("returns FAILED and does NOT write when validation fails", async () => {
    let wrote = false;
    const res = await seedCredentials(baseCtx({
      flags: { url: "https://c", apiKey: "cho_bad" },
      validateCredentials: async () => { throw new Error("401 invalid key"); },
      writeLogin: () => { wrote = true; },
    }));
    expect(res.action).toBe(FAILED);
    expect(res.detail).toContain("401 invalid key");
    expect(wrote).toBe(false);
  });

  it("skips when no creds are given but a pair already resolves", async () => {
    const res = await seedCredentials(baseCtx({ resolveExisting: () => ({ url: "x", apiKey: "y" }) }));
    expect(res.action).toBe(SKIPPED);
  });

  it("fails (visibly) when no creds are given and none resolve (non-TTY)", async () => {
    const res = await seedCredentials(baseCtx({
      resolveExisting: () => { throw new Error("none"); },
    }));
    expect(res.action).toBe(FAILED);
    expect(res.detail).toContain("no Chorus credentials");
  });
});

describe("seedCredentials — merge-safety (real writeLoginFile)", () => {
  it("preserves pre-existing daemon.json fields (yoloAckAt, cwds) when seeding", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chorus-cfg-"));
    const path = join(dir, "daemon.json");
    writeFileSync(path, JSON.stringify({ yoloAckAt: "2026-01-01T00:00:00Z", cwds: ["/repo"] }));

    const res = await seedCredentials(baseCtx({
      flags: { url: "https://c", apiKey: "cho_k" },
      writeLogin: (data) => writeLoginFile(data, { path }),
    }));
    expect(res.action).toBe(SEEDED);

    const after = JSON.parse(readFileSync(path, "utf8"));
    expect(after.yoloAckAt).toBe("2026-01-01T00:00:00Z"); // preserved
    expect(after.cwds).toEqual(["/repo"]); // preserved
    expect(after.url).toBe("https://c"); // seeded
    expect(after.apiKey).toBe("cho_k");
    expect(after.agentUuid).toBe("agent-123");
  });
});
