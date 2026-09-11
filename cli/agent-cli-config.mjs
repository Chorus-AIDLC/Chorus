// Per-profile literal argv/env. No IO, interpolation, defaults shared across agents,
// or attempt to sandbox an operator who controls their executable/config files.
const canonicalType = (type) => type === "claude" ? "claude-code" : type;

// Known controls owned by the headless adapters (also protected in persistent
// foreground config). Short options match attached values and clusters as well.
const PROTECTED = {
  "claude-code": {
    long: "print output-format input-format verbose session-id resume continue fork-session no-session-persistence mcp-config strict-mcp-config permission-mode permission-prompts permission-prompt-tool dangerously-skip-permissions allow-dangerously-skip-permissions allowedTools allowed-tools disallowedTools disallowed-tools tools add-dir cwd system-prompt system-prompt-file append-system-prompt append-system-prompt-file settings setting-sources agent agents worktree teleport from-pr remote-control remote-control-session-name-prefix background bg cloud environment bare json-schema include-partial-messages replay-user-messages restricted safe-mode system-prompt-snapshot tmux include-hook-events forward-subagent-text prompt-suggestions",
    short: "prcwv",
  },
  codex: {
    long: "json experimental-json output-schema output-last-message color sandbox ask-for-approval full-auto approve-for-me not-so-yolo yolo dangerously-bypass-approvals-and-sandbox dangerously-bypass-hook-trust cd add-dir skip-git-repo-check ephemeral last all session resume fork profile remote remote-auth-token-env thread-source ignore-user-config ignore-rules",
    short: "soaCp",
  },
  kiro: {
    long: "no-interactive resume resume-id resume-picker agent trust-all-tools trust-tools list-sessions delete-session session-source format agent-engine v3 mode cwd tui legacy-ui classic list-models verbose",
    short: "raldfv",
  },
  pi: {
    long: "print mode continue resume session session-id session-dir no-session fork name cwd system-prompt append-system-prompt export list-models",
    short: "pcrn",
  },
  dsh: {
    long: "profile patch dump-config dump-default-config resume session session-id cwd rpc mode prompt",
    short: "",
  },
  opencode: {
    long: "continue session fork prompt agent port hostname mdns mdns-domain cors",
    short: "cs",
  },
  openclaw: {
    long: "session session-key session-id message agent local json gateway port profile dev to",
    short: "mt",
  },
};

// Arity is separate from protection and singleton precedence. This is NOT a
// generic third-party parser: unknown flags pass through, but we never guess
// whether their next token is a value. Sources/limitations: docs/DAEMON.md.
// Each entry is zero, one required value, optional value, or variadic values.
const ARITIES = {
  "claude-code": {
    zero: "print continue verbose fork-session no-session-persistence strict-mcp-config dangerously-skip-permissions allow-dangerously-skip-permissions bg background bare brief chrome no-chrome disable-slash-commands ide ax-screen-reader exclude-dynamic-system-prompt-sections include-hook-events include-partial-messages forward-subagent-text replay-user-messages restricted safe-mode",
    one: "model effort autocompact debug-file fallback-model max-budget-usd plugin-dir plugin-url name agent agents append-system-prompt append-system-prompt-file system-prompt system-prompt-file input-format output-format json-schema permission-mode permission-prompts permission-prompt-tool session-id settings setting-sources environment remote-control-session-name-prefix system-prompt-snapshot",
    optional: "debug resume worktree cloud from-pr remote-control teleport prompt-suggestions tmux",
    many: "add-dir allowedTools allowed-tools disallowedTools disallowed-tools tools mcp-config betas file",
    aliases: { "-p": "--print", "-c": "--continue", "-d": "--debug", "-n": "--name", "-r": "--resume", "-w": "--worktree" },
  },
  codex: {
    zero: "strict-config oss search no-alt-screen json experimental-json full-auto approve-for-me not-so-yolo yolo dangerously-bypass-approvals-and-sandbox dangerously-bypass-hook-trust skip-git-repo-check ephemeral last all ignore-user-config ignore-rules",
    one: "model config enable disable image local-provider profile sandbox ask-for-approval cd add-dir remote remote-auth-token-env thread-source output-schema output-last-message color",
    aliases: { "-m": "--model", "-c": "--config", "-i": "--image", "-p": "--profile", "-s": "--sandbox", "-a": "--ask-for-approval", "-C": "--cd", "-o": "--output-last-message" },
  },
  kiro: {
    zero: "resume resume-picker trust-all-tools no-interactive list-sessions list-models require-mcp-startup verbose tui legacy-ui classic v3",
    one: "model effort resume-id agent trust-tools format delete-session session-source wrap agent-engine mode",
    aliases: { "-r": "--resume", "-a": "--trust-all-tools", "-l": "--list-sessions", "-f": "--format", "-d": "--delete-session", "-w": "--wrap", "-v": "--verbose" },
  },
  pi: {
    zero: "continue resume no-session no-tools no-builtin-tools no-extensions no-skills no-prompt-templates no-themes no-context-files verbose approve no-approve offline",
    one: "provider model api-key system-prompt append-system-prompt mode session session-id fork session-dir name models tools exclude-tools thinking extension skill prompt-template theme use-theme export tui-mode",
    optional: "print list-models",
    aliases: { "-p": "--print", "-c": "--continue", "-r": "--resume", "-n": "--name", "-nt": "--no-tools", "-nbt": "--no-builtin-tools", "-t": "--tools", "-xt": "--exclude-tools", "-e": "--extension", "-ne": "--no-extensions", "-ns": "--no-skills", "-np": "--no-prompt-templates", "-nc": "--no-context-files", "-a": "--approve", "-na": "--no-approve" },
  },
  dsh: { zero: "dump-config dump-default-config", one: "profile patch" },
  opencode: {
    zero: "print-logs pure continue fork mdns",
    one: "log-level model session prompt agent port hostname mdns-domain",
    many: "cors",
    aliases: { "-m": "--model", "-c": "--continue", "-s": "--session" },
  },
  openclaw: {
    zero: "local json deliver dry-run best-effort-deliver dev no-color",
    one: "model thinking message to session-id agent channel reply-to reply-channel reply-account timeout verbose profile log-level",
    aliases: { "-m": "--message", "-t": "--to" },
  },
};
const OPTION_ARITIES = Object.fromEntries(Object.entries(ARITIES).map(([type, spec]) => {
  const flags = { "--help": "zero", "--version": "zero" };
  for (const arity of ["zero", "one", "optional", "many"])
    for (const name of (spec[arity] ?? "").split(" ").filter(Boolean)) flags[`--${name}`] = arity;
  return [type, { flags, aliases: { "-h": "--help", "-V": "--version", "-v": "--version", ...spec.aliases } }];
}));

