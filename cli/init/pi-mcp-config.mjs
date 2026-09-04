// cli/init/pi-mcp-config.mjs
// Writes the Chorus MCP server block into pi's global MCP config
// (`~/.pi/agent/mcp.json` by default) so pi's `pi-mcp-adapter` exposes the
// `chorus_*` tools to the pi agent — the ADAPTER path (chorus.ts never registers
// tools itself). The Authorization header references the API key by ENV VAR
// (`Bearer ${CHORUS_API_KEY}`, which pi-mcp-adapter interpolates at connect time),
// so the `cho_` key lives in exactly ZERO files here — only the env-var reference.
// The URL is not a secret, so it is written as a resolved literal (an interactive pi
// then needs only CHORUS_API_KEY in its shell, not CHORUS_URL).
//
// This is the pi analogue of cli/init/codex-mcp-config.mjs (Codex's keyless
// `[mcp_servers.chorus] bearer_token_env_var`) and the CC plugin `.mcp.json`
// (`Authorization: Bearer ${CHORUS_URL}`-style ${VAR} interpolation). `pi install`
// does NOT write an mcp.json for us, so `chorus agents add` writes it here (from the
// credential-seed step, which already holds the resolved URL).
//
// CONFIG CONTRACT (VERIFIED against pi-mcp-adapter 2.32.1 npm readme, repo
// github.com/nicobailon/pi-mcp-adapter):
//   - The adapter discovers a Pi GLOBAL override at `<Pi agent dir>/mcp.json`
//     (`~/.pi/agent/mcp.json` by default, or `$PI_CODING_AGENT_DIR/mcp.json` when set)
//     — the same file `pi-mcp-adapter init` writes to by default, and higher precedence
//     than the tool-agnostic `~/.config/mcp/mcp.json`.
//   - An `mcpServers.<name>` entry supports `type:"http"`, a `url` (raw `${VAR}` /
//     `$env:VAR` interpolation) and `headers` (also `${VAR}` / `$env:VAR`
//     interpolation). We use `headers.Authorization = "Bearer ${CHORUS_API_KEY}"` —
//     the cleanest keyless form, and a one-token change from the literal-Bearer shape
//     CONNECT_PI.md previously documented.
//
// Standard JSON merge (mcp.json is JSON, unlike Codex's TOML): every other top-level
// field and every OTHER `mcpServers.<name>` entry is preserved verbatim; only
// `mcpServers.chorus` is upserted. Any legacy literal `bearerToken` on the chorus
// entry is dropped and a literal `headers.Authorization` is replaced by the env-ref,
// so a re-run MIGRATES an old literal key off disk. Atomic 0600 temp+rename;
// idempotent (a re-run with the same url reproduces the file). IO is injectable for
// tests. The API key is NEVER written — only the env-var reference.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const API_KEY_ENV = "CHORUS_API_KEY";
// A normal (non-template) string: `${CHORUS_API_KEY}` is emitted verbatim into the
// JSON for pi-mcp-adapter to interpolate at connect time — no literal key on disk.
const AUTHORIZATION_ENV_REF = "Bearer ${" + API_KEY_ENV + "}";

/** A non-empty trimmed string, or undefined. */
function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Resolve the pi GLOBAL MCP config path. Honors `PI_CODING_AGENT_DIR` (pi-mcp-adapter's
 * own override of the Pi agent dir), then `HOME` (so tests can inject a temp home), else
 * the OS home dir — ending in `mcp.json`. VERIFIED default `~/.pi/agent/mcp.json`.
 * @param {Record<string, string | undefined>} env
 */
export function resolvePiMcpConfigPath(env) {
  const base = nonEmpty(env.PI_CODING_AGENT_DIR) ?? join(nonEmpty(env.HOME) ?? homedir(), ".pi", "agent");
  return join(base, "mcp.json");
}

/**
 * Normalize a Chorus base URL to the MCP endpoint the same way the Codex writer
 * (codex-mcp-config.mjs) and the hook wrapper do: a URL that already has a path segment
 * beyond the host is used as-is; a bare host gains `/api/mcp`. Returns undefined for an
 * empty URL.
 * @param {string | undefined} rawUrl
 */
