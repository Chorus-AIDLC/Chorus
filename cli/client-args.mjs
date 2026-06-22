// cli/client-args.mjs
// Argument parsing + help text for the `chorus` client subcommands (`daemon`,
// `login`). Extracted from chorus.mjs so it is pure and unit-testable — the
// entry-point module runs side effects (server launch, process.exit) at import
// time and cannot be imported into a test. chorus.mjs imports these helpers.
//
// Zero dependencies — ships verbatim in the npm package alongside chorus.mjs.

/**
 * The daemon lifecycle sub-actions (background-mode control). `run` (the
 * default long-lived daemon) is intentionally NOT in this set — it is the
 * absence of a recognized sub-action token.
 */
export const DAEMON_ACTIONS = new Set(["stop", "status", "restart", "logs"]);

/** Known agent backends. Only `claude-code` is implemented; the rest reserve
 * the extension point (see daemon-agent-selection). Exported for the resolver
 * the --agent task wires in; parsing here does not validate the value. */
export const KNOWN_AGENTS = new Set(["claude-code"]);

/**
 * Parse the client-subcommand flags out of an arg list. Recognizes the
 * pre-existing `--url` / `--api-key` / `--sigint-timeout` (space and `=` forms)
 * and boolean `--yolo`, plus the new `--agent <type>` (space + `=`), boolean
 * `--chorus-only`, `--verbose`, `-d`/`--detach`, and `--help`/`-h`.
 *
 * Only keys that appear are set, so callers can distinguish "unset" from
 * "false" (important for layered env/flag precedence downstream).
 *
 * @param {string[]} argv
 * The new repeatable `--cwd <path>` (space + `=`) declares a working directory the
 * daemon serves; repeating it (`--cwd a --cwd b`) declares the SET of paths for the
 * single-daemon multi-path engine (T3). It is collected into a `cwd: string[]` array
 * preserving order; absent ⇒ `cwd` is unset (the layered resolver then falls back to
 * env / config / the process cwd). It is JUST a path list — no project binding.
 *
 * @returns {{
 *   url?: string, apiKey?: string, yolo?: boolean, sigintTimeout?: string,
 *   agent?: string, chorusOnly?: boolean, verbose?: boolean, detach?: boolean,
 *   cwd?: string[], help?: boolean,
 * }}
 */
export function parseClientFlags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--url") out.url = argv[i + 1];
    else if (a.startsWith("--url=")) out.url = a.slice("--url=".length);
    else if (a === "--api-key") out.apiKey = argv[i + 1];
    else if (a.startsWith("--api-key=")) out.apiKey = a.slice("--api-key=".length);
    else if (a === "--yolo") out.yolo = true;
    else if (a === "--sigint-timeout") out.sigintTimeout = argv[i + 1];
    else if (a.startsWith("--sigint-timeout=")) out.sigintTimeout = a.slice("--sigint-timeout=".length);
    else if (a === "--agent") out.agent = argv[i + 1];
    else if (a.startsWith("--agent=")) out.agent = a.slice("--agent=".length);
    else if (a === "--cwd" || a.startsWith("--cwd=")) {
      // Repeatable: collect every --cwd into an ordered array (the cwd SET).
      const value = a === "--cwd" ? argv[i + 1] : a.slice("--cwd=".length);
      if (typeof value === "string") (out.cwd ??= []).push(value);
    }
    else if (a === "--chorus-only") out.chorusOnly = true;
    else if (a === "--verbose") out.verbose = true;
    else if (a === "-d" || a === "--detach") out.detach = true;
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

/**
 * Determine the daemon lifecycle sub-action from the args following `daemon`.
 * The sub-action MUST be the very FIRST token (`chorus daemon stop`), so we
 * inspect only `rest[0]` — not any non-flag token. Checking the first
 * positional anywhere would misread a flag *value* that happens to equal an
 * action verb (`daemon --url stop` → "stop"); pinning to `rest[0]` avoids that.
 * Anything else (no args, a flag-leading list like `daemon -d` / `daemon --url …`,
 * or an unknown leading token) is the normal long-lived daemon (`run`).
 *
 * @param {string[]} rest  argv after the `daemon` subcommand token
 * @returns {"run"|"stop"|"status"|"restart"|"logs"}
 */
