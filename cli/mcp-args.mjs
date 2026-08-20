// cli/mcp-args.mjs
// Pure, dependency-injected argument parser + assembler for the `chorus mcp`
// command group (call / whoami / list). No direct IO — file/stdin reads are
// injected so this is fully unit-testable. This is the byte-faithful
// replacement for the plugin's `json_encode_file` bash helper: a file's raw
// bytes become a JSON *string* value (equivalent to `jq -Rs '.'`), never
// re-parsed. See openspec/changes/add-cli-mcp-native-client/design.md.

/** Thrown on any structural / usage problem. The command layer maps it to a
 * stderr diagnostic + a non-zero (usage) exit code. */
export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "UsageError";
  }
}

const ACTIONS = new Set(["call", "whoami", "list"]);

/** Flags that consume the following token as their value (or `--flag=value`). */
const VALUE_FLAGS = new Set(["--arg", "--arg-file", "--args-file", "--agent", "--url", "--api-key"]);

/**
 * @typedef {Object} ParsedMcp
 * @property {boolean} help            `--help`/`-h` requested (short-circuits).
 * @property {"call"|"whoami"|"list"|null} action
 * @property {string|null} tool        Tool name (call only).
 * @property {string|null} positionalJson  Base arguments as a JSON string.
 * @property {string|null} argsFile    Base arguments from a JSON file (`-`=stdin).
 * @property {Array<{type:"arg"|"arg-file", key:string, raw:string}>} overrides
 *   Per-key overrides in command-line order. `type:"arg"` raw is the literal /
 *   `@file` value; `type:"arg-file"` raw is the path.
 * @property {{ agent?:string, url?:string, apiKey?:string }} creds
 */

/**
 * Parse the argv AFTER the `mcp` subcommand word (i.e. `process.argv.slice(3)`).
 * Structural only — file/stdin reads and JSON parsing happen in assembleArgs.
 * @param {string[]} argv
 * @returns {ParsedMcp}
 * @throws {UsageError}
 */
export function parseMcpArgs(argv) {
  const out = /** @type {ParsedMcp} */ ({
    help: false,
    action: null,
    tool: null,
    positionalJson: null,
    argsFile: null,
    overrides: [],
    creds: {},
  });

  // A leading --help/-h (before any action) is a group help request.
  const tokens = [...argv];
  const positionals = [];

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];

    if (tok === "--help" || tok === "-h") {
      out.help = true;
      continue;
    }

    if (tok.startsWith("--")) {
      // Support both `--flag value` and `--flag=value`.
      let name = tok;
      let inlineValue = null;
      const eq = tok.indexOf("=");
      if (eq !== -1) {
        name = tok.slice(0, eq);
        inlineValue = tok.slice(eq + 1);
      }

      if (!VALUE_FLAGS.has(name)) {
        throw new UsageError(`Unknown flag: ${name}`);
      }

      const value = inlineValue !== null ? inlineValue : tokens[++i];
      if (value === undefined) {
        throw new UsageError(`Flag ${name} requires a value`);
      }

      switch (name) {
        case "--arg": {
          const kv = splitKeyValue(value, "--arg");
          out.overrides.push({ type: "arg", key: kv.key, raw: kv.value });
          break;
        }
        case "--arg-file": {
          const kv = splitKeyValue(value, "--arg-file");
          out.overrides.push({ type: "arg-file", key: kv.key, raw: kv.value });
          break;
        }
        case "--args-file":
          out.argsFile = value;
          break;
        case "--agent":
          out.creds.agent = value;
          break;
        case "--url":
          out.creds.url = value;
          break;
        case "--api-key":
          out.creds.apiKey = value;
          break;
      }
      continue;
    }

    // Bare positional.
    positionals.push(tok);
  }

  // First positional = action.
  if (positionals.length === 0) {
    if (out.help) return out; // `chorus mcp --help`
    throw new UsageError("Missing action. Expected: call | whoami | list");
  }
  const action = positionals[0];
  if (!ACTIONS.has(action)) {
    throw new UsageError(`Unknown action "${action}". Expected: call | whoami | list`);
  }
  out.action = /** @type {"call"|"whoami"|"list"} */ (action);

  if (action === "call") {
    // positionals[1] = tool, positionals[2] = base JSON. No more.
    out.tool = positionals[1] ?? null;
    if (!out.help && !out.tool) throw new UsageError("`chorus mcp call` requires a <tool> name");
    if (positionals.length > 3) {
      throw new UsageError(
        "Too many positional arguments. Usage: chorus mcp call <tool> ['<json>'] [flags]",
      );
    }
    out.positionalJson = positionals[2] ?? null;
  } else {
    // whoami / list take no positional beyond the action.
    if (positionals.length > 1) {
      throw new UsageError(`\`chorus mcp ${action}\` takes no positional arguments`);
    }
    if (out.overrides.length || out.positionalJson || out.argsFile) {
      throw new UsageError(`\`chorus mcp ${action}\` does not accept --arg/--arg-file/--args-file`);
    }
  }

  return out;
}

