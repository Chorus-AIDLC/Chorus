import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
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
 * Resolve the global native mcp.json or legacy adapter5 mcp-adapter.json path.
 * Honors PI_CODING_AGENT_DIR, then HOME, then the OS home directory.
 * @param {Record<string, string | undefined>} env
 */
export function resolvePiMcpConfigPath(env, backend = {}) {
  const base = nonEmpty(env.PI_CODING_AGENT_DIR) ?? join(nonEmpty(env.HOME) ?? homedir(), ".pi", "agent");
  return join(base, backend.mode === "legacy" && backend.supported !== false ? "mcp-adapter.json" : "mcp.json");
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
 * Upsert `mcpServers.chorus` in the selected backend's global config to
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
 * @param {{ configPath: string, url: string, backend?: object }} args
 * @param {{
 *   read?: (p: string) => string,
 *   write?: (descriptor: number, content: string) => void,
 *   mkdir?: (p: string, o: object) => void,
 *   rename?: (from: string, to: string) => void,
 * }} [deps]
 * @returns {string} the config path written
 */
export function writePiMcpServer({ configPath, url, backend = {} }, deps = {}) {
  const read = deps.read ?? ((p) => readFileSync(p, "utf8"));
  const write = deps.write ?? writeFileSync;
  const mkdir = deps.mkdir ?? mkdirSync;
  const rename = deps.rename ?? renameSync;

  const mcpUrl = piMcpUrl(url);
  if (!mcpUrl) throw new Error("writePiMcpServer requires a url");

  function load(path) {
    let raw;
    try {
      raw = read(path);
    } catch (error) {
      if (error.code === "ENOENT") return undefined;
      throw new Error(`cannot read ${path} safely — refusing to overwrite`);
    }
    let parsed;
    try { parsed = JSON.parse(raw); } catch {
      throw new Error(`existing ${path} is not valid JSON — refusing to overwrite`);
    }
    if (!isPlainObject(parsed)) throw new Error(`existing ${path} is not a JSON object — refusing to overwrite`);
    if (parsed.mcpServers !== undefined && !isPlainObject(parsed.mcpServers)) {
      throw new Error(`existing ${path} has a non-object "mcpServers" block — refusing to overwrite`);
    }
    if (parsed.mcpServers?.chorus !== undefined && !isPlainObject(parsed.mcpServers.chorus)) {
      throw new Error(`existing ${path} has a non-object Chorus server — refusing to overwrite`);
    }
    if (parsed.settings !== undefined && !isPlainObject(parsed.settings)) {
      throw new Error(`existing ${path} has non-object settings — refusing to overwrite`);
    }
    return parsed;
  }
  const legacy = backend.mode === "legacy" && backend.supported !== false;
  let parsed = load(configPath);
  if (legacy && parsed === undefined) parsed = load(join(dirname(configPath), "mcp.json"));
  parsed ??= {};

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
    ...(legacy && existingChorus.directTools === undefined && parsed.settings?.directTools === undefined ? { directTools: true } : {}),
    type: "http",
    url: mcpUrl,
    headers: { ...existingHeaders, Authorization: AUTHORIZATION_ENV_REF },
  };
  parsed.mcpServers = servers;

  const content = `${JSON.stringify(parsed, null, 2)}\n`;

  mkdir(dirname(configPath), { recursive: true });
  const tmp = `${configPath}.${randomUUID()}.tmp`;
  const descriptor = openSync(tmp, "wx", 0o600);
  try {
    try {
      write(descriptor, content);
    } finally {
      closeSync(descriptor);
    }
    rename(tmp, configPath);
  } finally {
    try { unlinkSync(tmp); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return configPath;
}
