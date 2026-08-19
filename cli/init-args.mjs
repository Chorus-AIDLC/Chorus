// cli/init-args.mjs
// Argument parsing + help text for `chorus init` (idea c055e285, A1). Pure and
// side-effect-free so it is unit-testable — chorus.mjs (which runs side effects
// at import) imports these helpers, mirroring cli/client-args.mjs.
//
// Zero dependencies — ships verbatim in the npm package alongside chorus.mjs.

/**
 * Parse `chorus init` flags out of an arg list. Recognizes:
 *   --agents <csv>   comma-separated agent ids (space + `=` forms), repeatable
 *                    (values accumulate); e.g. `--agents claude,codex`
 *   --all            configure every supported agent
 *   --yes / -y       skip confirmations (implied when non-TTY)
 *   --url <url>      Chorus URL (space + `=`) — for the credential-seed step
 *   --api-key <k>    Chorus API key (space + `=`)
 *   --help / -h
 *
 * Only keys that appear are set, so callers can distinguish "unset" from a
 * falsy value. `agents` is normalized to a de-duped, order-preserving array of
 * lowercased ids (empty tokens dropped); absent ⇒ `agents` is unset.
 *
 * @param {string[]} argv
 * @returns {{ agents?: string[], all?: boolean, yes?: boolean, url?: string,
 *   apiKey?: string, help?: boolean }}
 */
export function parseInitFlags(argv) {
  const out = {};
  /** @type {string[]} */
  const agentTokens = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--agents") agentTokens.push(argv[i + 1] ?? "");
    else if (a.startsWith("--agents=")) agentTokens.push(a.slice("--agents=".length));
    else if (a === "--all") out.all = true;
    else if (a === "--yes" || a === "-y") out.yes = true;
    else if (a === "--url") out.url = argv[i + 1];
    else if (a.startsWith("--url=")) out.url = a.slice("--url=".length);
    else if (a === "--api-key") out.apiKey = argv[i + 1];
    else if (a.startsWith("--api-key=")) out.apiKey = a.slice("--api-key=".length);
    else if (a === "--help" || a === "-h") out.help = true;
  }
  if (agentTokens.length) {
    const seen = new Set();
    /** @type {string[]} */
    const ids = [];
    for (const tok of agentTokens) {
      for (const raw of String(tok).split(",")) {
        const id = raw.trim().toLowerCase();
        if (id && !seen.has(id)) {
          seen.add(id);
          ids.push(id);
        }
      }
    }
    // Even a `--agents ""`/`--agents ,` that yields nothing still marks intent to
    // pass agents explicitly; expose the (possibly empty) array so the selector
    // can tell "user tried to specify agents" from "user gave no --agents at all".
    out.agents = ids;
  }
  return out;
}

/**
 * Help text for `chorus init [--help]`. Pure — takes the version so the caller
 * (which already read package.json) does no IO here.
 * @param {string} version
 * @returns {string}
 */
export function initHelpText(version) {
  return `
Chorus init v${version} — one command to configure this machine's coding agents
for Chorus. Detects installed agents, lets you pick which to configure, installs
each one's Chorus plugin via that agent's own marketplace, and captures your
Chorus credentials once into ~/.chorus/daemon.json.

USAGE
  chorus init                          Interactive: detect, select, configure
  chorus init --all                    Configure every supported agent
  chorus init --agents claude,codex    Configure only the named agents

OPTIONS
  --agents <a,b>           Comma-separated agent ids to configure (repeatable).
                           Valid ids come from the adapter registry; an unknown
                           id is rejected with the list of valid ids.
  --all                    Configure every supported agent.
  --url <url>              Chorus server URL     (env: CHORUS_URL) — seeded once.
  --api-key <cho_...>      Agent API key         (env: CHORUS_API_KEY) — seeded once.
  -y, --yes                Skip confirmation prompts (implied when non-TTY).
  -h, --help               Show this help message.

NON-INTERACTIVE
  When stdin/stdout is not a TTY, you MUST pass --agents or --all — init will not
  guess which agents to configure and aborts otherwise.

SCOPE
  This installs the plugin SURFACE and seeds credentials into the daemon config.
  Live MCP tools for each agent arrive with a sibling feature (the 'chorus mcp'
  proxy). The legacy install-*.sh scripts are left untouched.

EXAMPLES
  chorus init
  chorus init --all --yes
  chorus init --agents claude,codex --url https://chorus.example.com --api-key cho_xxx --yes
`;
}