function optionAt(type, args, i) {
  const spec = OPTION_ARITIES[type];
  const token = args[i];
  let flag = token.split("=", 1)[0];
  let attached = token.includes("=");
  // Pi has exact multi-character aliases (-nt, -xt, ...), not short clusters.
  if (type !== "pi" && /^-[^-].+/.test(token) && !spec?.aliases[flag]) {
    const short = token.slice(0, 2);
    if (spec?.flags[spec.aliases[short]] === "one" || spec?.flags[spec.aliases[short]] === "optional") {
      flag = short;
      attached = true;
    }
  }
  flag = spec?.aliases[flag] ?? flag;
  const arity = spec?.flags[flag];
  if (!arity) return null;
  let size = 1;
  const next = args[i + 1];
  // Clap/yargs keep -- as a boundary; Pi and Commander consume it literally
  // as a required value. Persistent configuration rejects sentinels either way.
  const literalSentinel = ["pi", "claude-code", "dsh", "openclaw"].includes(type);
  const piNonOptionValue = type === "pi" && ["--use-theme", "--tui-mode"].includes(flag);
  const hasNext = next !== undefined && (next !== "--" || literalSentinel) &&
    !(piNonOptionValue && next.startsWith("-"));
  if (!attached && hasNext) {
    if (arity === "one" || arity === "many") size++;
    else if (arity === "optional" && !next.startsWith("-")) size++;
  }
  if (arity === "many") {
    while (i + size < args.length && !args[i + size].startsWith("-")) size++;
  }
  return { flag, arity, size, missing: !attached && ["one", "many"].includes(arity) && size === 1 };
}

function invalid(label, field, reason) {
  // Never include the token, env name, or value: even malformed keys can be secrets.
  throw new Error(`Agent ${label}: ${field} ${reason}.`);
}

export function rejectSharedCliConfig(file) {
  if (Array.isArray(file?.agents) && file.agents.length &&
      (Object.hasOwn(file, "args") || Object.hasOwn(file, "env"))) {
    throw new Error("daemon.json: top-level args/env cannot be shared with agents[]; move them into each agent entry.");
  }
}

