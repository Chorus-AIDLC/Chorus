// cli/init/codex-mcp-config.mjs
// Writes the Chorus native-MCP server block into ~/.codex/config.toml using a KEYLESS
// env-var reference — `bearer_token_env_var = "CHORUS_API_KEY"` — instead of a literal
// `Authorization: Bearer <key>`. Codex loads ~/.codex/.env into its process env at arg0
// startup and resolves that env var into `Authorization: Bearer <key>` at connect time
// (config/src/mcp_types.rs StreamableHttp.bearer_token_env_var; codex-mcp resolve_bearer_token),
// so the API key lives in exactly ONE place (~/.codex/.env). A daemon-woken Codex — whose
// spawner exports CHORUS_API_KEY into the child env — then also authenticates to native MCP,
// closing the gap a literal Bearer left (cli/codex-spawner.mjs:16-22).
//
// `codex plugin add` does NOT write [mcp_servers.chorus] (its marketplace `authentication:
// ON_INSTALL` is metadata only — verified codex-cli 0.150.1), so `chorus agents add` writes it
// here, AFTER the plugin install (authoritative, no race).
//
// TARGETED TEXTUAL upsert — no TOML-parser dependency (the repo stays pure-JS / cross-platform),
// preserving every other section, key, and comment verbatim. The secret is NEVER written here
// (bearer_token_env_var is a variable NAME, not the key).

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const BEARER_ENV_VAR = "CHORUS_API_KEY";

/** A non-empty trimmed string, or undefined. */
function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Resolve the Codex `~/.codex/config.toml` path. Honors `CODEX_HOME`, then `HOME` (so tests
 * can inject a temp home), else the OS home dir — matching cli/codex-spawner.mjs +
 * install-methods.mjs.
 * @param {Record<string, string | undefined>} env
 */
export function resolveCodexConfigPath(env) {
  const base = nonEmpty(env.CODEX_HOME) ?? join(nonEmpty(env.HOME) ?? homedir(), ".codex");
  return join(base, "config.toml");
}

/**
 * Normalize a Chorus base URL to the MCP endpoint the same way the hook wrapper
 * (chorus-mcp-call.sh) does: a URL that already has a path segment beyond the host is used
 * as-is; a bare host gains `/api/mcp`. Returns undefined for an empty URL.
 * @param {string | undefined} rawUrl
 */
export function codexMcpUrl(rawUrl) {
  const u = nonEmpty(rawUrl);
  if (!u) return undefined;
  const trimmed = u.replace(/\/+$/, "");
  const m = trimmed.match(/^https?:\/\/[^/]+(\/.*)?$/);
  if (m && m[1] && m[1].length > 0) return trimmed; // already a full endpoint
  return `${trimmed}/api/mcp`;
}

