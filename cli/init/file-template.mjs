// cli/init/file-template.mjs
// Kiro's Chorus "plugin" is not a CLI-installable package — it is a set of loose
// files dropped under .kiro/ (skills, the `chorus` main agent + reviewer
// subagents, the steering doc, and the session-automation hook scripts), plus a
// `chorus` MCP server merged into settings/mcp.json. public/install-kiro.sh does
// this in bash; this module re-implements the same drop natively in pure JS so
// `chorus init` can install it CROSS-PLATFORM (Windows-safe) with no bash / curl
// dependency — Node's built-in `fetch` downloads the template, node:fs writes it.
//
// ASSET SOURCE (owner-decided): the .kiro/ assets are DOWNLOADED from the
// connected Chorus instance at `${CHORUS_URL}/kiro-plugin/…` (mirroring
// install-kiro.sh's remote mode), NOT bundled into the npm package. `chorus init`
// already holds the connection URL, so this keeps the assets in lockstep with the
// server the user is connecting to and avoids shipping a second copy.
//
// ANTI-DRIFT: the variable asset lists (skills / reviewer agents / hook scripts)
// live in ONE shared data file — public/kiro-plugin/manifest.txt — read by BOTH
// this module (parseManifest) and install-kiro.sh (its load_manifest). A parity
// test asserts the two resolve the identical set. bash can't import a JS module,
// so the shared thing is a plain data file, not code.

import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** The shared artifact manifest (repo path — used by the parity test; the runtime
 *  installer downloads its own copy from the instance so it works in the stripped
 *  npm package where public/ is not shipped). */
export const KIRO_MANIFEST_URL = new URL("../../public/kiro-plugin/manifest.txt", import.meta.url);

/**
 * Parse the shared manifest text into the three artifact lists. Mirror of
 * install-kiro.sh's `load_manifest`: one "<kind> <name>" pair per line; blank
 * lines and `#` comments ignored; kind ∈ {skill, reviewer, hook}. Unknown kinds
 * are ignored (forward-compatible).
 * @param {string} text
 * @returns {{ skills: string[], reviewerAgents: string[], hookScripts: string[] }}
 */
export function parseManifest(text) {
  const skills = [];
  const reviewerAgents = [];
  const hookScripts = [];
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(/\s+/);
    const kind = parts[0];
    const name = parts[1];
    if (!name) continue;
    if (kind === "skill") skills.push(name);
    else if (kind === "reviewer") reviewerAgents.push(name);
    else if (kind === "hook") hookScripts.push(name);
  }
  return { skills, reviewerAgents, hookScripts };
}

/** Read + parse the shared manifest from a local file (default: the repo copy).
 *  Used by the parity test; the installer downloads its copy instead. */
export function readKiroManifestFile({ manifestUrl = KIRO_MANIFEST_URL } = {}) {
  return parseManifest(readFileSync(fileURLToPath(manifestUrl), "utf8"));
}

/**
 * Normalize a Chorus connection URL to the ASSET BASE — the origin under which
 * public/ is served (public/kiro-plugin/… ⇒ `${base}/kiro-plugin/…`). Mirrors
 * install-kiro.sh: strip a trailing `/api/mcp` (the MCP endpoint) and any
 * trailing slash. Throws on an empty / non-http(s) URL (named in the message).
 * @param {string} chorusUrl
 * @returns {string}
 */
export function normalizeAssetBase(chorusUrl) {
  const raw = typeof chorusUrl === "string" ? chorusUrl.trim() : "";
  if (!raw) throw new Error("CHORUS_URL is not set — cannot download the kiro .kiro/ template");
  if (!/^https?:\/\//i.test(raw)) {
    throw new Error(`CHORUS_URL must start with http:// or https:// — got: ${raw}`);
  }
  return raw
    .replace(/\/+$/, "") // trailing slash(es)
    .replace(/\/api\/mcp$/i, "") // the MCP endpoint suffix
    .replace(/\/+$/, ""); // any slash the strip left behind
}

/**
 * Substitute the `__CHORUS_BIN__` placeholder in the main agent's hook `command`
 * strings with the resolved ABSOLUTE chorus-bin path. Fails loudly (throws) if
 * any placeholder survives — mirrors install-kiro.sh's post-write grep guard.
 * @param {string} text  raw agents/chorus.json content
 * @param {string} chorusBinAbs  absolute path to <KIRO_DIR>/chorus-bin
 * @returns {string}
 */
export function substituteChorusBin(text, chorusBinAbs) {
  const out = String(text).split("__CHORUS_BIN__").join(chorusBinAbs);
  if (out.includes("__CHORUS_BIN__")) {
    throw new Error("__CHORUS_BIN__ placeholder was not fully substituted in agents/chorus.json");
  }
  return out;
}

/**
 * Merge the `chorus` MCP server into an existing settings/mcp.json body,
 * PRESERVING every pre-existing server. Empty/absent body ⇒ a fresh document.
 * Invalid JSON throws (never silently clobbers a file we can't parse).
 * @param {string} existingText  current file contents ("" if absent)
 * @param {object} serverObj  the chorus server object to set at .mcpServers.chorus
 * @returns {string}  pretty-printed JSON (trailing newline)
 */
export function mergeChorusServer(existingText, serverObj) {
  let data = {};
  const trimmed = (existingText ?? "").trim();
  if (trimmed) {
    try {
      data = JSON.parse(trimmed);
    } catch (err) {
      throw new Error(`existing settings/mcp.json is not valid JSON: ${err?.message ?? String(err)}`);
    }
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) data = {};
  if (typeof data.mcpServers !== "object" || data.mcpServers === null || Array.isArray(data.mcpServers)) {
    data.mcpServers = {};
  }
  data.mcpServers.chorus = serverObj;
  return `${JSON.stringify(data, null, 2)}\n`;
}

