// cli/mcp-config.mjs
// Writes the --mcp-config JSON that wires the spawned headless Claude to THIS
// daemon's Chorus server (url + cho_ key), into the OS temp dir (never a
// hardcoded /tmp), and cleans it up. Plain ESM, zero deps.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Build the MCP config object that exposes the Chorus server to the spawned
 * Claude as a `chorus` MCP server over Streamable HTTP (mirrors the entry the
 * OpenClaw plugin writes — see mcp-registration.ts).
 * @param {{ url: string, apiKey: string }} creds
 */
export function buildMcpConfig({ url, apiKey }) {
  return {
    mcpServers: {
      chorus: {
        type: "http",
        url: `${url.replace(/\/$/, "")}/api/mcp`,
        headers: { Authorization: `Bearer ${apiKey}` },
      },
    },
  };
}

/**
 * Write the MCP config to a fresh temp file under os.tmpdir() and return its
 * path plus a cleanup function. The caller MUST call cleanup() when the wake
 * completes (or register it for process exit).
 *
 * @param {{ url: string, apiKey: string }} creds
 * @param {{ tmp?: string, mkdtemp?: typeof mkdtempSync, write?: typeof writeFileSync, rm?: typeof rmSync }} [deps]
 * @returns {{ path: string, cleanup: () => void }}
 */
export function writeMcpConfig(creds, deps = {}) {
  const tmp = deps.tmp ?? tmpdir();
  const mkdtemp = deps.mkdtemp ?? mkdtempSync;
  const write = deps.write ?? writeFileSync;
  const rm = deps.rm ?? rmSync;

  const dir = mkdtemp(join(tmp, "chorus-mcp-"));
  const path = join(dir, "mcp.json");
  write(path, JSON.stringify(buildMcpConfig(creds), null, 2), { mode: 0o600 });

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try {
      rm(dir, { recursive: true, force: true });
    } catch {
      // best-effort; temp dir is reclaimed by the OS regardless
    }
  };
  return { path, cleanup };
}
