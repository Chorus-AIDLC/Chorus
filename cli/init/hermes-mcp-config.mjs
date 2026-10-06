// cli/init/hermes-mcp-config.mjs
// Upserts the native `mcp_servers.chorus` entry in the Hermes config
// ($HERMES_HOME/config.yaml, default ~/.hermes/config.yaml) for a NON-loopback Chorus.
//
// Why: the portable `chorus-mcp/mcp.json` package can only carry the literal loopback URL
// (Hermes validates portable URLs without `${VAR}` expansion), so any other deployment needs
// a native entry, which Hermes interpolates and which wins over the portable server of the
// same name (see packages/chorus-hermes/README.md, note 5).
//
// Why not `hermes config set`: on the verified Hermes v0.21.5 a `config set` from a git
// install first runs a source-update/dependency step that needs the network (it hung on a
// timed-out urlopen), so it is not a reliable non-interactive writer. `hermes mcp add` has
// no non-interactive header form. Hence a TARGETED TEXTUAL upsert — no YAML-parser
// dependency (pure JS, cross-platform) — that rewrites only the `chorus:` child of the
// top-level `mcp_servers:` block and preserves every other line (keys, comments) verbatim.
//
// The secret is NEVER written: the header is the literal placeholder
// `Bearer ${CHORUS_API_KEY}`, which Hermes expands at connect time. The URL is not a
// secret and is written literally.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { codexMcpUrl } from "./codex-mcp-config.mjs";

export const HERMES_MCP_AUTH_PLACEHOLDER = "Bearer ${CHORUS_API_KEY}";
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const DEFAULT_PORT = "8637";

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** $HERMES_HOME/config.yaml (default ~/.hermes/config.yaml). */
export function resolveHermesConfigPath(env = process.env) {
  const base = nonEmpty(env.HERMES_HOME) ?? join(nonEmpty(env.HOME) ?? homedir(), ".hermes");
  return join(base, "config.yaml");
}

/**
 * True when `url` is the loopback default the portable package already serves
 * (`http://localhost:8637`, also 127.0.0.1 / [::1], with or without `/api/mcp`).
 * Any other URL — another host, port, scheme, or base path — needs the native entry.
 */
export function isHermesLoopbackDefault(url) {
  const u = nonEmpty(url);
  if (!u) return false;
  let parsed;
  try {
    parsed = new URL(u);
  } catch {
    return false;
  }
  const path = parsed.pathname.replace(/\/+$/, "");
  return (
    parsed.protocol === "http:" &&
    LOOPBACK_HOSTS.has(parsed.hostname) &&
    parsed.port === DEFAULT_PORT &&
    (path === "" || path === "/api/mcp")
  );
}

const yamlStr = (v) => `"${String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
const indentOf = (s) => s.length - s.trimStart().length;
const isBlank = (s) => s.trim() === "";
const isComment = (s) => s.trimStart().startsWith("#");
const isContent = (s) => !isBlank(s) && !isComment(s);

function chorusEntry(indent, mcpUrl) {
  const a = " ".repeat(indent);
  return [
    `${a}chorus:`,
    `${a}${a}url: ${yamlStr(mcpUrl)}`,
    `${a}${a}headers:`,
    `${a}${a}${a}Authorization: ${yamlStr(HERMES_MCP_AUTH_PLACEHOLDER)}`,
  ];
}

/**
 * Pure transform: return `text` with `mcp_servers.chorus` set to the given endpoint.
 * Throws when the top-level `mcp_servers` is a non-empty flow mapping (`{...}`) that cannot
 * be edited textually without risk.
 */
export function upsertHermesMcpYaml(text, mcpUrl) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.length ? text.split(/\r?\n/) : [];
  const hadTrailingNewline = lines.length > 0 && lines[lines.length - 1] === "";
  if (hadTrailingNewline) lines.pop();

  const top = lines.findIndex((l) => /^mcp_servers\s*:/.test(l));
  if (top === -1) {
    const block = ["mcp_servers:", ...chorusEntry(2, mcpUrl)];
    const sep = lines.length && !isBlank(lines[lines.length - 1]) ? [""] : [];
    return [...lines, ...sep, ...block].join(eol) + eol;
  }

  const inline = lines[top].replace(/^mcp_servers\s*:/, "").replace(/\s+#.*$/, "").trim();
  if (inline && !["{}", "null", "~"].includes(inline)) {
    throw new Error("mcp_servers in config.yaml is an inline mapping; add mcp_servers.chorus manually");
  }
  if (inline) lines[top] = "mcp_servers:";

  // Block extent: up to the next top-level content line.
  let end = top + 1;
  while (end < lines.length && !(isContent(lines[end]) && indentOf(lines[end]) === 0)) end += 1;
  const firstChild = lines.slice(top + 1, end).find(isContent);
  const childIndent = firstChild ? indentOf(firstChild) : 2;

  const chorusRe = /^\s*(chorus|"chorus"|'chorus')\s*:/;
  let start = -1;
  for (let i = top + 1; i < end; i += 1) {
    if (isContent(lines[i]) && indentOf(lines[i]) === childIndent && chorusRe.test(lines[i])) {
      start = i;
      break;
    }
  }

  const entry = chorusEntry(childIndent, mcpUrl);
  if (start === -1) {
    // Append as the last child, before any trailing blank/comment lines of the block.
    let at = end;
    while (at > top + 1 && !isContent(lines[at - 1])) at -= 1;
    lines.splice(at, 0, ...entry);
  } else {
    let stop = start + 1;
    while (stop < end && !(isContent(lines[stop]) && indentOf(lines[stop]) <= childIndent)) stop += 1;
    while (stop > start + 1 && isBlank(lines[stop - 1])) stop -= 1; // keep separating blank lines
    lines.splice(start, stop - start, ...entry);
  }
  return lines.join(eol) + eol;
}

/**
 * Write/merge `mcp_servers.chorus` into the Hermes config. Idempotent: when the content
 * would not change the file is not touched. Backs up an existing file via `backup` before
 * the first change; atomic temp+rename that keeps the existing file mode (0600 when new).
 * @param {{ configPath: string, url: string, backup?: (p: string) => unknown }} args
 * @returns {{ configPath: string, changed: boolean, mcpUrl: string }}
 */
export function writeHermesMcpServer({ configPath, url, backup }) {
  const mcpUrl = codexMcpUrl(url);
  if (!mcpUrl) throw new Error("writeHermesMcpServer requires a url");
  const existed = existsSync(configPath);
  const existing = existed ? readFileSync(configPath, "utf8") : "";
  const next = upsertHermesMcpYaml(existing, mcpUrl);
  if (existed && next === existing) return { configPath, changed: false, mcpUrl };

  const mode = existed ? statSync(configPath).mode & 0o777 : 0o600;
  if (existed && typeof backup === "function") backup(configPath);
  mkdirSync(dirname(configPath), { recursive: true });
  const tmp = `${configPath}.chorus-tmp-${process.pid}`;
  writeFileSync(tmp, next, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, configPath);
  return { configPath, changed: true, mcpUrl };
}
