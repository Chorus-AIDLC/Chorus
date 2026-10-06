// Tests for cli/init/hermes-mcp-config.mjs — the textual upsert of mcp_servers.chorus in the
// Hermes config.yaml. All file writes go to a temp HERMES_HOME; the real ~/.hermes is never touched.
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  upsertHermesMcpYaml,
  writeHermesMcpServer,
  resolveHermesConfigPath,
  isHermesLoopbackDefault,
  HERMES_MCP_AUTH_PLACEHOLDER,
} from "../init/hermes-mcp-config.mjs";

const URL_ = "https://chorus.example.com/api/mcp";
const ENTRY2 = [
  "  chorus:",
  `    url: "${URL_}"`,
  "    headers:",
  '      Authorization: "Bearer ${CHORUS_API_KEY}"',
].join("\n");

describe("upsertHermesMcpYaml", () => {
  it("appends a new mcp_servers block when absent", () => {
    expect(upsertHermesMcpYaml("", URL_)).toBe(`mcp_servers:\n${ENTRY2}\n`);
    expect(upsertHermesMcpYaml("model: x\n", URL_)).toBe(`model: x\n\nmcp_servers:\n${ENTRY2}\n`);
    expect(upsertHermesMcpYaml("model: x", URL_)).toBe(`model: x\n\nmcp_servers:\n${ENTRY2}\n`);
  });

  it("replaces an existing chorus entry (e.g. the ${CHORUS_URL} form) and keeps siblings, comments, and later sections", () => {
    const input = [
      "# top comment",
      "mcp_servers:",
      "  # servers",
      "  alpha:",
      "    url: https://a/mcp",
      "  chorus:",
      "    url: ${CHORUS_URL}/api/mcp",
      "    headers:",
      "      Authorization: Bearer ${CHORUS_API_KEY}",
      "",
      "  zeta:",
      "    command: npx",
      "security:",
      "  approval:",
      "    transport: chorus",
      "",
    ].join("\n");
    const out = upsertHermesMcpYaml(input, URL_);
    expect(out).toBe(
      [
        "# top comment",
        "mcp_servers:",
        "  # servers",
        "  alpha:",
        "    url: https://a/mcp",
        ENTRY2,
        "",
        "  zeta:",
        "    command: npx",
        "security:",
        "  approval:",
        "    transport: chorus",
        "",
      ].join("\n"),
    );
    expect(upsertHermesMcpYaml(out, URL_)).toBe(out); // idempotent
  });

  it("matches the existing child indentation", () => {
    const out = upsertHermesMcpYaml("mcp_servers:\n    other:\n        url: x\n", URL_);
    expect(out).toContain('\n    chorus:\n        url: "https://chorus.example.com/api/mcp"\n        headers:\n            Authorization:');
  });

  it("adds chorus as the last child before a trailing comment and the next top-level key", () => {
    const out = upsertHermesMcpYaml("mcp_servers:\n  other:\n    url: x\n\n# next\nmodel: y\n", URL_);
    expect(out).toBe(`mcp_servers:\n  other:\n    url: x\n${ENTRY2}\n\n# next\nmodel: y\n`);
  });

  it("expands an empty inline mapping and rejects a non-empty one", () => {
    expect(upsertHermesMcpYaml("mcp_servers: {}\nmodel: y\n", URL_)).toBe(`mcp_servers:\n${ENTRY2}\nmodel: y\n`);
    expect(upsertHermesMcpYaml("mcp_servers:   # none yet\n", URL_)).toBe(`mcp_servers:   # none yet\n${ENTRY2}\n`);
    expect(() => upsertHermesMcpYaml("mcp_servers: {a: {url: x}}\n", URL_)).toThrow(/inline mapping/);
  });

  it("preserves CRLF line endings", () => {
    expect(upsertHermesMcpYaml("model: x\r\n", URL_)).toBe(`model: x\r\n\r\nmcp_servers:\r\n${ENTRY2.replace(/\n/g, "\r\n")}\r\n`);
  });

  it("only ever writes the placeholder, never a key value", () => {
    expect(HERMES_MCP_AUTH_PLACEHOLDER).toBe("Bearer ${CHORUS_API_KEY}");
    expect(upsertHermesMcpYaml("", URL_)).not.toMatch(/cho_/);
  });
});

describe("writeHermesMcpServer", () => {
  it("creates a 0600 file, backs up before changing an existing one, keeps its mode, and is a no-op on re-run", () => {
    const home = mkdtempSync(join(tmpdir(), "hermes-cfg-"));
    const configPath = resolveHermesConfigPath({ HERMES_HOME: home });
    expect(configPath).toBe(join(home, "config.yaml"));

    const first = writeHermesMcpServer({ configPath, url: "https://chorus.example.com" });
    expect(first).toMatchObject({ changed: true, mcpUrl: URL_ });
    if (process.platform !== "win32") expect(statSync(configPath).mode & 0o777).toBe(0o600);

    writeFileSync(configPath, "model: x\n");
    chmodSync(configPath, 0o640);
    const backups = [];
    expect(writeHermesMcpServer({ configPath, url: "https://chorus.example.com", backup: (p) => backups.push(p) }).changed).toBe(true);
    expect(backups).toEqual([configPath]);
    if (process.platform !== "win32") expect(statSync(configPath).mode & 0o777).toBe(0o640);
    const after = readFileSync(configPath, "utf8");
    expect(writeHermesMcpServer({ configPath, url: "https://chorus.example.com/", backup: (p) => backups.push(p) }).changed).toBe(false);
    expect(readFileSync(configPath, "utf8")).toBe(after);
    expect(backups).toHaveLength(1);
  });

  it("requires a url", () => {
    expect(() => writeHermesMcpServer({ configPath: "/nonexistent/x.yaml", url: "" })).toThrow(/requires a url/);
  });

  it("resolveHermesConfigPath falls back to $HOME/.hermes", () => {
    expect(resolveHermesConfigPath({ HOME: "/h" })).toBe(join("/h", ".hermes", "config.yaml"));
  });
});

describe("isHermesLoopbackDefault", () => {
  it("is true only for the local default http://localhost:8637", () => {
    for (const u of ["http://localhost:8637", "http://localhost:8637/", "http://127.0.0.1:8637", "http://[::1]:8637/api/mcp"]) {
      expect(isHermesLoopbackDefault(u)).toBe(true);
    }
    for (const u of ["https://chorus.example.com", "http://localhost:3000", "https://localhost:8637", "http://localhost:8637/chorus", "", undefined, "not a url"]) {
      expect(isHermesLoopbackDefault(u)).toBe(false);
    }
  });
});
