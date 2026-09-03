// cli/__tests__/pi-mcp-config.test.mjs
// Covers the pi MCP config writer (spec: chorus-init "Pi Chorus MCP via the adapter path,
// env-referenced credentials", idea optimize-pi-plugin-npm-parity follow-up). `chorus agents
// add` writes pi's global ~/.pi/agent/mcp.json with an mcpServers.chorus entry whose
// Authorization references the key by ENV VAR (`Bearer ${CHORUS_API_KEY}`) — pi-mcp-adapter
// exposes the chorus_* tools, and NO literal cho_ key is written. Merge-safe JSON upsert
// (mirrors the keyless Codex writer, but JSON not TOML).
import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { piMcpUrl, resolvePiMcpConfigPath, writePiMcpServer } from "../init/pi-mcp-config.mjs";

describe("piMcpUrl", () => {
  it("appends /api/mcp to a bare host (with or without a trailing slash)", () => {
    expect(piMcpUrl("https://chorus.example")).toBe("https://chorus.example/api/mcp");
    expect(piMcpUrl("https://chorus.example/")).toBe("https://chorus.example/api/mcp");
    expect(piMcpUrl("http://localhost:8637")).toBe("http://localhost:8637/api/mcp");
  });
  it("leaves a URL that already has a path segment as-is (idempotent on the endpoint)", () => {
    expect(piMcpUrl("https://chorus.example/api/mcp")).toBe("https://chorus.example/api/mcp");
    expect(piMcpUrl("https://chorus.example/api/mcp/")).toBe("https://chorus.example/api/mcp");
    expect(piMcpUrl("https://chorus.example/custom/path")).toBe("https://chorus.example/custom/path");
  });
  it("returns undefined for an empty/whitespace URL", () => {
    expect(piMcpUrl("")).toBeUndefined();
    expect(piMcpUrl("   ")).toBeUndefined();
    expect(piMcpUrl(undefined)).toBeUndefined();
  });
});

describe("resolvePiMcpConfigPath", () => {
  it("honors PI_CODING_AGENT_DIR, then HOME, ending in mcp.json (default ~/.pi/agent)", () => {
    expect(resolvePiMcpConfigPath({ PI_CODING_AGENT_DIR: "/x/agent" })).toBe("/x/agent/mcp.json");
    expect(resolvePiMcpConfigPath({ HOME: "/home/u" })).toBe("/home/u/.pi/agent/mcp.json");
  });
});

