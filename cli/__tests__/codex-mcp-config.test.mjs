// cli/__tests__/codex-mcp-config.test.mjs
// Covers the Codex native-MCP config writer (spec: chorus-init "Codex native MCP
// credentials via config.toml bearer_token_env_var", idea refactor-codex-env-dotenv-sink).
// Chorus writes [mcp_servers.chorus] with a KEYLESS bearer_token_env_var reference (the key
// lives only in ~/.codex/.env); the writer migrates away any legacy literal Authorization.
import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexMcpUrl, resolveCodexConfigPath, writeCodexMcpServer } from "../init/codex-mcp-config.mjs";

describe("codexMcpUrl", () => {
  it("appends /api/mcp to a bare host (with or without a trailing slash)", () => {
    expect(codexMcpUrl("https://chorus.example")).toBe("https://chorus.example/api/mcp");
    expect(codexMcpUrl("https://chorus.example/")).toBe("https://chorus.example/api/mcp");
    expect(codexMcpUrl("http://localhost:8637")).toBe("http://localhost:8637/api/mcp");
  });
  it("leaves a URL that already has a path segment as-is (idempotent on the endpoint)", () => {
    expect(codexMcpUrl("https://chorus.example/api/mcp")).toBe("https://chorus.example/api/mcp");
    expect(codexMcpUrl("https://chorus.example/api/mcp/")).toBe("https://chorus.example/api/mcp");
    expect(codexMcpUrl("https://chorus.example/custom/path")).toBe("https://chorus.example/custom/path");
  });
  it("returns undefined for an empty/whitespace URL", () => {
    expect(codexMcpUrl("")).toBeUndefined();
    expect(codexMcpUrl("   ")).toBeUndefined();
    expect(codexMcpUrl(undefined)).toBeUndefined();
  });
});

describe("resolveCodexConfigPath", () => {
  it("honors CODEX_HOME, then HOME, ending in config.toml", () => {
    expect(resolveCodexConfigPath({ CODEX_HOME: "/x/.codex" })).toBe("/x/.codex/config.toml");
    expect(resolveCodexConfigPath({ HOME: "/home/u" })).toBe("/home/u/.codex/config.toml");
  });
});

describe("writeCodexMcpServer (real writer)", () => {
  it("creates a fresh [mcp_servers.chorus] with url + bearer_token_env_var, 0600, no literal key", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-mcp-"));
    const p = join(dir, "nested", ".codex", "config.toml"); // dir does not exist yet
    const ret = writeCodexMcpServer({ configPath: p, url: "https://c.example" });
    expect(ret).toBe(p);
    expect(existsSync(p)).toBe(true);
    const txt = readFileSync(p, "utf8");
    expect(txt).toMatch(/^\[mcp_servers\.chorus\]$/m);
    expect(txt).toContain('url = "https://c.example/api/mcp"');
    expect(txt).toContain('bearer_token_env_var = "CHORUS_API_KEY"');
    // Keyless: no literal Authorization / Bearer / cho_ key anywhere.
    expect(txt).not.toMatch(/Authorization/i);
    expect(txt).not.toContain("Bearer ");
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });

  it("is idempotent: a re-run reproduces byte-identical content and keeps 0600", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-mcp-"));
    const p = join(dir, "config.toml");
    writeCodexMcpServer({ configPath: p, url: "https://c.example" });
    const first = readFileSync(p, "utf8");
    writeCodexMcpServer({ configPath: p, url: "https://c.example/api/mcp" }); // normalized-equal
    expect(readFileSync(p, "utf8")).toBe(first);
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });

  it("preserves unrelated sections, keys, and comments verbatim", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-mcp-"));
    const p = join(dir, "config.toml");
    writeFileSync(
      p,
      [
        "# my codex config",
        'model = "gpt-5.5"',
        "",
        '[marketplaces.chorus-plugins]',
        'source = "Chorus-AIDLC/Chorus"',
        "",
        '[plugins."chorus@chorus-plugins"]',
        "enabled = true",
        "",
      ].join("\n"),
    );
    writeCodexMcpServer({ configPath: p, url: "https://c.example" });
    const txt = readFileSync(p, "utf8");
    expect(txt).toContain("# my codex config");
    expect(txt).toContain('model = "gpt-5.5"');
    expect(txt).toContain("[marketplaces.chorus-plugins]");
    expect(txt).toContain('[plugins."chorus@chorus-plugins"]');
    expect(txt).toContain("enabled = true");
    // The chorus MCP block is appended.
    expect(txt).toContain('[mcp_servers.chorus]');
    expect(txt).toContain('bearer_token_env_var = "CHORUS_API_KEY"');
  });

  it("migrates a legacy literal Authorization: strips it, drops the emptied http_headers subtable, adds bearer_token_env_var", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-mcp-"));
    const p = join(dir, "config.toml");
    writeFileSync(
      p,
      [
        "[mcp_servers.chorus]",
        'url = "https://c.example/api/mcp"',
        "",
        "[mcp_servers.chorus.http_headers]",
        'Authorization = "Bearer cho_LEGACY"',
        "",
      ].join("\n"),
    );
    writeCodexMcpServer({ configPath: p, url: "https://c.example" });
    const txt = readFileSync(p, "utf8");
    expect(txt).toContain('url = "https://c.example/api/mcp"');
    expect(txt).toContain('bearer_token_env_var = "CHORUS_API_KEY"');
    // The literal key + Authorization + the now-empty subtable are gone.
    expect(txt).not.toContain("cho_LEGACY");
    expect(txt).not.toMatch(/Authorization/i);
    expect(txt).not.toContain("[mcp_servers.chorus.http_headers]");
  });

  it("keeps OTHER headers when migrating (only Authorization is removed)", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-mcp-"));
    const p = join(dir, "config.toml");
    writeFileSync(
      p,
      [
        "[mcp_servers.chorus]",
        'url = "https://c.example/api/mcp"',
        "",
        "[mcp_servers.chorus.http_headers]",
        'Authorization = "Bearer cho_LEGACY"',
        'X-Chorus-Project = "proj-1"',
        "",
      ].join("\n"),
    );
    writeCodexMcpServer({ configPath: p, url: "https://c.example" });
    const txt = readFileSync(p, "utf8");
    expect(txt).toContain("[mcp_servers.chorus.http_headers]"); // kept — still has a header
    expect(txt).toContain('X-Chorus-Project = "proj-1"');
    expect(txt).not.toContain("cho_LEGACY");
    expect(txt).not.toMatch(/Authorization/i);
    expect(txt).toContain('bearer_token_env_var = "CHORUS_API_KEY"');
  });

  it("drops a legacy inline `bearer_token = \"...\"` literal from the chorus section", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-mcp-"));
    const p = join(dir, "config.toml");
    writeFileSync(p, '[mcp_servers.chorus]\nurl = "https://c.example/api/mcp"\nbearer_token = "cho_LEGACY"\n');
    writeCodexMcpServer({ configPath: p, url: "https://c.example" });
    const txt = readFileSync(p, "utf8");
    expect(txt).not.toContain("cho_LEGACY");
    expect(txt).not.toMatch(/^\s*bearer_token\s*=/m);
    expect(txt).toContain('bearer_token_env_var = "CHORUS_API_KEY"');
  });

  it("throws when no url is provided (and writes nothing)", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-mcp-"));
    const p = join(dir, "config.toml");
    expect(() => writeCodexMcpServer({ configPath: p, url: "" })).toThrow(/requires a url/);
    expect(existsSync(p)).toBe(false);
  });
});
