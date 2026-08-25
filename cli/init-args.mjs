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
 *   apiKey?: string, dshProfile?: string, daemonAutostart?: boolean,
 *   daemonWake?: string[], daemonWakeAll?: boolean, help?: boolean }}
 */
export function parseInitFlags(argv) {
  const out = {};
  /** @type {string[]} */
  const agentTokens = [];
  /** @type {string[]} */
  const daemonWakeTokens = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--agents") agentTokens.push(argv[i + 1] ?? "");
    else if (a.startsWith("--agents=")) agentTokens.push(a.slice("--agents=".length));
    else if (a === "--all") out.all = true;
    else if (a === "--yes" || a === "-y") out.yes = true;
    else if (a === "--daemon-autostart") out.daemonAutostart = true;
    else if (a === "--daemon-wake-all") out.daemonWakeAll = true;
    else if (a === "--daemon-wake") daemonWakeTokens.push(argv[i + 1] ?? "");
    else if (a.startsWith("--daemon-wake=")) daemonWakeTokens.push(a.slice("--daemon-wake=".length));
    else if (a === "--url") out.url = argv[i + 1];
    else if (a.startsWith("--url=")) out.url = a.slice("--url=".length);
    else if (a === "--api-key") out.apiKey = argv[i + 1];
    else if (a.startsWith("--api-key=")) out.apiKey = a.slice("--api-key=".length);
    else if (a === "--dsh-profile") out.dshProfile = argv[i + 1];
    else if (a.startsWith("--dsh-profile=")) out.dshProfile = a.slice("--dsh-profile=".length);
    else if (a === "--help" || a === "-h") out.help = true;
  }
  // Normalize a comma-separated, repeatable token list into a de-duped lowercased id
  // array (shared shape for --agents and --daemon-wake).
  const normalizeIds = (tokens) => {
    const seen = new Set();
    /** @type {string[]} */
    const ids = [];
    for (const tok of tokens) {
      for (const raw of String(tok).split(",")) {
        const id = raw.trim().toLowerCase();
        if (id && !seen.has(id)) {
          seen.add(id);
          ids.push(id);
        }
      }
    }
    return ids;
  };
  if (agentTokens.length) {
    // Even a `--agents ""`/`--agents ,` that yields nothing still marks intent to
    // pass agents explicitly; expose the (possibly empty) array so the selector
    // can tell "user tried to specify agents" from "user gave no --agents at all".
    out.agents = normalizeIds(agentTokens);
  }
  if (daemonWakeTokens.length) out.daemonWake = normalizeIds(daemonWakeTokens);
  return out;
}

/**
 * Help text for `chorus agents add [--help]` (formerly `chorus init`). Pure —
 * takes the version so the caller (which already read package.json) does no IO here.
 * @param {string} version
 * @returns {string}
 */
export function initHelpText(version) {
  return `
Chorus agents add v${version} — one command to configure this machine's coding agents
for Chorus. Detects installed agents, lets you pick which to configure, installs
each one's Chorus plugin via that agent's own marketplace, and captures your
Chorus credentials once into ~/.chorus/daemon.json. (Formerly \`chorus init\`.)

USAGE
  chorus agents add                          Interactive: detect, select, configure
  chorus agents add --all                    Configure every supported agent
  chorus agents add --agents claude,codex    Configure only the named agents

OPTIONS
  --agents <a,b>           Comma-separated agent ids to configure (repeatable).
                           Valid ids come from the adapter registry; an unknown
                           id is rejected with the list of valid ids.
  --all                    Configure every supported agent.
  --url <url>              Chorus server URL     (env: CHORUS_URL) — seeded once.
  --api-key <cho_...>      Agent API key         (env: CHORUS_API_KEY) — seeded once.
  --dsh-profile <name>     dsh profile to install the Chorus bundle into
                           (env: CHORUS_DSH_PROFILE). Required for dsh in a
                           non-interactive run; prompted on a TTY.
  --daemon-wake <a,b>      Enable daemon auto-waking for these selected agents
                           (repeatable). Wakeable agents (claude/codex/kiro) default
                           to NOT woken; this opts specific ones in. On a TTY you are
                           prompted per agent instead.
  --daemon-wake-all        Enable daemon auto-waking for every selected wakeable agent.
  --daemon-autostart       Install & enable the daemon boot service (Linux systemd /
                           macOS launchd) in a non-interactive run. Ignored where
                           auto-start is unsupported (e.g. Windows). In an
                           interactive TTY run the daemon-setup step prompts instead
                           (default: No).
  -y, --yes                Skip confirmation prompts (implied when non-TTY).
  -h, --help               Show this help message.

NON-INTERACTIVE
  When stdin/stdout is not a TTY, you MUST pass --agents or --all — the command
  will not guess which agents to configure and aborts otherwise. The daemon boot service is
  installed non-interactively ONLY when you pass --daemon-autostart; otherwise the
  daemon config is written and you start it yourself with 'chorus daemon'.

SCOPE
  This installs the plugin SURFACE, seeds credentials into the daemon config, and
  optionally configures + auto-starts the local daemon. Live MCP tools for each
  agent arrive with a sibling feature (the 'chorus mcp' proxy). The legacy
  install-*.sh scripts are left untouched.

EXAMPLES
  chorus agents add
  chorus agents add --all --yes
  chorus agents add --agents claude,codex --url https://chorus.example.com --api-key cho_xxx --yes
  chorus agents add --all --yes --daemon-autostart
`;
}