describe("writePiMcpServer (real writer)", () => {
  it("creates a fresh mcp.json with type/url + env-referenced Authorization, 0600, no literal key", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-mcp-"));
    const p = join(dir, "nested", ".pi", "agent", "mcp.json"); // dir does not exist yet
    const ret = writePiMcpServer({ configPath: p, url: "https://c.example" });
    expect(ret).toBe(p);
    expect(existsSync(p)).toBe(true);
    const cfg = JSON.parse(readFileSync(p, "utf8"));
    expect(cfg.mcpServers.chorus).toEqual({
      type: "http",
      url: "https://c.example/api/mcp",
      headers: { Authorization: "Bearer ${CHORUS_API_KEY}" },
    });
    // Keyless: the env-ref is present; no literal cho_ key / literal Bearer token anywhere.
    const txt = readFileSync(p, "utf8");
    expect(txt).toContain("Bearer ${CHORUS_API_KEY}");
    expect(txt).not.toMatch(/cho_/);
    expect(txt).not.toMatch(/Bearer\s+cho_/);
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });

  it("is idempotent: a re-run reproduces byte-identical content and keeps 0600", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-mcp-"));
    const p = join(dir, "mcp.json");
    writePiMcpServer({ configPath: p, url: "https://c.example" });
    const first = readFileSync(p, "utf8");
    writePiMcpServer({ configPath: p, url: "https://c.example/api/mcp" }); // normalized-equal
    expect(readFileSync(p, "utf8")).toBe(first);
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });

  it("preserves other top-level fields AND other mcpServers entries verbatim (only upserts chorus)", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-mcp-"));
    const p = join(dir, "mcp.json");
    writeFileSync(
      p,
      JSON.stringify(
        {
          settings: { hostConfigDiscovery: "off" },
          mcpServers: {
            github: { type: "http", url: "https://gh.example/mcp", headers: { Authorization: "Bearer gh_TOKEN" } },
          },
        },
        null,
        2,
      ),
    );
    writePiMcpServer({ configPath: p, url: "https://c.example" });
    const cfg = JSON.parse(readFileSync(p, "utf8"));
    // Unrelated top-level field preserved.
    expect(cfg.settings).toEqual({ hostConfigDiscovery: "off" });
    // The OTHER server is preserved verbatim (incl. its own literal token — not ours to touch).
    expect(cfg.mcpServers.github).toEqual({
      type: "http",
      url: "https://gh.example/mcp",
      headers: { Authorization: "Bearer gh_TOKEN" },
    });
    // The chorus server is added with the env-ref.
    expect(cfg.mcpServers.chorus).toEqual({
      type: "http",
      url: "https://c.example/api/mcp",
      headers: { Authorization: "Bearer ${CHORUS_API_KEY}" },
    });
  });

  it("MIGRATES a legacy literal Bearer to the env-ref and drops a legacy literal bearerToken", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-mcp-"));
    const p = join(dir, "mcp.json");
    writeFileSync(
      p,
      JSON.stringify(
        {
          mcpServers: {
            chorus: {
              type: "http",
              url: "https://c.example/api/mcp",
              bearerToken: "cho_LEGACY",
              headers: { Authorization: "Bearer cho_LEGACY", "X-Chorus-Project": "proj-1" },
            },
          },
        },
        null,
        2,
      ),
    );
    writePiMcpServer({ configPath: p, url: "https://c.example" });
    const txt = readFileSync(p, "utf8");
    // The literal key is gone from BOTH the bearerToken field and the Authorization header.
    expect(txt).not.toContain("cho_LEGACY");
    const cfg = JSON.parse(txt);
    expect(cfg.mcpServers.chorus.bearerToken).toBeUndefined(); // legacy literal field dropped
    expect(cfg.mcpServers.chorus.headers.Authorization).toBe("Bearer ${CHORUS_API_KEY}");
    // An unrelated header on the chorus entry is preserved.
    expect(cfg.mcpServers.chorus.headers["X-Chorus-Project"]).toBe("proj-1");
  });

  it("preserves an existing non-secret chorus key (e.g. toolPrefix) when upserting", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-mcp-"));
    const p = join(dir, "mcp.json");
    writeFileSync(
      p,
      JSON.stringify({ mcpServers: { chorus: { type: "http", url: "http://old", toolPrefix: "none" } } }, null, 2),
    );
    writePiMcpServer({ configPath: p, url: "https://c.example" });
    const cfg = JSON.parse(readFileSync(p, "utf8"));
    expect(cfg.mcpServers.chorus.toolPrefix).toBe("none"); // user customization preserved
    expect(cfg.mcpServers.chorus.url).toBe("https://c.example/api/mcp"); // url refreshed
    expect(cfg.mcpServers.chorus.headers.Authorization).toBe("Bearer ${CHORUS_API_KEY}");
  });

  it("THROWS on existing malformed JSON and does NOT clobber the file", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-mcp-"));
    const p = join(dir, "mcp.json");
    writeFileSync(p, "{ this is not json ");
    expect(() => writePiMcpServer({ configPath: p, url: "https://c.example" })).toThrow(/not valid JSON/);
    expect(readFileSync(p, "utf8")).toBe("{ this is not json "); // untouched
  });

  it("THROWS on a present-but-non-object mcpServers block (no clobber)", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-mcp-"));
    const p = join(dir, "mcp.json");
    writeFileSync(p, JSON.stringify({ mcpServers: "oops" }));
    expect(() => writePiMcpServer({ configPath: p, url: "https://c.example" })).toThrow(/non-object "mcpServers"/);
  });

  it("throws when no url is provided (and writes nothing)", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-mcp-"));
    const p = join(dir, "mcp.json");
    expect(() => writePiMcpServer({ configPath: p, url: "" })).toThrow(/requires a url/);
    expect(existsSync(p)).toBe(false);
  });
});
