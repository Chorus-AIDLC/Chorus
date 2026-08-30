// cli/__tests__/init-file-template.test.mjs
// Covers the kiro native file-template installer (spec: agent-plugin-install
// "kiro plugin installed via a native cross-platform file-template"):
//   - cli/init/file-template.mjs pure helpers + installFileTemplate (temp dir +
//     a FAKED fetch — never hits the network),
//   - installKiro / readKiroInstallState in cli/init/install-methods.mjs,
//   - and that the shared kiro manifest is readable + non-empty. The manifest is
//     now owned SOLELY by file-template.mjs — install-kiro.sh is a deprecation
//     stub with no manifest, so the old bash-side parity assertion is gone.
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseManifest,
  readKiroManifestFile,
  normalizeAssetBase,
  substituteChorusBin,
  mergeChorusServer,
  installFileTemplate,
  KIRO_MANIFEST_URL,
} from "../init/file-template.mjs";
import { installKiro, readKiroInstallState } from "../init/install-methods.mjs";
import { OUTCOME_ACTIONS } from "../init/contracts.mjs";

const { INSTALLED, REPAIRED, SKIPPED, FAILED } = OUTCOME_ACTIONS;

const tmp = (p) => mkdtempSync(join(tmpdir(), p));

// A small SYNTHETIC manifest so tests control the exact asset set (3 skills / 1
// reviewer / 1 hook). Comment + blank lines exercise the parser's skips.
const SYNTH_MANIFEST = `# Chorus kiro manifest (test)
skill chorus-idea
skill chorus-yolo
skill chorus-orchestrate

reviewer chorus-task-reviewer
hook on-stop.sh
bogus should-be-ignored
`;

const CHORUS_JSON_TEMPLATE = JSON.stringify(
  { name: "chorus", hooks: { stop: [{ command: "__CHORUS_BIN__/on-stop.sh" }] } },
  null,
  2,
);

const MCP_TEMPLATE = JSON.stringify(
  {
    mcpServers: {
      chorus: {
        type: "http",
        url: "${CHORUS_URL}/api/mcp",
        headers: { Authorization: "Bearer ${env:CHORUS_API_KEY}" },
        disabled: false,
      },
    },
  },
  null,
  2,
);

/** Build the full route table (rel-suffix -> content) for a valid template. */
function fullRoutes(manifestText = SYNTH_MANIFEST) {
  const { skills, reviewerAgents, hookScripts } = parseManifest(manifestText);
  const routes = {
    "/kiro-plugin/manifest.txt": manifestText,
    "/kiro-plugin/.kiro/settings/mcp.json": MCP_TEMPLATE,
    "/kiro-plugin/.kiro/steering/chorus.md": "# steering",
    "/kiro-plugin/.kiro/agents/chorus.md": "# main agent prompt",
    "/kiro-plugin/.kiro/agents/chorus.json": CHORUS_JSON_TEMPLATE,
  };
  for (const a of reviewerAgents) routes[`/kiro-plugin/.kiro/agents/${a}.json`] = `{"name":"${a}"}`;
  for (const s of skills) routes[`/kiro-plugin/.kiro/skills/${s}/SKILL.md`] = `# ${s}`;
  for (const h of hookScripts) routes[`/kiro-plugin/bin/${h}`] = `#!/usr/bin/env bash\n# ${h}\n`;
  return routes;
}

/** A fake `fetch` serving `routes`, optionally 404ing any URL containing `fail`. */
function makeFetch(routes, { fail } = {}) {
  const seen = [];
  const impl = async (url) => {
    seen.push(url);
    if (fail && url.includes(fail)) return { ok: false, status: 404, text: async () => "not found" };
    for (const suffix of Object.keys(routes)) {
      if (url.endsWith(suffix)) return { ok: true, status: 200, text: async () => routes[suffix] };
    }
    return { ok: false, status: 404, text: async () => "no route" };
  };
  impl.seen = seen;
  return impl;
}