export function parseDaemonAction(rest) {
  const first = rest[0];
  if (first && DAEMON_ACTIONS.has(first)) return /** @type any */ (first);
  return "run";
}

/**
 * Help text for `chorus daemon [--help]`. Pure — takes the version so the
 * caller (which already read package.json) does no IO here.
 * @param {string} version
 * @returns {string}
 */
export function daemonHelpText(version) {
  return `
Chorus daemon v${version} — connect to a remote Chorus server, subscribe to the
agent notification stream, and wake a local headless agent on task dispatch.

USAGE
  chorus daemon [options]              Run the daemon (foreground)
  chorus daemon -d [options]           Run the daemon in the background (detached)
  chorus daemon stop                   Stop the background daemon
  chorus daemon status                 Show whether the background daemon is running
  chorus daemon restart                Restart the background daemon
  chorus daemon logs                   Show the background daemon log

OPTIONS
  --url <url>              Remote Chorus server URL            (env: CHORUS_URL)
  --api-key <cho_...>      Agent API key                       (env: CHORUS_API_KEY)
  --agent <type>           Local agent backend to wake         (env: CHORUS_AGENT)
                           (default: claude-code; only claude-code is implemented)
  --yolo                   Full autonomy for the woken agent   (env: CHORUS_YOLO=1)
                           (--dangerously-skip-permissions: Bash, file writes, any
                           command). This is the DEFAULT permission mode.
  --chorus-only            Restrict the woken agent to Chorus  (env: CHORUS_CHORUS_ONLY=1)
                           MCP tools only (no Bash / file edits) — reclaims the
                           safe posture from the default yolo.
  --cwd <path>             A working directory the daemon serves. Repeatable —
                           (env: CHORUS_DAEMON_CWDS) each --cwd registers an independent
                           connection for that path, so one daemon can serve several
                           local paths at once. Default: the directory it was launched
                           from. (Also configurable as "cwds":[…] in ~/.chorus/daemon.json.)
  -d, --detach             Run detached in the background (pidfile + logfile)
  --verbose                More detailed per-wake logging
  --sigint-timeout <ms>    Grace window after SIGINT before a forceful kill
                           (env: CHORUS_DAEMON_SIGINT_TIMEOUT; default 10000)
  -h, --help               Show this help message

CREDENTIALS
  Resolution order: flags > CHORUS_URL/CHORUS_API_KEY env >
  ~/.chorus/daemon.json (from 'chorus login') > Claude Code plugin config.
  On a TTY with no resolvable credentials, the daemon prompts to complete them.

EXAMPLES
  chorus daemon                        # Foreground, default yolo (TTY confirms once)
  chorus daemon --chorus-only          # Restrict the woken agent to Chorus tools
  chorus daemon -d                     # Background; see 'chorus daemon logs'
  chorus daemon stop                   # Stop the background daemon
`;
}

/**
 * Help text for `chorus login [--help]`.
 * @param {string} version
 * @returns {string}
 */
export function loginHelpText(version) {
  return `
Chorus login v${version} — authenticate as an agent and save credentials to
~/.chorus/daemon.json (0600) for later use by 'chorus daemon'.

USAGE
  chorus login [options]               Validate a key and persist credentials

OPTIONS
  --url <url>              Remote Chorus server URL            (env: CHORUS_URL)
  --api-key <cho_...>      Agent API key                       (env: CHORUS_API_KEY)
  -h, --help               Show this help message

  With no flags, login prompts interactively for the URL and a masked API key,
  validates them against the server, and on success saves the credentials.
`;
}
