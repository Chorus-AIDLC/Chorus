// cli/mcp.mjs
// `chorus mcp` command group — the native MCP client surface (call / whoami /
// list). Thin orchestration over the pure arg engine (cli/mcp-args.mjs), the
// credential/identity resolver (cli/credentials.mjs), and the MCP client
// (cli/chorus-client.mjs). All IO + collaborators are injectable so this is
// unit-testable with fakes. See openspec/changes/add-cli-mcp-native-client/.

import { readFileSync } from "node:fs";
import { parseMcpArgs, assembleArgs, mcpHelpText, UsageError } from "./mcp-args.mjs";
import { resolveMcpCredentials } from "./credentials.mjs";
import { ChorusClient, validateAndFetchIdentity } from "./chorus-client.mjs";

// Exit codes (design.md "Output & exit-code semantics"):
const EXIT_OK = 0; // success
const EXIT_TOOL_ERROR = 1; // tool returned isError
const EXIT_USAGE = 2; // bad flags / JSON / ambiguity / transport / auth

/** First line of a (possibly multi-line) description, for the `list` output. */
function firstLine(s) {
  const nl = s.indexOf("\n");
  return nl === -1 ? s : s.slice(0, nl);
}

/**
 * Announce the acting agent on stderr for the identity-oriented actions
 * (whoami / list) when a NAMED agent was selected from daemon.json agents[].
 * Never emitted for the flag/env path (label "flag"/"env") and never on
 * `call` (whose stdout must stay a byte-exact tool payload).
 */
function noticeActingAs(creds, err) {
  if (creds.label && creds.label !== "flag" && creds.label !== "env") {
    err.write(`(acting as agent "${creds.label}")\n`);
  }
}

/**
 * Run `chorus mcp <action> …`. Returns an exit code — never calls
 * `process.exit` (the entry module owns process lifetime).
 *
 * @param {string[]} argv  argv AFTER the `mcp` word (process.argv.slice(3)).
 * @param {{
 *   version?: string,
 *   stdout?: { write(s:string):unknown },
 *   stderr?: { write(s:string):unknown },
 *   makeClient?: (o:{url:string,apiKey:string}) => any,
 *   readFile?: (path:string)=>string,
 *   readStdin?: ()=>string,
 *   resolveCreds?: (flags:any, deps:any)=>{url:string,apiKey:string,label:string},
 *   credsDeps?: any,
 * }} [opts]
 * @returns {Promise<number>}
 */
export async function runMcp(argv, opts = {}) {
  const version = opts.version ?? "";
  const out = opts.stdout ?? process.stdout;
  const err = opts.stderr ?? process.stderr;
  const makeClient = opts.makeClient ?? ((o) => new ChorusClient(o));
  const readFile = opts.readFile ?? ((p) => readFileSync(p, "utf8"));
  // fd 0 = stdin; readFileSync(0) drains it synchronously (fine for a one-shot CLI).
  const readStdin = opts.readStdin ?? (() => readFileSync(0, "utf8"));
  const resolveCreds = opts.resolveCreds ?? resolveMcpCredentials;

  // 1. Parse (structural).
  let parsed;
  try {
    parsed = parseMcpArgs(argv);
  } catch (e) {
    if (e instanceof UsageError) {
      err.write(`error: ${e.message}\n\n${mcpHelpText(version)}`);
      return EXIT_USAGE;
    }
    throw e;
  }

  if (parsed.help || !parsed.action) {
    out.write(mcpHelpText(version));
    return EXIT_OK;
  }

  // 2. Resolve credentials + acting identity.
  let creds;
  try {
    creds = resolveCreds(parsed.creds, opts.credsDeps ?? {});
  } catch (e) {
    err.write(`error: ${/** @type {Error} */ (e).message}\n`);
    return EXIT_USAGE;
  }

  // 3. Dispatch the action.
  if (parsed.action === "call") {
    let args;
    try {
      args = assembleArgs(parsed, { readFile, readStdin });
    } catch (e) {
      if (e instanceof UsageError) {
        err.write(`error: ${e.message}\n`);
        return EXIT_USAGE;
      }
      throw e;
    }
    const client = makeClient({ url: creds.url, apiKey: creds.apiKey });
    try {
      const { isError, text } = await client.callToolRaw(parsed.tool, args);
      if (isError) {
        // Tool-level error → stderr, non-zero, stdout stays empty.
        err.write(text.endsWith("\n") ? text : `${text}\n`);
        return EXIT_TOOL_ERROR;
      }
      // Success → verbatim text on stdout, matching `chorus-api.sh mcp-tool`'s
      // `jq -r` (which appends a single trailing newline).
      out.write(`${text}\n`);
      return EXIT_OK;
    } catch (e) {
      err.write(`error: ${/** @type {Error} */ (e).message}\n`);
      return EXIT_USAGE;
    } finally {
      await safeDisconnect(client);
    }
  }

  if (parsed.action === "whoami") {
    noticeActingAs(creds, err);
    try {
      // Fresh identity via chorus_checkin every call — no on-disk cache.
      const identity = await validateAndFetchIdentity(
        { url: creds.url, apiKey: creds.apiKey },
        { makeClient },
      );
      out.write(`${identity.uuid}\n`);
      return EXIT_OK;
    } catch (e) {
      err.write(`error: ${/** @type {Error} */ (e).message}\n`);
      return EXIT_USAGE;
    }
  }

  if (parsed.action === "list") {
    noticeActingAs(creds, err);
    const client = makeClient({ url: creds.url, apiKey: creds.apiKey });
    try {
      const tools = await client.listTools();
      for (const t of tools) {
        out.write(t.description ? `${t.name} — ${firstLine(t.description)}\n` : `${t.name}\n`);
      }
      return EXIT_OK;
    } catch (e) {
      err.write(`error: ${/** @type {Error} */ (e).message}\n`);
      return EXIT_USAGE;
    } finally {
      await safeDisconnect(client);
    }
  }

  return EXIT_USAGE;
}

/** Disconnect without letting a teardown error mask the real result. */
async function safeDisconnect(client) {
  try {
    if (client && typeof client.disconnect === "function") await client.disconnect();
  } catch {
    // ignore
  }
}