describe("parseManifest", () => {
  it("splits kind/name lines, ignoring blanks, comments, and unknown kinds", () => {
    expect(parseManifest(SYNTH_MANIFEST)).toEqual({
      skills: ["chorus-idea", "chorus-yolo", "chorus-orchestrate"],
      reviewerAgents: ["chorus-task-reviewer"],
      hookScripts: ["on-stop.sh"],
    });
  });
  it("returns empty lists for empty / all-comment input", () => {
    expect(parseManifest("")).toEqual({ skills: [], reviewerAgents: [], hookScripts: [] });
    expect(parseManifest("# only\n#comments\n")).toEqual({ skills: [], reviewerAgents: [], hookScripts: [] });
    expect(parseManifest(null)).toEqual({ skills: [], reviewerAgents: [], hookScripts: [] });
  });
  it("skips a kind with no name token", () => {
    expect(parseManifest("skill\nhook \n").hookScripts).toEqual([]);
  });
});

describe("normalizeAssetBase", () => {
  it("strips a trailing /api/mcp and any trailing slash", () => {
    expect(normalizeAssetBase("https://x.dev/api/mcp")).toBe("https://x.dev");
    expect(normalizeAssetBase("https://x.dev/api/mcp/")).toBe("https://x.dev");
    expect(normalizeAssetBase("https://x.dev/")).toBe("https://x.dev");
    expect(normalizeAssetBase("http://localhost:8637")).toBe("http://localhost:8637");
  });
  it("throws (naming the problem) on empty or non-http(s) input", () => {
    expect(() => normalizeAssetBase("")).toThrow(/CHORUS_URL is not set/);
    expect(() => normalizeAssetBase("ftp://x")).toThrow(/http/);
  });
});

describe("substituteChorusBin", () => {
  it("replaces every __CHORUS_BIN__ with the absolute path", () => {
    const out = substituteChorusBin(CHORUS_JSON_TEMPLATE, "/home/u/.kiro/chorus-bin");
    expect(out).toContain("/home/u/.kiro/chorus-bin/on-stop.sh");
    expect(out).not.toContain("__CHORUS_BIN__");
  });
  it("throws loudly if a placeholder would survive substitution", () => {
    // A replacement value that itself re-introduces the token proves the guard fires.
    expect(() => substituteChorusBin("x __CHORUS_BIN__ y", "/a/__CHORUS_BIN__/b")).toThrow(/not fully substituted/);
  });
  it("is a no-op (no throw) when there is no placeholder", () => {
    expect(substituteChorusBin('{"a":1}', "/bin")).toBe('{"a":1}');
  });
});

describe("mergeChorusServer", () => {
  const server = { type: "http", url: "${CHORUS_URL}/api/mcp" };
  it("creates a fresh document from empty input", () => {
    const merged = JSON.parse(mergeChorusServer("", server));
    expect(merged.mcpServers.chorus).toEqual(server);
  });
  it("preserves pre-existing servers", () => {
    const existing = JSON.stringify({ mcpServers: { other: { type: "stdio" } }, someUserKey: 1 });
    const merged = JSON.parse(mergeChorusServer(existing, server));
    expect(merged.mcpServers.other).toEqual({ type: "stdio" });
    expect(merged.mcpServers.chorus).toEqual(server);
    expect(merged.someUserKey).toBe(1);
  });
  it("recovers when mcpServers is a non-object / the doc is an array", () => {
    expect(JSON.parse(mergeChorusServer(JSON.stringify({ mcpServers: 7 }), server)).mcpServers.chorus).toEqual(server);
    expect(JSON.parse(mergeChorusServer("[1,2]", server)).mcpServers.chorus).toEqual(server);
  });
  it("throws on invalid existing JSON (never clobbers an unparseable file)", () => {
    expect(() => mergeChorusServer("{ not json", server)).toThrow(/not valid JSON/);
  });
});