// Codex -c is repeatable by TOML key, not a singleton flag. Parse only a simple
// dotted/quoted key; reject ambiguous keys in persistent config rather than risk
// allowing quoted protected controls to bypass the guard.
function codexConfigAt(args, i) {
  const tok = args[i];
  let value;
  let size = 1;
  if (tok === "-c" || tok === "--config") { value = args[i + 1]; size = value === "--" || value === undefined ? 1 : 2; }
  else if (tok.startsWith("--config=")) value = tok.slice(9);
  else if (tok.startsWith("-c") && !tok.startsWith("--")) value = tok.slice(2).replace(/^=/, "");
  else return null;
  const raw = typeof value === "string" ? value.split("=", 1)[0].trim() : "";
  const key = raw.replace(/["']/g, "").replace(/\s*\.\s*/g, ".");
  return { key, size, valid: typeof value === "string" && value.includes("=") && /^[A-Za-z_][A-Za-z0-9_.]*$/.test(key) };
}

export function validateAgentCliConfig(config = {}, type, label = "agent") {
  const args = config.args === undefined ? [] : config.args;
  const env = config.env === undefined ? {} : config.env;
  if (!Array.isArray(args)) invalid(label, "args", "must be an array of strings");
  for (let i = 0; i < args.length; i++) {
    if (typeof args[i] !== "string" || args[i].includes("\0"))
      invalid(label, `args[${i}]`, "must be a string without NUL");
  }
  if (!env || typeof env !== "object" || Array.isArray(env) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(env)))
    invalid(label, "env", "must be a string-to-string object");
  for (const [i, [key, value]] of Object.entries(env).entries()) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) invalid(label, `env entry[${i}]`, "has an invalid variable name");
    if (/^CHORUS_/i.test(key)) invalid(label, `env entry[${i}]`, "cannot override managed CHORUS_* variables");
    if (/^(CLAUDECODE|CLAUDE_CODE_ENTRYPOINT)$/i.test(key))
      invalid(label, `env entry[${i}]`, "cannot override managed nested-Claude context variables");
    if (typeof value !== "string" || value.includes("\0")) invalid(label, `env entry[${i}]`, "must have a string value without NUL");
  }
  const backend = canonicalType(type);
  const controls = PROTECTED[backend];
  const longs = new Set([...(controls?.long.split(" ") ?? []), "help", "version"]);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--" || args[i] === "-") invalid(label, `args[${i}]`, "cannot contain an argument terminator or stdin prompt marker");
  }
  for (let i = 0; i < args.length; i++) {
    const tok = args[i];
    const option = optionAt(backend, args, i);
    if (controls && !tok.startsWith("-"))
      invalid(label, `args[${i}]`, "cannot supply a positional prompt or ambiguous value; unknown options require inline --option=value syntax (if supported by the CLI)");
    if ((longs.has((option?.flag ?? tok.split("=", 1)[0]).replace(/^--/, ""))) ||
        (!option && /^-[^-]/.test(tok) && `${controls?.short ?? ""}hVv`.includes(tok[1])))
      invalid(label, `args[${i}]`, "conflicts with managed backend controls; use the dedicated Chorus settings or explicit foreground passthrough");
    if (backend === "codex") {
      const c = codexConfigAt(args, i);
      if (c) {
        if (!c.valid || /^(mcp_servers|sandbox[^.]*|approval_policy|approvals_reviewer|cwd|permissions|developer_instructions|model_instructions_file|experimental_instructions_file|base_instructions)(\.|$)/.test(c.key))
          invalid(label, `args[${i}]`, "has an invalid or managed Codex config key");
      }
    }
    if (option?.missing) invalid(label, `args[${i}]`, "requires a value before managed launch arguments");
    i += (option?.size ?? 1) - 1;
  }
  return { args: [...args], env: { ...env } };
}