export function piMcpUrl(rawUrl) {
  const u = nonEmpty(rawUrl);
  if (!u) return undefined;
  const trimmed = u.replace(/\/+$/, "");
  const m = trimmed.match(/^https?:\/\/[^/]+(\/.*)?$/);
  if (m && m[1] && m[1].length > 0) return trimmed; // already a full endpoint
  return `${trimmed}/api/mcp`;
}

/** True for a plain (non-array) object. */
function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * Upsert `mcpServers.chorus` in pi's global mcp.json to
 *   { "type": "http", "url": "<mcp-endpoint>", "headers": { "Authorization": "Bearer ${CHORUS_API_KEY}" } }
 * MERGE-SAFE: every other top-level field and every OTHER `mcpServers.<name>` entry is
 * preserved verbatim; on the chorus entry itself every other key (e.g. `toolPrefix`,
 * `includeTools`) is preserved, only `type`/`url`/`headers.Authorization` are set. A legacy
 * literal `bearerToken` on the chorus entry is DROPPED and any literal `headers.Authorization`
 * is replaced by the env-ref — migrating an old literal key off disk.
 *
 * Missing file → start from `{}`. An existing UNPARSEABLE file, a non-object root, or a
 * present-but-non-object `mcpServers` → THROW (never clobber a file we cannot safely merge;
 * the caller treats a throw as a write failure). Atomic 0600 temp+rename; idempotent (a re-run
 * with the same url reproduces the file). The API key is NEVER written — only the env-var
 * reference `${CHORUS_API_KEY}`.
 * @param {{ configPath: string, url: string }} args
 * @param {{
 *   read?: (p: string) => string,
 *   write?: (p: string, c: string, o: object) => void,
 *   mkdir?: (p: string, o: object) => void,
 *   rename?: (from: string, to: string) => void,
 * }} [deps]
 * @returns {string} the mcp.json path written
 */
export function writePiMcpServer({ configPath, url }, deps = {}) {
  const read = deps.read ?? ((p) => readFileSync(p, "utf8"));
  const write = deps.write ?? writeFileSync;
  const mkdir = deps.mkdir ?? mkdirSync;
  const rename = deps.rename ?? renameSync;

  const mcpUrl = piMcpUrl(url);
  if (!mcpUrl) throw new Error("writePiMcpServer requires a url");

  let raw;
  try {
    raw = read(configPath);
  } catch {
    raw = undefined; // no file yet — start fresh
  }

  let parsed = {};
  if (typeof raw === "string" && raw.trim()) {
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`existing ${configPath} is not valid JSON (${err?.message ?? err}) — refusing to overwrite`);
    }
    if (!isPlainObject(parsed)) {
      throw new Error(`existing ${configPath} is not a JSON object — refusing to overwrite`);
    }
  }

  // Preserve an existing `mcpServers` object (and every server in it); a present-but-non-object
  // `mcpServers` is unsafe to merge.
  let servers = parsed.mcpServers;
  if (servers === undefined || servers === null) {
    servers = {};
  } else if (!isPlainObject(servers)) {
    throw new Error(`existing ${configPath} has a non-object "mcpServers" block — refusing to overwrite`);
  }

  // Preserve every OTHER key on the chorus entry (e.g. toolPrefix / includeTools), and every
  // OTHER header, but drop the legacy literal `bearerToken` (a secret) and overwrite
  // Authorization with the keyless env-ref.
  const existingChorus = isPlainObject(servers.chorus) ? servers.chorus : {};
  const existingHeaders = isPlainObject(existingChorus.headers) ? existingChorus.headers : {};
  const chorusRest = { ...existingChorus };
  delete chorusRest.bearerToken; // drop any legacy literal token (a secret) — we use the env-ref header

  servers.chorus = {
    ...chorusRest,
    type: "http",
    url: mcpUrl,
    headers: { ...existingHeaders, Authorization: AUTHORIZATION_ENV_REF },
  };
  parsed.mcpServers = servers;

  const content = `${JSON.stringify(parsed, null, 2)}\n`;

  mkdir(dirname(configPath), { recursive: true });
  const tmp = `${configPath}.tmp`;
  write(tmp, content, { mode: 0o600 });
  rename(tmp, configPath);
  return configPath;
}
