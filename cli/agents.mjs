// cli/agents.mjs
// `chorus agents` — manage this machine's configured agents (the ~/.chorus/daemon.json
// agents[]): `list` (default), `add` (detect + install plugin + seed creds — the flow
// formerly reached via `chorus init`, delegated to runInit), and `remove <name|uuid>`.
// Listing lets a user/agent discover the valid `CHORUS_AGENT_PROFILE` /
// `chorus mcp --agent <name|uuid>` values without hand-reading the JSON. The `cho_`
// API key is NEVER emitted by list/remove — not masked, omitted entirely.
//
// Peer of the other `chorus` subcommands (login / daemon / mcp); dispatched from
// chorus.mjs before the server boot path, so every `chorus agents …` help/list/remove
// path never starts the embedded PostgreSQL.

import { readFileSync } from "node:fs";
import { loginFilePath } from "./credentials.mjs";
import { updateDaemonConfig } from "./login.mjs";

/** Read + parse a JSON file, returning null on any error (missing/malformed). */
function readJsonSafe(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/** A non-empty trimmed string, or undefined. */
function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Compact host for the table (host[:port] only — never userinfo); never throws. */
function hostOf(url) {
  if (!url) return "";
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

/**
 * Safe url for machine (--json) output: the origin only (scheme://host[:port]).
 * Strips any userinfo / path / query so an accidental credential embedded in the
 * url can never surface. Returns null when absent or unparseable (never echoes
 * the raw string). Defense-in-depth — the stored API key lives in a separate
 * `apiKey` field this command never reads.
 */
function originOf(url) {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** Group help for `chorus agents` (list / add / remove). */
export function agentsHelpText(version = "") {
  const v = version ? ` v${version}` : "";
  return `\
Chorus${v} — manage this machine's configured agents

USAGE
  chorus agents [list]              List configured agents (name, UUID, backend)
  chorus agents --json              Machine-readable list (API keys never included)
  chorus agents add [flags]         Configure agent(s): detect, install plugin, seed
                                    credentials (formerly \`chorus init\`; same flags —
                                    see \`chorus agents add --help\`)
  chorus agents remove <name|uuid>  Remove a configured agent from ~/.chorus/daemon.json

Each listed UUID or name is a valid value for \`chorus mcp --agent <name|uuid>\` or the
CHORUS_AGENT_PROFILE environment variable. The API key is never printed.
`;
}

/**
 * Build the redacted agent rows from a parsed daemon.json object.
 * @param {Record<string, unknown>|null} file
 * @returns {Array<{index:number, name?:string, uuid?:string, agentType?:string, url?:string, daemonWake?:unknown, flat?:boolean}>}
 */
export function collectAgents(file) {
  if (!file) return [];
  const rows = [];
  if (Array.isArray(file.agents)) {
    file.agents.forEach((a, i) => {
      if (a && typeof a === "object") {
        rows.push({
          index: i,
          name: nonEmpty(a.agentName) ?? nonEmpty(a.name) ?? nonEmpty(a.label),
          uuid: nonEmpty(a.agentUuid),
          agentType: nonEmpty(a.agentType),
          url: nonEmpty(a.url) ?? nonEmpty(file.url),
          daemonWake: a.daemonWake,
        });
      }
    });
  }
  // Flat single-agent config (no agents[]): synthesize one row from the
  // deprecated top-level fields so it still shows up.
  if (rows.length === 0 && (nonEmpty(file.apiKey) || nonEmpty(file.agentUuid))) {
    rows.push({
      index: 0,
      name: nonEmpty(file.agentName),
      uuid: nonEmpty(file.agentUuid),
      agentType: nonEmpty(file.agent),
      url: nonEmpty(file.url),
      flat: true,
    });
  }
  return rows;
}

/**
 * List configured agents (the `chorus agents` / `chorus agents list` body).
 * Returns an exit code (never calls process.exit).
 * @param {string[]} argv  flags after the (optional) `list` sub-verb.
 * @param {object} [opts]
 * @returns {number}
 */
function listAgents(argv = [], opts = {}) {
  const out = opts.stdout ?? process.stdout;
  const err = opts.stderr ?? process.stderr;
  const env = opts.env ?? process.env;
  const readJson = opts.readJson ?? readJsonSafe;
  const loginPath = opts.loginPath ?? loginFilePath();
  const version = opts.version ?? "";

  let json = false;
  for (const tok of argv) {
    if (tok === "--help" || tok === "-h") {
      out.write(agentsHelpText(version));
      return 0;
    }
    if (tok === "--json") {
      json = true;
      continue;
    }
    err.write(`error: unknown flag: ${tok}\n\n${agentsHelpText(version)}`);
    return 2;
  }

  const rows = collectAgents(readJson(loginPath));
  const active = nonEmpty(env.CHORUS_AGENT_PROFILE);
  const isActive = (r) => active !== undefined && (r.uuid === active || r.name === active);

  if (json) {
    // Redacted objects — the apiKey is intentionally never included.
    const payload = rows.map((r) => ({
      index: r.index,
      name: r.name ?? null,
      uuid: r.uuid ?? null,
      agentType: r.agentType ?? null,
      url: originOf(r.url),
      daemonWake: r.daemonWake ?? null,
      active: isActive(r),
    }));
    out.write(`${JSON.stringify(payload, null, 2)}\n`);
    return 0;
  }

  if (rows.length === 0) {
    out.write(
      `No agents configured in ${loginPath}.\n` +
        "Run `chorus agents add` (or `chorus login`) to add one.\n",
    );
    return 0;
  }

  out.write(`Agents in ${loginPath}:\n`);
  for (const r of rows) {
    const mark = isActive(r) ? "* " : "  ";
    const name = r.name ?? "(unnamed)";
    const uuid = r.uuid ?? "(no uuid)";
    const bits = [r.agentType ?? "?"];
    if (r.daemonWake === false) bits.push("wake:off");
    const host = hostOf(r.url);
    if (host) bits.push(host);
    out.write(`${mark}[${r.index}] ${name}  ${uuid}  (${bits.join(", ")})\n`);
  }
  if (active) {
    out.write(
      rows.some(isActive)
        ? `\n* = active (CHORUS_AGENT_PROFILE="${active}")\n`
        : `\n(note: CHORUS_AGENT_PROFILE="${active}" is set but matches no agent above)\n`,
    );
  }
  out.write(
    "\nPass a UUID or name to `chorus mcp --agent <name|uuid>` or set CHORUS_AGENT_PROFILE.\n" +
      "API keys are never shown.\n",
  );
  return 0;
}

/** Usage for `chorus agents remove`. */
function removeHelpText() {
  return "USAGE\n  chorus agents remove <name|uuid>   Remove a configured agent from ~/.chorus/daemon.json\n";
}

/**
 * `chorus agents remove <name|uuid>` — drop the matching `agents[]` entry.
 * Merge-safe: rewrites daemon.json replacing `agents[]` with the filtered array,
 * preserving every other agent and all top-level fields. The API key is NEVER
 * printed. dependency-injected (readJson/writeConfig/loginPath) for tests.
 * @param {string[]} argv  args after the `remove` word (argv[0] = target).
 * @param {object} [opts]
 * @returns {number}
 */
export function removeAgent(argv = [], opts = {}) {
  const out = opts.stdout ?? process.stdout;
  const err = opts.stderr ?? process.stderr;
  const readJson = opts.readJson ?? readJsonSafe;
  const loginPath = opts.loginPath ?? loginFilePath();
  const writeConfig = opts.writeConfig ?? ((partial) => updateDaemonConfig(partial, { path: loginPath }));

  const first = argv[0];
  if (first === "--help" || first === "-h") {
    out.write(removeHelpText());
    return 0;
  }
  const target = nonEmpty(first);
  if (!target) {
    err.write("error: `chorus agents remove` requires an agent name or UUID.\n" + removeHelpText());
    return 2;
  }

  const file = readJson(loginPath);
  const agents = file && Array.isArray(file.agents) ? file.agents.filter((a) => a && typeof a === "object") : [];
  const keysOf = (a) => [a.agentUuid, a.agentName, a.label, a.name].map(nonEmpty).filter((k) => k !== undefined);
  const matches = [];
  agents.forEach((a, i) => {
    if (keysOf(a).includes(target)) matches.push(i);
  });

  if (matches.length === 0) {
    err.write(`error: no configured agent matches "${target}" in ${loginPath}.\n`);
    if (agents.length) {
      err.write("Configured agents:\n");
      agents.forEach((a, i) =>
        err.write(`  [${i}] ${nonEmpty(a.agentName) ?? "(unnamed)"}  ${nonEmpty(a.agentUuid) ?? "(no uuid)"}\n`),
      );
    } else {
      err.write("(none configured)\n");
    }
    return 1;
  }
  if (matches.length > 1) {
    err.write(
      `error: "${target}" is ambiguous — it matches ${matches.length} agents. Use the agent UUID to disambiguate.\n`,
    );
    return 2;
  }

  const idx = matches[0];
  const removed = agents[idx];
  const remaining = agents.filter((_, i) => i !== idx);
  // Replace agents[] wholesale (updateDaemonConfig shallow-merges the patch, so a
  // new `agents` array overwrites the old one) — preserves every top-level field.
  writeConfig({ agents: remaining });

  out.write(
    `Removed agent ${nonEmpty(removed.agentName) ?? "(unnamed)"} (${nonEmpty(removed.agentUuid) ?? "no uuid"}) ` +
      `from ${loginPath}. ${remaining.length} agent(s) remain.\n`,
  );
  // dsh: $DSH_HOME/.env holds a single shared url+key (not per-agent) and is left
  // untouched. dsh maps to the "offline" daemon agentType bucket — surface the note there.
  if (nonEmpty(removed.agentType) === "offline") {
    out.write(
      "Note: any dsh $DSH_HOME/.env credentials were left untouched (a single shared file) — clear them manually if needed.\n",
    );
  }
  // Claude Code: `chorus agents add` may have written CHORUS_* into the user-global
  // ~/.claude/settings.json env block. Reverse cleanup is out of scope — leave it in place
  // (a later re-add overwrites it idempotently) but tell the operator, mirroring the dsh note.
  if (nonEmpty(removed.agentType) === "claude-code") {
    out.write(
      "Note: any CHORUS_* keys written into ~/.claude/settings.json were left untouched — clear them manually if needed.\n",
    );
  }
  // Codex: `chorus agents add` may have written CHORUS_* into ~/.codex/.env (and a keyless
  // [mcp_servers.chorus] block that references CHORUS_API_KEY via bearer_token_env_var in
  // ~/.codex/config.toml — no literal key). Reverse cleanup is out of scope — leave it, tell the operator.
  if (nonEmpty(removed.agentType) === "codex") {
    out.write(
      "Note: any CHORUS_* env written into ~/.codex/.env " +
        "(and the keyless [mcp_servers.chorus] block in ~/.codex/config.toml, which references the key via bearer_token_env_var) were left untouched — clear them manually if needed.\n",
    );
  }
  return 0;
}

/**
 * Run `chorus agents [list|add|remove] …`. Dispatches the sub-verb:
 *   (none) / `list`   → list configured agents
 *   `add [flags]`     → runInit (the flow formerly reached via `chorus init`)
 *   `remove <n|uuid>` → removeAgent
 * A group-level `--help`/`-h` prints the group usage. Never boots the server.
 * Returns an exit code (or a Promise thereof for `add`).
 * @param {string[]} argv  argv AFTER the `agents` word.
 * @param {object} [opts]
 * @returns {number | Promise<number>}
 */
export function runAgents(argv = [], opts = {}) {
  const out = opts.stdout ?? process.stdout;
  const err = opts.stderr ?? process.stderr;
  const version = opts.version ?? "";
  const first = argv[0];

  if (first === "--help" || first === "-h") {
    out.write(agentsHelpText(version));
    return 0;
  }
  if (first === "add") {
    // Delegate to the existing init flow (renamed entry). Dynamic import keeps the
    // list/remove paths from loading the heavier init subsystem.
    const runInit = opts.runInit ?? (async (a, o) => (await import("./init.mjs")).runInit(a, o));
    return runInit(argv.slice(1), { version });
  }
  if (first === "remove") {
    return removeAgent(argv.slice(1), opts);
  }
  // An unknown positional sub-verb (not `list`, not a flag) is a usage error.
  if (first !== undefined && first !== "list" && !first.startsWith("-")) {
    err.write(`error: unknown \`chorus agents\` subcommand: ${first}\n\n${agentsHelpText(version)}`);
    return 2;
  }
  // Bare `chorus agents`, explicit `list`, or list flags (--json/--help handled inside).
  return listAgents(first === "list" ? argv.slice(1) : argv, opts);
}