// Windows child environments are case-insensitive, unlike an ordinary JS object
// (including injected test envs). Match Node's sorted-key selection if an inherited
// object contains duplicates; overlayAgentEnv removes collisions for overrides.
export function getAgentEnv(env, name, platform = process.platform) {
  if (platform !== "win32") return env[name];
  const key = Object.keys(env).sort().find((key) => key.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

export function overlayAgentEnv(base, overrides = {}, platform = process.platform) {
  const result = { ...base };
  if (platform === "win32") {
    for (const key of Object.keys(result)) {
      if (/^CHORUS_/i.test(key) && key !== key.toUpperCase()) {
        result[key.toUpperCase()] = result[key];
        delete result[key];
      }
    }
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (platform === "win32") {
      for (const old of Object.keys(result)) if (old.toLowerCase() === key.toLowerCase()) delete result[old];
    }
    // Canonical PATH spelling also makes the existing binary resolvers consistent.
    const name = platform === "win32" && key.toUpperCase() === "PATH" ? "PATH" : key;
    Object.defineProperty(result, name, { value, enumerable: true, writable: true, configurable: true });
  }
  return result;
}

// Deliberately small registry. See docs/DAEMON.md for verified CLI sources/forms.
const SINGLETONS = {
  "claude-code": { "--model": "model", "--effort": "effort" },
  codex: { "--model": "model", "-m": "model" },
  kiro: { "--model": "model", "--effort": "effort" },
  pi: { "--model": "model", "--thinking": "thinking", "--provider": "provider" },
  opencode: { "--model": "model", "-m": "model" },
  openclaw: { "--model": "model", "--thinking": "thinking" },
};
function singletonAt(type, args, i) {
  if (type === "codex") {
    const c = codexConfigAt(args, i);
    if (c?.valid && ["model", "model_reasoning_effort"].includes(c.key)) return { key: c.key, size: c.size };
  }
  for (const [flag, key] of Object.entries(SINGLETONS[type] ?? {})) {
    if (args[i] === flag) return { key, size: args[i + 1] === undefined || args[i + 1] === "--" ? 1 : 2 };
    if (args[i].startsWith(`${flag}=`) || flag.length === 2 && args[i].startsWith(flag)) return { key, size: 1 };
  }
  return null;
}
// Only these command paths have a supported insertion scope. Walk known option
// arities, never token-search: a value named "exec"/"resume" is not a command.
const SUBCOMMANDS = {
  codex: { exec: { resume: {} }, resume: {} },
  kiro: { chat: {} },
  openclaw: { agent: {} },
};
function foregroundScope(type, explicit) {
  let commands = SUBCOMMANDS[type];
  let start = 0;
  if (!commands) return start;
  for (let i = 0; i < explicit.length;) {
    const token = explicit[i];
    if (Object.hasOwn(commands, token)) {
      start = ++i;
      commands = commands[token];
      if (!Object.keys(commands).length) break;
      continue;
    }
    const option = optionAt(type, explicit, i);
    if (option) {
      if (option.missing) break;
      i += option.size;
    } else if (token.startsWith("--") && token.includes("=")) {
      i++; // self-contained unknown option; no arity guess
    } else break; // positional prompt/unknown command/ambiguous option
  }
  return start;
}

export function planAgentArgs(type, configured, explicit = []) {
  type = canonicalType(type);
  // Chorus analysis ALWAYS ends at the first bare --, even for backends that
  // might consume it as an option value. Forward the original tokens unchanged.
  const terminator = explicit.indexOf("--");
  const scan = explicit.slice(0, terminator < 0 ? explicit.length : terminator);
  const start = foregroundScope(type, scan);
  const supplied = new Set();
  for (let i = 0; i < scan.length; i++) {
    const boundary = optionAt(type, scan, i);
    // Unknown separated options may consume ANY following token. Do not infer
    // overrides beyond this point; still forward the entire explicit argv.
    if (!boundary && scan[i].startsWith("-") &&
        !(scan[i].startsWith("--") && scan[i].includes("="))) break;
    const option = singletonAt(type, scan, i);
    // Local root/parent options do not override options of the selected child
    // command. Codex --config/-c is global and applies across command scopes.
    const globalConfig = type === "codex" && boundary?.flag === "--config";
    if (option && (i >= start || globalConfig)) supplied.add(option.key);
    i += (boundary?.size ?? 1) - 1;
  }
  const kept = [];
  for (let i = 0; i < configured.length; i++) {
    const boundary = optionAt(type, configured, i);
    const option = singletonAt(type, configured, i);
    const size = boundary?.size ?? 1;
    if (!option || !supplied.has(option.key)) kept.push(...configured.slice(i, i + size));
    i += size - 1;
  }
  return {
    args: [...explicit.slice(0, start), ...kept, ...explicit.slice(start)],
    configuredArgs: kept,
  };
}

export function mergeAgentArgs(type, configured, explicit = []) {
  return planAgentArgs(type, configured, explicit).args;
}

// cmd.exe parses even with shell:false. Until a fully tested cmd encoder exists,
// only simple configured tokens are supported with .cmd/.bat shims. Native exe
// and POSIX paths retain ALL literal tokens. Explicit foreground argv is unchanged.
export function assertConfiguredShimArgs(binPath, args, platform = process.platform, label = "agent") {
  if (platform !== "win32" || !/\.(cmd|bat)$/i.test(binPath)) return;
  if (/["%!^&|<>()\r\n]/.test(binPath))
    invalid(label, "executable path", "cannot be passed literally through a Windows command shim; use a native executable");
  for (let i = 0; i < args.length; i++) {
    if (!args[i] || /[\s"'%!^&|<>()]/.test(args[i]))
      invalid(label, `args[${i}]`, "cannot be passed literally through a Windows command shim; use a native executable");
  }
}