describe("installFileTemplate (temp dir + faked fetch)", () => {
  it("downloads, writes the tree, substitutes __CHORUS_BIN__, and merges the chorus server", async () => {
    const kiroDir = join(tmp("kiro-"), ".kiro");
    const fetchImpl = makeFetch(fullRoutes());
    const logs = [];
    const res = await installFileTemplate({ chorusUrl: "https://x.dev/api/mcp", kiroDir, fetchImpl, log: (m) => logs.push(m) });

    expect(res).toMatchObject({ skills: 3, reviewerAgents: 1, hookScripts: 1 });
    expect(logs.join("\n")).toContain(kiroDir); // log hook fired
    // skills + reviewer + main agent + steering
    expect(existsSync(join(kiroDir, "skills", "chorus-idea", "SKILL.md"))).toBe(true);
    expect(existsSync(join(kiroDir, "skills", "chorus-yolo", "SKILL.md"))).toBe(true);
    expect(existsSync(join(kiroDir, "skills", "chorus-orchestrate", "SKILL.md"))).toBe(true);
    expect(existsSync(join(kiroDir, "agents", "chorus-task-reviewer.json"))).toBe(true);
    expect(existsSync(join(kiroDir, "agents", "chorus.md"))).toBe(true);
    expect(existsSync(join(kiroDir, "steering", "chorus.md"))).toBe(true);

    // __CHORUS_BIN__ concretized to the absolute chorus-bin path (no survivor)
    const agent = readFileSync(join(kiroDir, "agents", "chorus.json"), "utf8");
    expect(agent).toContain(join(kiroDir, "chorus-bin", "on-stop.sh"));
    expect(agent).not.toContain("__CHORUS_BIN__");

    // hook dropped into chorus-bin/ and (on POSIX) executable
    const hook = join(kiroDir, "chorus-bin", "on-stop.sh");
    expect(existsSync(hook)).toBe(true);
    if (process.platform !== "win32") expect(statSync(hook).mode & 0o111).toBeGreaterThan(0);

    // chorus server merged: url is BAKED to the concrete endpoint (kiro can't
    // interpolate a bare ${CHORUS_URL} in the url field → "relative URL without a
    // base"), while the API key STAYS the ${env:...} ref kiro does resolve.
    const mcp = JSON.parse(readFileSync(join(kiroDir, "settings", "mcp.json"), "utf8"));
    expect(mcp.mcpServers.chorus.url).toBe("https://x.dev/api/mcp");
    expect(mcp.mcpServers.chorus.url).not.toContain("${"); // no un-interpolable token
    expect(mcp.mcpServers.chorus.url).toMatch(/^https?:\/\//); // absolute (has a scheme)
    expect(mcp.mcpServers.chorus.headers.Authorization).toBe("Bearer ${env:CHORUS_API_KEY}");
  });

  it("preserves a pre-existing user server and backs up settings/mcp.json first", async () => {
    const kiroDir = join(tmp("kiro-"), ".kiro");
    mkdirSync(join(kiroDir, "settings"), { recursive: true });
    writeFileSync(
      join(kiroDir, "settings", "mcp.json"),
      JSON.stringify({ mcpServers: { mine: { type: "stdio" } } }),
    );
    const backups = [];
    await installFileTemplate({
      chorusUrl: "https://x.dev",
      kiroDir,
      fetchImpl: makeFetch(fullRoutes()),
      backup: (p) => backups.push(p),
    });
    expect(backups).toEqual([join(kiroDir, "settings", "mcp.json")]);
    const mcp = JSON.parse(readFileSync(join(kiroDir, "settings", "mcp.json"), "utf8"));
    expect(mcp.mcpServers.mine).toEqual({ type: "stdio" });
    expect(mcp.mcpServers.chorus).toBeTruthy();
  });

  it("skips chmod on win32 (still writes the hook)", async () => {
    const kiroDir = join(tmp("kiro-"), ".kiro");
    await installFileTemplate({ chorusUrl: "https://x.dev", kiroDir, fetchImpl: makeFetch(fullRoutes()), platform: "win32" });
    expect(existsSync(join(kiroDir, "chorus-bin", "on-stop.sh"))).toBe(true);
  });

  it("aborts naming the unreachable URL and leaves NO partial drop", async () => {
    const kiroDir = join(tmp("kiro-"), ".kiro");
    const fetchImpl = makeFetch(fullRoutes(), { fail: "skills/chorus-yolo/SKILL.md" });
    await expect(
      installFileTemplate({ chorusUrl: "https://x.dev", kiroDir, fetchImpl }),
    ).rejects.toThrow(/chorus-yolo\/SKILL\.md/);
    // Phase 1 is fetch-into-memory only — a failed fetch must not have written anything.
    expect(existsSync(join(kiroDir, "agents"))).toBe(false);
    expect(existsSync(join(kiroDir, "settings", "mcp.json"))).toBe(false);
  });

  it("fails when the instance serves an empty manifest", async () => {
    const kiroDir = join(tmp("kiro-"), ".kiro");
    const routes = { ...fullRoutes(), "/kiro-plugin/manifest.txt": "# nothing\n" };
    await expect(
      installFileTemplate({ chorusUrl: "https://x.dev", kiroDir, fetchImpl: makeFetch(routes) }),
    ).rejects.toThrow(/resolved no assets/);
  });

  it("fails when the mcp.json template has no mcpServers.chorus entry", async () => {
    const kiroDir = join(tmp("kiro-"), ".kiro");
    const routes = { ...fullRoutes(), "/kiro-plugin/.kiro/settings/mcp.json": JSON.stringify({ mcpServers: {} }) };
    await expect(
      installFileTemplate({ chorusUrl: "https://x.dev", kiroDir, fetchImpl: makeFetch(routes) }),
    ).rejects.toThrow(/no mcpServers\.chorus/);
  });

  it("fails when the mcp.json template is not valid JSON", async () => {
    const kiroDir = join(tmp("kiro-"), ".kiro");
    const routes = { ...fullRoutes(), "/kiro-plugin/.kiro/settings/mcp.json": "{ not json" };
    await expect(
      installFileTemplate({ chorusUrl: "https://x.dev", kiroDir, fetchImpl: makeFetch(routes) }),
    ).rejects.toThrow(/not valid JSON/);
  });

  it("fails on a network-level fetch error (rejected promise) naming the URL", async () => {
    const kiroDir = join(tmp("kiro-"), ".kiro");
    const fetchImpl = async (url) => {
      throw new Error("ECONNREFUSED " + url);
    };
    await expect(
      installFileTemplate({ chorusUrl: "https://x.dev", kiroDir, fetchImpl }),
    ).rejects.toThrow(/manifest\.txt/);
  });

  it("throws when neither an injected fetch nor a global fetch is available", async () => {
    const kiroDir = join(tmp("kiro-"), ".kiro");
    const savedFetch = globalThis.fetch;
    // Force the no-fetch branch: omit fetchImpl AND remove the global fallback.
    globalThis.fetch = undefined;
    try {
      await expect(installFileTemplate({ chorusUrl: "https://x.dev", kiroDir })).rejects.toThrow(
        /no fetch implementation/,
      );
    } finally {
      globalThis.fetch = savedFetch;
    }
  });
});

/** Build a StepContext-like object for installKiro. */
function kiroCtx({ state = {}, env = {}, fetchImpl, backup, flags, platform } = {}) {
  return {
    agentId: "kiro",
    env,
    flags,
    fetch: fetchImpl,
    backup,
    platform,
    adapter: { id: "kiro", installPlugin: () => {}, readInstallState: () => state },
  };
}

describe("installKiro", () => {
  it("SKIPPED (no fetch) when the state reader reports fully installed", async () => {
    const fetchImpl = makeFetch(fullRoutes());
    const res = await installKiro(kiroCtx({ state: { pluginInstalled: true }, env: { CHORUS_URL: "https://x.dev" }, fetchImpl }));
    expect(res.action).toBe(SKIPPED);
    expect(fetchImpl.seen).toHaveLength(0);
  });

  it("refreshes a complete installed template, replaces Chorus assets, and merge-preserves MCP config", async () => {
    const kiroDir = join(tmp("kiro-refresh-"), ".kiro");
    mkdirSync(join(kiroDir, "skills", "chorus-idea"), { recursive: true });
    mkdirSync(join(kiroDir, "agents"), { recursive: true });
    mkdirSync(join(kiroDir, "settings"), { recursive: true });
    writeFileSync(join(kiroDir, "skills", "chorus-idea", "SKILL.md"), "# stale");
    writeFileSync(join(kiroDir, "agents", "chorus.json"), '{"stale":true}');
    writeFileSync(
      join(kiroDir, "settings", "mcp.json"),
      JSON.stringify({ mcpServers: { chorus: { stale: true }, mine: { type: "stdio" } } }),
    );
    const backups = [];
    const res = await installKiro(kiroCtx({
      state: { pluginInstalled: true, skillsPresent: true, agentPresent: true, mcpServerPresent: true },
      env: { CHORUS_URL: "https://x.dev", KIRO_DIR: kiroDir },
      flags: { updateInstalled: true },
      fetchImpl: makeFetch(fullRoutes()),
      backup: (p) => backups.push(p),
    }));
    expect(res.action).toBe(REPAIRED);
    expect(readFileSync(join(kiroDir, "skills", "chorus-idea", "SKILL.md"), "utf8")).toBe("# chorus-idea");
    expect(readFileSync(join(kiroDir, "skills", "chorus-orchestrate", "SKILL.md"), "utf8")).toBe("# chorus-orchestrate");
    const mcp = JSON.parse(readFileSync(join(kiroDir, "settings", "mcp.json"), "utf8"));
    expect(mcp.mcpServers.mine).toEqual({ type: "stdio" });
    expect(mcp.mcpServers.chorus.url).toBe("https://x.dev/api/mcp");
    expect(mcp.mcpServers.chorus.headers.Authorization).toBe("Bearer ${env:CHORUS_API_KEY}");
    expect(backups).toEqual([join(kiroDir, "settings", "mcp.json")]);
  });

  it("FAILED when no Chorus URL is resolvable (nothing to download from)", async () => {
    const res = await installKiro(kiroCtx({ state: { pluginInstalled: false }, env: {} }));
    expect(res.action).toBe(FAILED);
    expect(res.detail).toMatch(/CHORUS_URL|Chorus URL/);
  });

  it("INSTALLED end-to-end with an injected fetch + KIRO_DIR override", async () => {
    const kiroDir = join(tmp("kiro-"), "kroot");
    const res = await installKiro(
      kiroCtx({
        state: { pluginInstalled: false },
        env: { CHORUS_URL: "https://x.dev/api/mcp", KIRO_DIR: kiroDir },
        fetchImpl: makeFetch(fullRoutes()),
      }),
    );
    expect(res.action).toBe(INSTALLED);
    expect(existsSync(join(kiroDir, "agents", "chorus.json"))).toBe(true);
    expect(existsSync(join(kiroDir, "settings", "mcp.json"))).toBe(true);
  });

  it("REPAIRED when some chorus assets already exist (delta re-run)", async () => {
    const kiroDir = join(tmp("kiro-"), "kroot");
    const res = await installKiro(
      kiroCtx({
        state: { pluginInstalled: false, agentPresent: true, skillsPresent: false, mcpServerPresent: false },
        env: { CHORUS_URL: "https://x.dev", KIRO_DIR: kiroDir },
        fetchImpl: makeFetch(fullRoutes()),
      }),
    );
    expect(res.action).toBe(REPAIRED);
  });

  it("resolves the URL from flags.url when CHORUS_URL is unset", async () => {
    const kiroDir = join(tmp("kiro-"), "kroot");
    const res = await installKiro(
      kiroCtx({
        state: { pluginInstalled: false },
        env: { KIRO_DIR: kiroDir },
        flags: { url: "https://flag.dev" },
        fetchImpl: makeFetch(fullRoutes()),
      }),
    );
    expect(res.action).toBe(INSTALLED);
  });

  it("FAILED (naming the URL) when the instance is unreachable", async () => {
    const kiroDir = join(tmp("kiro-"), "kroot");
    const res = await installKiro(
      kiroCtx({
        state: { pluginInstalled: false },
        env: { CHORUS_URL: "https://x.dev", KIRO_DIR: kiroDir },
        fetchImpl: makeFetch(fullRoutes(), { fail: "manifest.txt" }),
      }),
    );
    expect(res.action).toBe(FAILED);
    expect(res.detail).toMatch(/manifest\.txt/);
  });
});

describe("readKiroInstallState (temp fixtures)", () => {
  function seed(kiroDir, { skill, agent, mcpServer } = {}) {
    if (skill) {
      mkdirSync(join(kiroDir, "skills", "chorus-idea"), { recursive: true });
      writeFileSync(join(kiroDir, "skills", "chorus-idea", "SKILL.md"), "# idea");
    }
    if (agent) {
      mkdirSync(join(kiroDir, "agents"), { recursive: true });
      writeFileSync(join(kiroDir, "agents", "chorus.json"), "{}");
    }
    if (mcpServer) {
      mkdirSync(join(kiroDir, "settings"), { recursive: true });
      writeFileSync(join(kiroDir, "settings", "mcp.json"), JSON.stringify({ mcpServers: { chorus: {} } }));
    }
  }

  it("reports installed only when skills + agent + mcp server are all present", () => {
    const kiroDir = join(tmp("kiro-"), ".kiro");
    seed(kiroDir, { skill: true, agent: true, mcpServer: true });
    expect(readKiroInstallState({ env: { KIRO_DIR: kiroDir } })).toMatchObject({
      pluginInstalled: true,
      skillsPresent: true,
      agentPresent: true,
      mcpServerPresent: true,
    });
  });

  it("reports a partial (agent only) as not-installed but flags the present pieces", () => {
    const kiroDir = join(tmp("kiro-"), ".kiro");
    seed(kiroDir, { agent: true });
    expect(readKiroInstallState({ env: { KIRO_DIR: kiroDir } })).toMatchObject({
      pluginInstalled: false,
      skillsPresent: false,
      agentPresent: true,
      mcpServerPresent: false,
    });
  });

  it("reports all-false for an empty / missing kiro dir", () => {
    const kiroDir = join(tmp("kiro-"), "empty-kiro");
    expect(readKiroInstallState({ env: { KIRO_DIR: kiroDir } })).toEqual({
      marketplaceRegistered: false,
      pluginInstalled: false,
      skillsPresent: false,
      agentPresent: false,
      mcpServerPresent: false,
    });
  });
});

describe("kiro manifest (owned solely by file-template.mjs)", () => {
  it("readKiroManifestFile resolves a non-empty asset set from the shared file", () => {
    // install-kiro.sh is now a deprecation stub with no manifest of its own, so
    // the manifest is single-sourced here. Guard against an empty parse.
    const js = readKiroManifestFile();
    expect(js.skills.length).toBeGreaterThan(0);
    expect(js.reviewerAgents.length).toBeGreaterThan(0);
    expect(js.hookScripts.length).toBeGreaterThan(0);
  });

  it("lists every skill shipped in the Kiro template", () => {
    const manifestSkills = [...readKiroManifestFile().skills].sort();
    const skillsDir = fileURLToPath(new URL(".kiro/skills/", KIRO_MANIFEST_URL));
    const templateSkills = readdirSync(skillsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(skillsDir, entry.name, "SKILL.md")))
      .map((entry) => entry.name)
      .sort();
    expect(manifestSkills).toEqual(templateSkills);
  });

  it("readKiroManifestFile reads the repo manifest at its canonical path", () => {
    expect(existsSync(fileURLToPath(KIRO_MANIFEST_URL))).toBe(true);
  });
});