// TOML basic-string value: escape backslash then double-quote. URLs don't contain these, but
// escape defensively so we never emit invalid TOML.
const toToml = (v) => `"${String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/**
 * Upsert `[mcp_servers.chorus]` in `~/.codex/config.toml` to
 *   url = "<mcp-endpoint>"
 *   bearer_token_env_var = "CHORUS_API_KEY"
 * and MIGRATE away any legacy literal auth: a `bearer_token = "..."` line is dropped, and a
 * `[mcp_servers.chorus.http_headers]` `Authorization = "..."` line is removed (dropping the
 * whole http_headers subtable when it becomes empty, preserving any OTHER header). Every other
 * section/key/comment in the file is preserved verbatim.
 *
 * Atomic 0600 temp+rename; idempotent (a re-run with the same url reproduces the file). The API
 * key is NEVER written — only the env-var NAME.
 * @param {{ configPath: string, url: string }} args
 * @param {{
 *   read?: (p: string) => string,
 *   write?: (p: string, c: string, o: object) => void,
 *   mkdir?: (p: string, o: object) => void,
 *   rename?: (from: string, to: string) => void,
 * }} [deps]
 * @returns {string} the config.toml path written
 */
export function writeCodexMcpServer({ configPath, url }, deps = {}) {
  const read = deps.read ?? ((p) => readFileSync(p, "utf8"));
  const write = deps.write ?? writeFileSync;
  const mkdir = deps.mkdir ?? mkdirSync;
  const rename = deps.rename ?? renameSync;

  const mcpUrl = codexMcpUrl(url);
  if (!mcpUrl) throw new Error("writeCodexMcpServer requires a url");

  let existing = "";
  try {
    existing = read(configPath);
  } catch {
    existing = ""; // no file yet — start fresh
  }

  const lines = existing.length ? existing.split(/\r?\n/) : [];
  if (lines.length && lines[lines.length - 1] === "") lines.pop();

  const isHeader = (s) => /^\s*\[/.test(s);
  const chorusHeaderRe = /^\s*\[mcp_servers\.chorus\]\s*$/;
  const headersHeaderRe = /^\s*\[mcp_servers\.chorus\.http_headers\]\s*$/;
  // A `key = value` line (not a comment or blank) — used to tell whether a subtable still has
  // content after removing Authorization.
  const isKvLine = (s) => /^\s*[^#\s][^=]*=/.test(s);

  // Split into groups: a preamble (before the first table header) + one group per table header.
  const groups = [];
  let cur = { header: null, body: [] };
  for (const line of lines) {
    if (isHeader(line)) {
      groups.push(cur);
      cur = { header: line, body: [] };
    } else {
      cur.body.push(line);
    }
  }
  groups.push(cur);

  const outGroups = [];
  let wroteChorus = false;
  for (const g of groups) {
    if (g.header === null) {
      outGroups.push(...g.body); // preamble verbatim
      continue;
    }
    if (chorusHeaderRe.test(g.header)) {
      // Normalize the [mcp_servers.chorus] body: set url + bearer_token_env_var in place,
      // drop any literal bearer_token, preserve every other key.
      let seenUrl = false;
      let seenBearerEnv = false;
      const body = [];
      for (const l of g.body) {
        if (/^\s*url\s*=/.test(l)) {
          body.push(`url = ${toToml(mcpUrl)}`);
          seenUrl = true;
          continue;
        }
        if (/^\s*bearer_token_env_var\s*=/.test(l)) {
          body.push(`bearer_token_env_var = ${toToml(BEARER_ENV_VAR)}`);
          seenBearerEnv = true;
          continue;
        }
        if (/^\s*bearer_token\s*=/.test(l)) continue; // drop legacy literal bearer_token
        body.push(l);
      }
      const head = [];
      if (!seenUrl) head.push(`url = ${toToml(mcpUrl)}`);
      if (!seenBearerEnv) head.push(`bearer_token_env_var = ${toToml(BEARER_ENV_VAR)}`);
      outGroups.push(g.header, ...head, ...body);
      wroteChorus = true;
      continue;
    }
    if (headersHeaderRe.test(g.header)) {
      // Strip the literal Authorization; drop the whole subtable if nothing else remains.
      const body = g.body.filter((l) => !/^\s*Authorization\s*=/i.test(l));
      if (body.some(isKvLine)) {
        outGroups.push(g.header, ...body);
      }
      // else: drop the emptied subtable entirely
      continue;
    }
    outGroups.push(g.header, ...g.body);
  }

  if (!wroteChorus) {
    if (outGroups.length && outGroups[outGroups.length - 1] !== "") outGroups.push("");
    outGroups.push(
      "[mcp_servers.chorus]",
      `url = ${toToml(mcpUrl)}`,
      `bearer_token_env_var = ${toToml(BEARER_ENV_VAR)}`,
    );
  }

  // Trim trailing blank lines so idempotent re-runs never accumulate them.
  while (outGroups.length && outGroups[outGroups.length - 1] === "") outGroups.pop();
  const content = outGroups.join("\n") + "\n";

  mkdir(dirname(configPath), { recursive: true });
  const tmp = `${configPath}.tmp`;
  write(tmp, content, { mode: 0o600 });
  rename(tmp, configPath);
  return configPath;
}