/**
 * Install the Chorus `.kiro/` file template natively.
 *
 * Two phases guarantee NO PARTIAL DROP: (1) download every asset into memory,
 * verifying each fetch and aborting (naming the unreachable URL) before touching
 * disk; (2) only once all fetches succeed, write the tree, chmod hooks (POSIX
 * only), and merge the `chorus` MCP server into settings/mcp.json.
 *
 * @param {{
 *   chorusUrl: string,
 *   kiroDir: string,
 *   fetchImpl?: typeof fetch,
 *   backup?: (path: string) => (string|null),
 *   platform?: NodeJS.Platform,
 *   log?: (m: string) => void,
 * }} opts
 * @returns {Promise<{ skills: number, reviewerAgents: number, hookScripts: number, kiroDir: string, chorusBinAbs: string }>}
 */
export async function installFileTemplate({
  chorusUrl,
  kiroDir,
  fetchImpl,
  backup,
  platform = process.platform,
  log,
} = {}) {
  const assetBase = normalizeAssetBase(chorusUrl); // throws on bad/empty URL
  const doFetch = fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== "function") {
    throw new Error("no fetch implementation available (need Node 18+ global fetch or an injected fetchImpl)");
  }
  const kiroBase = `${assetBase}/kiro-plugin`;
  const chorusBinAbs = join(kiroDir, "chorus-bin");

  // fetch <relpath-under-kiro-plugin> as text; verify + name the URL on failure.
  async function fetchText(rel) {
    const url = `${kiroBase}/${rel}`;
    let res;
    try {
      res = await doFetch(url);
    } catch (err) {
      throw new Error(`failed to download ${url}: ${err?.message ?? String(err)}`);
    }
    if (!res || !res.ok) {
      throw new Error(`failed to download ${url} (HTTP ${res?.status ?? "?"}) — is CHORUS_URL correct and reachable?`);
    }
    return await res.text();
  }

  // ---- phase 1: fetch EVERYTHING into memory (no disk writes) ----
  const manifest = parseManifest(await fetchText("manifest.txt"));
  if (manifest.skills.length === 0 && manifest.reviewerAgents.length === 0 && manifest.hookScripts.length === 0) {
    throw new Error(`manifest at ${kiroBase}/manifest.txt resolved no assets — is the instance serving the kiro plugin?`);
  }

  /** @type {Map<string, { text: string, exec?: boolean }>} dest-abs-path -> content */
  const files = new Map();

  // fixed assets (single, always-present files — not in the variable manifest)
  const mcpTemplateText = await fetchText(".kiro/settings/mcp.json");
  files.set(join(kiroDir, "steering", "chorus.md"), { text: await fetchText(".kiro/steering/chorus.md") });
  files.set(join(kiroDir, "agents", "chorus.md"), { text: await fetchText(".kiro/agents/chorus.md") });
  // main agent: substitute the hook-command placeholder in memory (throws if it survives)
  files.set(join(kiroDir, "agents", "chorus.json"), {
    text: substituteChorusBin(await fetchText(".kiro/agents/chorus.json"), chorusBinAbs),
  });

  for (const a of manifest.reviewerAgents) {
    files.set(join(kiroDir, "agents", `${a}.json`), { text: await fetchText(`.kiro/agents/${a}.json`) });
  }
  for (const s of manifest.skills) {
    files.set(join(kiroDir, "skills", s, "SKILL.md"), { text: await fetchText(`.kiro/skills/${s}/SKILL.md`) });
  }
  for (const h of manifest.hookScripts) {
    files.set(join(chorusBinAbs, h), { text: await fetchText(`bin/${h}`), exec: true });
  }

  // The chorus server object is single-sourced from the downloaded template
  // (its url/auth are already ${...} env references — never literals).
  let serverObj;
  try {
    serverObj = JSON.parse(mcpTemplateText)?.mcpServers?.chorus;
  } catch (err) {
    throw new Error(`downloaded settings/mcp.json template is not valid JSON: ${err?.message ?? String(err)}`);
  }
  if (!serverObj || typeof serverObj !== "object") {
    throw new Error("downloaded settings/mcp.json template has no mcpServers.chorus entry to merge");
  }

  // ---- phase 2: write to disk (every fetch already verified) ----
  for (const [dest, { text, exec }] of files) {
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, text);
    if (exec && platform !== "win32") {
      try {
        chmodSync(dest, 0o755);
      } catch {
        // chmod is best-effort; a read-only FS shouldn't fail the whole install.
      }
    }
  }

  // ---- merge the `chorus` MCP server into settings/mcp.json (back up first) ----
  const mcpJsonPath = join(kiroDir, "settings", "mcp.json");
  mkdirSync(dirname(mcpJsonPath), { recursive: true });
  const existed = existsSync(mcpJsonPath);
  if (existed && typeof backup === "function") backup(mcpJsonPath);
  const existingText = existed ? readFileSync(mcpJsonPath, "utf8") : "";
  writeFileSync(mcpJsonPath, mergeChorusServer(existingText, serverObj));

  log?.(`[chorus init] kiro: wrote .kiro/ template into ${kiroDir}`);
  return {
    skills: manifest.skills.length,
    reviewerAgents: manifest.reviewerAgents.length,
    hookScripts: manifest.hookScripts.length,
    kiroDir,
    chorusBinAbs,
  };
}