/** Split `key=value` on the FIRST `=`. */
function splitKeyValue(token, flag) {
  const eq = token.indexOf("=");
  if (eq === -1) throw new UsageError(`${flag} expects key=value (got "${token}")`);
  const key = token.slice(0, eq);
  if (!key) throw new UsageError(`${flag} has an empty key (got "${token}")`);
  return { key, value: token.slice(eq + 1) };
}

/**
 * Build the tool `arguments` object from a parsed `call`. Layers sources, later
 * overriding earlier, applied in command-line order:
 *   1. base = positional JSON XOR --args-file (both → error; neither → {}).
 *   2/3/4. --arg literal / --arg-file / @file → per-key overrides (files → string).
 * File-fill sources inject file bytes as a JSON string (never JSON-parsed).
 * At most one source may consume stdin (`-`).
 *
 * @param {ParsedMcp} parsed
 * @param {{ readFile: (path:string)=>string, readStdin: ()=>string }} io
 * @returns {Record<string, unknown>}
 * @throws {UsageError}
 */
export function assembleArgs(parsed, io) {
  const { readFile, readStdin } = io;
  let stdinUsed = false;
  const consumeStdin = () => {
    if (stdinUsed) throw new UsageError("stdin (-) can only be consumed by one argument");
    stdinUsed = true;
    try {
      return readStdin();
    } catch (e) {
      throw new UsageError(`cannot read stdin: ${/** @type {Error} */ (e).message}`);
    }
  };
  // A file-read failure (missing path, permissions) is a usage error, not a
  // transport/tool error — wrap it as UsageError so the command layer maps it to
  // the usage exit code (2), never the tool-error exit code (1).
  const readPath = (path) => {
    if (path === "-") return consumeStdin();
    try {
      return readFile(path);
    } catch (e) {
      throw new UsageError(`cannot read file "${path}": ${/** @type {Error} */ (e).message}`);
    }
  };

  // 1. Base object.
  if (parsed.positionalJson !== null && parsed.argsFile !== null) {
    throw new UsageError(
      "Provide the base arguments either as a positional JSON string OR --args-file, not both",
    );
  }
  let args = {};
  const rawBase =
    parsed.positionalJson !== null
      ? parsed.positionalJson
      : parsed.argsFile !== null
        ? readPath(parsed.argsFile)
        : null;
  if (rawBase !== null) {
    let parsedBase;
    try {
      parsedBase = JSON.parse(rawBase);
    } catch (err) {
      const src = parsed.positionalJson !== null ? "positional JSON argument" : `--args-file (${parsed.argsFile})`;
      throw new UsageError(`Invalid JSON in ${src}: ${/** @type {Error} */ (err).message}`);
    }
    if (parsedBase === null || typeof parsedBase !== "object" || Array.isArray(parsedBase)) {
      throw new UsageError("Base arguments must be a JSON object");
    }
    args = parsedBase;
  }

  // 2/3/4. Per-key overrides in command-line order.
  for (const ov of parsed.overrides) {
    if (ov.type === "arg-file") {
      args[ov.key] = readPath(ov.raw);
      continue;
    }
    // type === "arg": interpret the raw value.
    const raw = ov.raw;
    if (raw.startsWith("@@")) {
      // Escape: `@@rest` → literal `@rest`.
      args[ov.key] = "@" + raw.slice(2);
    } else if (raw.startsWith("@")) {
      // `@path` file sugar (`@-` → stdin).
      args[ov.key] = readPath(raw.slice(1));
    } else {
      args[ov.key] = raw;
    }
  }

  return args;
}

/** Help text for the `chorus mcp` command group. */
export function mcpHelpText(version = "") {
  const v = version ? ` v${version}` : "";
  return `\
Chorus${v} — native MCP client

USAGE
  chorus mcp call <tool> ['<json>'] [arg flags]   Call an MCP tool as the resolved agent
  chorus mcp whoami                               Print this agent's own UUID
  chorus mcp list                                 List the tools this agent may call

ARGUMENT FLAGS (call)
  <json>                Positional JSON object — the base arguments
  --args-file <path>    Read the whole arguments object from a JSON file ('-' = stdin)
  --arg key=value       Set key to the literal string value
  --arg-file key=<path> Set key to a file's raw bytes as a string ('-' = stdin)
  --arg key=@<path>     Shorthand for --arg-file ('@-' = stdin; '@@x' = literal '@x')
                        (later --arg/--arg-file override earlier keys, in order)

CREDENTIALS (all actions)
  --url <url>           Chorus server URL          (env: CHORUS_URL)
  --api-key <cho_...>   Agent API key              (env: CHORUS_API_KEY)
  --agent <label>       Select an agent from ~/.chorus/daemon.json agents[]
                        (required when several are configured and no env/flags)

OUTPUT
  call    prints the tool result's text verbatim on success (drop-in for
          chorus-api.sh mcp-tool); tool/transport errors go to stderr, exit != 0.
  whoami  prints the bare agent UUID.
  list    prints one 'name — description' line per permitted tool.
`;
}
