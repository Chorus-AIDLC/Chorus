# Chorus Daemon (`chorus daemon`)

The Chorus daemon is a local, long-lived client. It connects to a remote Chorus
server, subscribes to the agent notification stream, and wakes a local headless
Claude Code on task dispatch — so an assigned agent can act on work even when no
one is at a terminal.

```bash
npx @chorus-aidlc/chorus daemon          # foreground
npx @chorus-aidlc/chorus daemon -d       # background (detached)
npx @chorus-aidlc/chorus daemon install  # install as a boot service (Linux) — recommended
```

See `chorus daemon --help` and `chorus login --help` for the full flag list.

---

## Launch an agent interactively (`chorus agents run`)

The daemon wakes an agent **headlessly** on dispatch. When you instead want to
start a configured agent **yourself, in your terminal**, use `chorus agents run` —
the foreground counterpart. It saves you from hand-exporting the connection
variables before every launch: a child process cannot write to your shell anyway,
so `run` injects the environment into the launched agent process directly.

```bash
chorus agents run --name work -- --model opus        # launch agent "work"; pass --model opus to it
chorus agents run                                    # launch the only configured agent
chorus agents run --name work --type codex -- resume # override the backend, then pass `resume` through
```

- **Which agent.** `--name <name|uuid>` selects from `~/.chorus/daemon.json`
  `agents[]`. With one configured agent it is optional; with several, pass
  `--name` (or set `CHORUS_AGENT_PROFILE`) or you get an error — it never guesses.
- **What gets injected** (into the launched process only — never your shell, never
  printed): `CHORUS_URL`, `CHORUS_API_KEY`, and `CHORUS_AGENT_PROFILE`. The
  harness's own credentials were already written to its config by
  `chorus agents add`, so they are not re-handled here.
- **Which binary.** The backend defaults to the agent's stored `agentType`;
  `--type <type>` overrides it. Types map to binaries: `claude-code`/`claude` →
  `claude`, `codex` → `codex`, `kiro` → `kiro-cli`, `pi` → `pi`, `opencode` →
  `opencode`, `openclaw` → `openclaw`, `dsh` → `dsh`. Agents stored as
  `offline` have no concrete backend, so pass `--type` explicitly for them.
- **Passthrough.** Everything after the first `--` is handed to the agent
  **verbatim**. Recognized explicit options suppress equivalent persistent options
  (see below); the explicit tokens themselves are never rewritten or rejected by
  the persistent-config validator. Interactive resume/subcommands remain available.
  The agent inherits your terminal, and `chorus agents run` exits with its exit code.

See `chorus agents run --help`.

### Per-agent CLI arguments and environment

Each `agents[]` entry in `~/.chorus/daemon.json` may specify **`args: string[]`**
and **`env: Record<string, string>`**. Both daemon wakes and foreground launches
use these fields. For example (replace the illustrative credentials):

```json
{
  "url": "https://chorus.example.com",
  "agents": [
    {
      "agentName": "reviewer",
      "apiKey": "cho_replace_me",
      "agentType": "claude-code",
      "args": ["--model", "sonnet", "--effort", "high"],
      "env": { "ANTHROPIC_BASE_URL": "https://provider.example.com" }
    },
    {
      "agentName": "implementer",
      "apiKey": "cho_replace_me_too",
      "agentType": "codex",
      "args": ["--model", "gpt-5.4", "-c", "model_reasoning_effort=high"],
      "env": { "CODEX_HOME": "/home/me/.codex-work" }
    },
    {
      "agentName": "pi-worker",
      "apiKey": "cho_replace_me_three",
      "agentType": "pi",
      "args": ["--model", "anthropic/claude-sonnet-4-6", "--thinking", "high"],
      "env": { "PI_CODING_AGENT_DIR": "/home/me/.pi-work" }
    }
  ]
}
```

Model IDs above are examples, not Chorus defaults; use IDs your provider supports.
Configure the Chorus integration in any custom harness home too. Codex's MCP
preflight reads the effective `CODEX_HOME`. dsh uses the effective environment for
managed-home/provider setup and its RPC initialize request: `DSH_PROVIDER` and
`DSH_MODEL` select those values, and `DSH_HOME` can select an existing SDK profile
(the inherited `CHORUS_DSH_*` administrator overrides still take precedence).
Using an existing home skips managed preparation and emits an informational notice
without printing the home value.
There are no separate `model` or `thinking` fields in daemon.json.

- Omitted fields mean `[]` and `{}`. Explicit `null`, non-string tokens/values,
  NUL characters, and non-portable env names are errors. Env names must match
  `[A-Za-z_][A-Za-z0-9_]*`. Empty string option values and env values are valid.
- **No shared defaults:** top-level `args`/`env` alongside nonempty `agents[]`
  are rejected with a migration hint, not inherited or silently ignored. Put
  them on each intended entry. One profile never mutates another or `process.env`.
- Values are literal: each array element is one argv token. Do not add shell
  quoting around tokens. Spaces, `$HOME`, `${TOKEN}`, `$(command)`, semicolons,
  and other shell syntax are not expanded. No dotenv loading, interpolation,
  or secret-manager lookup is added. Use option/value pairs, not positional
  prompts/subcommands; explicit foreground passthrough is available for those.
- Env overlays a fresh inherited environment; backend-managed identity, cwd and
  headless controls are then applied. On Windows, env overrides replace inherited
  names case-insensitively (`Path`/`PATH` cannot compete). Harness-home and
  provider/model lookups, transcript/MCP preflight, managed dsh preparation, and
  `COMSPEC` selection use that same Windows case-insensitive environment: e.g.
  `dsh_home` and `DSH_HOME` select the same existing profile and skip preparation.
  Managed dsh home/cwd writes remove differently-cased duplicates. POSIX names
  remain case-sensitive. Executable discovery
  uses the effective per-agent PATH. Foreground clears `CHORUS_DAEMON_HEADLESS`;
  Claude launches also clear nested-session markers `CLAUDECODE` and
  `CLAUDE_CODE_ENTRYPOINT`.
- Native executables and POSIX launches preserve literal configured argv. Windows
  `.cmd`/`.bat` shims run through `cmd.exe` even with `shell:false`: configured
  empty tokens or tokens containing whitespace, quotes, `%`, `!`, `^`, `&`, `|`,
  `<`, `>`, or parentheses are **rejected before spawn**, as are executable paths
  containing command metacharacters. Use a native executable for such tokens.
  Existing explicit foreground passthrough is unchanged and is
  not promised shell-safe through a Windows command shim.
- Env values can contain plaintext provider credentials. Chorus does not print
  configured values in its validation/launch diagnostics, but child programs and
  OS process inspection may expose them. Protect daemon.json with local file
  permissions (e.g. `chmod 600` on POSIX); do not commit secrets. There is no
  special encryption or vault support.
- Spawn failures report only allowlisted OS error classifications (such as
  `ENOENT`, `EACCES`, or `EPERM`) and fixed troubleshooting guidance; unknown
  error codes use a generic startup hint. Raw error messages, paths, argv, and
  syscall fields are not echoed. Managed dsh setup failures retain sanitized
  causes and provider/profile hints, redacting environment and configured argv
  values as well as credentials; matching diagnostic text may also be redacted.

**Protected persistent controls.** All `CHORUS_*` env names and the nested-Claude
context names `CLAUDECODE` / `CLAUDE_CODE_ENTRYPOINT` are reserved,
case-insensitively. Configuring them fails validation instead of silently dropping
them; inherited Claude context is still cleared when launching Claude.
Known backend session/resume, prompt, transport/output,
cwd, managed MCP, and permission flags are rejected, including long `--flag=value`
forms and known short aliases/attached forms. Examples:

| Backend | Protected controls (scope/examples) |
|---|---|
| Claude | `-p/--print`, output/input format, session/resume/continue (`-r`, `-c`), MCP config, permissions/allowed tools, settings, system prompt, worktree (`-w`), remote/background modes |
| Codex | JSON/output (`-o`, `--experimental-json`), sandbox (`-s`, `--yolo`), approvals (`-a`, `--not-so-yolo`), cwd (`-C`), profile (`-p`), remote/session controls; `-c`/`--config` keys rooted at `mcp_servers`, `sandbox*`, `approval_policy`, `approvals_reviewer`, `cwd`, `permissions`, `developer_instructions`, `model_instructions_file`, `experimental_instructions_file`, `base_instructions` |
| Kiro | non-interactive/engine/UI mode, agent, trust (`-a`), resume (`-r`), session operations/output (`-l`, `-d`, `-f`) |
| Pi | `-p/--print`, mode, session/resume/continue (`-r`, `-c`), session directory, system prompt, export, model inspection (`--list-models`, with or without a search filter) |
| dsh | SDK profile, patch overlays, config dumps, session/cwd/protocol/prompt controls |
| OpenCode/OpenClaw | Known foreground session, prompt/message, agent and connection controls |

Bare `--` and the stdin prompt marker `-` are forbidden in persistent args, as
are help/version and known inspection exits that bypass the wake prompt (including
Pi `--list-models`; equals forms are also guarded). Explicit foreground inspection
remains allowed. Codex config keys may use simple dotted/quoted TOML keys;
ambiguous keys are rejected rather than bypassing protection.

**Option/value boundaries.** Known backend options have separate arity metadata
in `cli/agent-cli-config.mjs`: zero-value flags (for example Pi `--verbose`,
`--offline`, `-nt`/`-nbt`, Codex `--oss`, Claude `--brief`, Kiro
`--require-mcp-startup`, OpenCode `--print-logs`, OpenClaw `--deliver`) cannot
consume a following positional prompt. Known valued options consume their values
as data, even when those values look like flags; e.g. Pi `--api-key --session`
does not set a session. A missing required value is rejected before managed argv
can be swallowed. The registry also covers exact Pi multi-character aliases,
ordinary valued options such as extension/skill/theme paths, Codex feature/image
options, Kiro `-w/--wrap`, Claude optional `-d/--debug [filter]` and variadic
`--betas`/`--file`. It is arity metadata, not a backend value/schema validator.

Unknown ordinary options remain pass-through, **not an allowlist**. However, their
arity is unknowable: persistent `['--future', 'text']` fails closed because `text`
could be a positional prompt after an unknown boolean. Use `['--future=text']`
**only if the backend supports that spelling**, or use explicit foreground
passthrough for its full native syntax. Unknown standalone flags and inline values
are retained; no unknown separated value is silently presumed safe. Backend/plugin
flag additions may require updating the arity registry for persistent separated
values. This guards known conflicts, **not a sandbox** against someone who controls
the executable, plugins, or harness config. The third-party CLI remains responsible
for validating flags, value syntax, and CLI-version compatibility.
Offline agents remain non-wakeable, regardless of customization.

**Foreground precedence registry.** `--type` first selects the effective backend
for both validation and precedence. For the following options, an explicit
occurrence in the selected command scope suppresses every configured equivalent
and its value. Local root/parent options do not suppress child-command options;
Codex `-c`/`--config` keys apply across scopes:

| Effective type | Recognized singleton options |
|---|---|
| `claude-code` / `claude` | `--model`, `--effort` |
| `codex` | `--model` / `-m` / config key `model`; config key `model_reasoning_effort` |
| `kiro` | `--model`, `--effort` |
| `pi` | `--model`, `--thinking`, `--provider` |
| `opencode` | `--model` / `-m` |
| `openclaw` | `--model`, `--thinking` (agent subcommand options) |
| `dsh` | None: the SDK launcher has no model/reasoning argv singleton; use env |

The matcher recognizes separated and equals long forms, and attached short model
forms (`-mVALUE`, `-m=VALUE`) where `-m` is listed. Codex config supports
`-c key=value`, `-ckey=value`, `-c=key=value`, `--config key=value`, and
`--config=key=value`. Only the two registered Codex keys participate in precedence;
unrelated `-c` entries are retained. Unknown/repeatable options retain
configured-then-explicit order within the selected command scope, with no generic
last-wins guarantee. Both configured and explicit scans skip known option values:
`--append-system-prompt --model` on Pi is prompt data, not a model override.
Chorus analysis stops at the **first bare `--` anywhere in the explicit agent
argv**, even if Pi or a Commander-based backend would consume it as a required
option value. (The outer `chorus agents run --` delimiter is already removed.)
Persistent sentinels remain forbidden even in value position. After an unknown option without an inline
value (including an unknown short form/cluster), the scan stops inferring
precedence: its arity could make any subsequent token a value. Thus a later
explicit model may coexist with the configured model, with native CLI semantics,
rather than risk silently deleting configuration based on a value. Put known
overrides before that ambiguous option, or use a supported inline unknown value.
**All explicit tokens are forwarded unchanged**, including unknown options,
subcommands, prompts and native separated-value syntax; this parser never rejects
or rewrites the full explicit CLI surface.

**Foreground subcommand scope.** Configured args are inserted after the deepest
recognized command in these paths, before its explicit options/positionals:

| Effective type | Recognized command paths |
|---|---|
| `codex` | `exec`, `exec resume`, `resume` |
| `kiro` | `chat` |
| `openclaw` | `agent` |

Known root/parent options can precede these commands. For example, configured
`--model chosen` plus explicit `--cd /work exec prompt` becomes
`--cd /work exec --model chosen prompt`. Explicit `--model root exec prompt`
retains the root model but still inserts the configured model after `exec`;
to override the configured exec model, use `exec --model explicit prompt`.
Command discovery skips known value spans, so `--enable exec` (Codex) or
`--profile agent` (OpenClaw) does not falsely select a command. It stops at the
first bare `--`, positional prompt/unknown command, or ambiguous option. A
command name later in prompt data is never searched for.

Without a recognized command, configured args retain prefix insertion. Unknown
command grammars and other nested command paths are **not inferred**; Chorus
cannot guarantee that persistent options work in those scopes. Use native
explicit passthrough and omit incompatible persistent args for such commands.
Unknown ordinary standalone flags and inline extension values are still allowed;
this is not a blanket flag allowlist. Windows shim safety checks inspect only
the actual retained configured tokens, regardless of where they were inserted.

This registry recognizes spelling, not CLI-version compatibility. Checked against
local help: Claude Code **2.1.267**, Codex **0.153.4** (including `exec resume`),
Kiro **2.12.1**, Pi **0.85.1**, dsh **0.1.2-rc.1**, and OpenCode `--help`.
Pi 0.85.1's `dist/cli/args.js` accepts **separated** `--model`/`--thinking`/
`--provider` forms; use those, not equals syntax, with that version. Its
`dist/main.js` exits on `--list-models` before reading the wake prompt, even with
`-p`, so persistent model-inspection flags are protected. Codex's
`codex-rs/core/src/config/mod.rs` confirms `model_reasoning_effort`, and
`codex-rs/utils/cli/src/shared_options.rs` / `exec/src/cli.rs` confirm the hidden
`--yolo`, `--not-so-yolo`, and `--experimental-json` aliases. OpenClaw's
`src/cli/program/register.agent.ts` confirms `--model` and `--thinking` (its `-m`
is **message**, not model). Chorus never translates an unsupported CLI spelling.

```bash
# Persistent model/effort are removed; explicit values are passed unchanged:
chorus agents run --name reviewer -- --model opus --effort medium
# Explicit session controls are allowed even though persistent ones are not:
chorus agents run --name reviewer -- --resume SESSION_ID
```

**Legacy flat config and restart behavior.** With no nonempty `agents[]`, the
legacy daemon path accepts top-level `args`/`env` for its sole agent. Foreground
selection still requires `agents[]`. Adding another agent via `chorus agents add`
or `chorus login --add` automatically folds the original flat credential profile
into `agents[0]`, moving args/env and removing their top-level keys in the same
atomic write. Malformed values move too, so subsequent validation identifies the
original entry rather than losing settings. Already-shared top-level args/env
is rejected without changing the file; only an actual flat fold removes keys.
A partial flat file without its credential key cannot be folded and must be
completed or converted manually before adding a profile. Flat daemon run validates
customization before credential/network preflight (including detach).

To convert a flat profile manually, move its URL, key, identity, `args`, and `env`
into an entry and rename flat `agent` to `agentType`:

```json
{
  "agents": [{
    "agentName": "work", "agentType": "pi",
    "url": "https://chorus.example.com", "apiKey": "cho_replace_me",
    "args": ["--thinking", "high"], "env": { "PROVIDER_REGION": "us-east-1" }
  }]
}
```

The daemon snapshots customization at startup, including spawners used by newly
created runtime-cwd contexts. Editing daemon.json does not hot-reload existing
children or future wakes in that daemon: **restart the daemon** to apply changes.
Every new `chorus agents run` invocation rereads the selected profile; an already
running foreground child is unaffected. Removing the fields restores defaults.

---

## Credentials

The daemon resolves the server URL + `cho_` API key in this precedence (first
complete pair wins):

1. `--url` / `--api-key` flags
2. `CHORUS_URL` / `CHORUS_API_KEY` environment variables
3. `~/.chorus/daemon.json` (written by `chorus login`)
4. Claude Code plugin config (`~/.claude/settings.json` → `env`)

**Interactive completion (TTY only).** If no source yields credentials **and**
stdin is a terminal, `chorus daemon` no longer hard-fails — it prompts for the
URL and a masked API key, validates them against the server, saves them to
`~/.chorus/daemon.json` (mode `0600`), and continues starting up. You do not need
a separate `chorus login` run.

**Writes are field-level merges.** Both `chorus login` and the interactive
completion above **merge** into `~/.chorus/daemon.json` rather than overwriting
it — they touch only `url` / `apiKey` / `agentUuid` / `agentName` and leave every
other field (`cwds`, `yoloAckAt`, `sigintTimeoutMs`, …) intact. You can safely
re-run `chorus login` to rotate credentials without losing your served paths or
your YOLO acknowledgement.

**Non-interactive (systemd / nohup / CI).** When stdin is **not** a TTY and no
credentials resolve, the daemon prints the actionable multi-source error and
exits non-zero — it never blocks waiting on a prompt no one can answer. Provide
credentials via env or `chorus login` (on a terminal) first.

---

## Permission mode (default: YOLO)

The woken agent's permission posture determines what it may do:

| Mode | What the woken agent may do | How to select |
|------|------------------------------|----------------|
| **`yolo`** (default) | Full autonomy — Bash, file writes, any command, under the daemon's API key (`--dangerously-skip-permissions`) | default; `--yolo`; `CHORUS_YOLO=1` |
| `chorus-only` | Chorus MCP tools only (comment / claim / report / status) — no Bash, no file edits | `--chorus-only`; `CHORUS_CHORUS_ONLY=1` |

> ⚠ **YOLO is the default** because the daemon exists to do real code-writing
> AI-DLC work. A woken agent gets a full shell under your API key. Run the daemon
> only in a trusted / sandboxed environment.

**First-run confirmation (TTY).** The first time the daemon would start in YOLO
on a terminal, it asks for a one-time `y/N` confirmation and remembers your
answer as `yoloAckAt` in `~/.chorus/daemon.json`. Subsequent starts don't
re-prompt. Re-running `chorus login` **preserves** the acknowledgement (and your
`cwds`) — every write to `~/.chorus/daemon.json` is a field-level merge, so a
credential change no longer wipes unrelated fields.

**Unattended (non-TTY).** When YOLO starts on a non-terminal (systemd / nohup /
CI / the detached `-d` child), it runs directly and prints one prominent `⚠`
warning line — no confirmation is possible or required. To keep an unattended
daemon restricted, pass `--chorus-only` (or set `CHORUS_CHORUS_ONLY=1`).

---

## Startup banner & logging

On start the daemon prints a boxed banner summarizing: server URL, agent identity
(name + uuid), permission mode (YOLO highlighted), credential **source** (never
the raw key), connection state, `claude` install status / path, the chorus
version, and the active agent type. On a non-TTY stream the banner degrades to
plain `label: value` lines.

**`claude` detection.** The banner reports whether the `claude` executable was
found (and its path), reusing the same PATH resolution the wakes use (including
the Windows `claude.cmd` shim and the `CHORUS_CLAUDE_PATH` override). A missing
`claude` does **not** block startup — the daemon still subscribes, and a wake
surfaces the missing-binary error when one arrives.

**Per-wake logs.** Each wake emits one compact line per lifecycle event:

```
[Chorus] ▶ wake: task_assigned → task:<uuid>
[Chorus] spawning new session <idea-uuid> — take over with: claude --resume <idea-uuid>
[Chorus] ✓ wake done: task:<uuid> (exit=0, 1234ms)
```

The `claude --resume <idea-uuid>` hint lets you attach to the session from the
daemon's working directory. Pass `--verbose` (or `CHORUS_VERBOSE=1`) for extra
per-wake detail.

---

## Agent backend (`--agent`)

`--agent <type>` selects which local agent backend the daemon wakes. Three
backends are available: `claude-code` (the default), `codex`, and `kiro`. (A `dsh`
DeepSeek Harness backend exists in the codebase but is temporarily offline — not
offered; see [CONNECT_DSH.md](CONNECT_DSH.md).) An unknown value is a hard error
(no silent fallback).

The backend is resolved in this precedence (first defined source wins):

1. `--agent <type>` flag
2. `CHORUS_AGENT` environment variable
3. `~/.chorus/daemon.json` `agent` field
4. default `claude-code`

```bash
chorus daemon --agent claude-code   # explicit (same as default)
chorus daemon --agent codex         # wake a local Codex CLI
chorus daemon --agent kiro          # wake a local Kiro CLI
```

To make a backend the persistent default without re-passing the flag or
exporting the env var on every start, set it once in `~/.chorus/daemon.json`:

```json
{ "agent": "codex" }
```

The daemon `install` command writes the chosen backend to this same file (it
prompts interactively, or takes `--agent` / `CHORUS_AGENT` non-interactively), so
an installed boot service picks it up from `daemon.json` — the unit itself carries
no `--agent`.

---

## Multiple agents in one daemon (`agents[]`)

One `chorus daemon` process can serve **several fully-independent agents at once** —
different personas, permissions, accounts, or even different backends — instead of
running a separate daemon per agent. Add an `agents` array to `~/.chorus/daemon.json`:

```json
{
  "url": "https://chorus.example.com",
  "sigintTimeoutMs": 8000,
  "agents": [
    { "apiKey": "cho_alpha", "agentType": "claude-code", "cwds": ["/home/me/projA"] },
    { "apiKey": "cho_beta",  "agentType": "kiro",        "cwds": ["/home/me/projB"], "permissionMode": "chorus" }
  ]
}
```

Each entry is one agent. Every **top-level** field is a **default**; a field set on an
agent **overrides** it for that agent only. Per-agent fields:

| Field | Meaning |
|-------|---------|
| `apiKey` | *(required)* the agent's `cho_` key — determines its identity |
| `url` | Chorus server (may differ per agent — different server/company) |
| `agentType` | `claude-code` \| `codex` \| `kiro` (backends may be mixed) |
| `cwds` | working directories this agent serves (one connection each) |
| `permissionMode` | `yolo` \| `chorus` |
| `maxConcurrency` | this agent's own wake-concurrency cap (default `4`) |
| `sigintTimeoutMs` | interrupt escalation window (ms) |
| `browseRoots` | directory-discovery allowlist |

Each agent gets its own identity (via its key), its own connections (one per its
`cwds`), its own wake queue, and its own spawner — so they run and are woken
independently, and one agent's failure never disrupts the others. On the server each
appears as its own connection/instance (keyed on agent + host + cwd). Agents may even
share the same cwd; the daemon does not serialize them, so avoid concurrent conflicting
work in one git tree (use separate branches / worktrees).

**Back-compat:** with **no** `agents[]`, the flat top-level `url` / `apiKey` / `cwds`
are treated as exactly one agent — existing single-agent installs run unchanged.

### Adding agents

- **`chorus login --add`** — validate a new key and append it as another agent
  (masked entry). The first `--add` on a flat file migrates the existing credentials
  into `agents[0]` and adds the new one as `agents[1]`; a duplicate key is refused and
  an existing agent is never overwritten.
- **`chorus daemon install --add`** — the install wizard offers to add more agents in
  one run (TTY only).
- **Hand-editing** `~/.chorus/daemon.json` is always supported.

### Per-backend key delivery (important)

How each agent's Chorus key reaches its woken subprocess differs by backend:

- **Claude Code** — automatic per-agent: the daemon writes a per-wake `--mcp-config`
  carrying that agent's URL + key. Nothing to configure.
- **Kiro** — automatic per-agent via env: the installed `mcp.json` references
  `${CHORUS_URL}` / `${env:CHORUS_API_KEY}`, which the daemon exports per wake, so each
  Kiro agent authenticates with its own key.
- **Codex** — **user-managed.** Codex reads its Chorus MCP server (URL + key) from its
  own `~/.codex/config.toml` and does not read the key from the environment. A single
  Codex agent (or several sharing one key) works out of the box. To run **two Codex
  agents with different keys** in one daemon, give each its own config directory via a
  per-agent `CODEX_HOME` (the daemon does not auto-inject a per-agent Codex key).

---

## Background mode & lifecycle

Run the daemon detached in the background and manage it with lifecycle
subcommands. All of this is pure Node — no native dependencies, cross-platform.

```bash
chorus daemon -d          # start detached: pidfile + logfile, foreground returns
chorus daemon status      # is it running? (+ pid)
chorus daemon logs        # show ~/.chorus/daemon.log
chorus daemon restart     # stop (if running) then start a fresh detached instance
chorus daemon stop        # terminate the recorded daemon and remove the pidfile
chorus daemon stop --force  # force-clean the pidfile when a stuck/unverifiable
                            # pid blocks a normal stop (best-effort signal first)
```

- Background state lives in `~/.chorus/daemon.pid` and `~/.chorus/daemon.log`.
- `-d` refuses to start a second daemon when a live one is already recorded.
- The pidfile records the daemon's **identity** (start time + command line), so
  a pid recycled by the OS after a reboot — even one now owned by another user —
  is detected as stale and cleaned up automatically instead of blocking
  `stop`/`start`. If a stop still cannot signal the recorded pid, its error
  message points to `chorus daemon stop --force`.
- `stop` exits `0` whenever it leaves the system with no daemon and no pidfile
  (stopped, stale-cleared, or forced), so `chorus daemon stop && …` chains
  survive a self-heal.
- **First-run `-d` on a terminal** completes the credential prompts and the YOLO
  `y/N` confirmation in the **foreground** parent (which holds the TTY) and
  persists them *before* detaching — so the detached child never hits an
  interactive prompt.
- Every lifecycle subcommand reports clearly when no daemon is running (it never
  fails silently).
- **Under a supervisor (`chorus daemon install`)** these same subcommands
  delegate to the service manager instead of the pidfile: `status`/`stop`/
  `restart`/`logs` drive `systemctl`/`journalctl`. See "Auto-start on boot /
  login" below — that is the recommended way to run the daemon permanently.

---

## Auto-start on boot / login

### Recommended: `chorus daemon install` (Linux)

```bash
chorus daemon install --cwd ~/proj          # generate the systemd --user unit,
                                             # daemon-reload, enable --now
chorus daemon install --cwd ~/a --cwd ~/b    # serve several paths at boot
chorus daemon install --browse-root ~/work   # allow project directory browsing
chorus daemon uninstall                      # disable + remove the unit
```

`cwds` are registered as daemon instances at startup. `browseRoots` are a
separate allowlist for remote directory discovery and directed runtime
execution; they do not create startup connections. Repeat `--browse-root` for
multiple roots. Precedence is command line, `CHORUS_DAEMON_BROWSE_ROOTS`,
`daemon.json`, then the daemon user's home directory. File changes require
`chorus daemon restart`.

Project settings can fix one host and cwd independently for each Agent. A fixed
cwd stays authoritative for that user and project until replaced or cleared.
Without one, operation pickers can use a registered directory or browse an
allowed directory for that operation only. Temporary choices do not modify
`daemon.json`, register an instance, or persist a project preference.

`install` generates a correct `systemd --user` unit and starts it — you never
hand-write the file. It captures the `--chorus-only` flag you pass, plus absolute
`node` / `chorus.mjs` paths and your current `PATH`, and runs `systemctl --user
daemon-reload` then `enable --now`. The served working directories (`cwds`) and
the chosen agent backend (`agent`) are **persisted to `~/.chorus/daemon.json`**
rather than baked into the unit — the daemon reads them back at start, so a single
source of truth stays in one place. After install, the lifecycle subcommands
**delegate to systemd** automatically — `chorus daemon status` / `stop` /
`restart` / `logs` drive `systemctl` / `journalctl`, so a supervised daemon is
never misreported as "not running".

On a terminal, `install` prompts interactively for the agent backend (Claude Code
/ Codex / Kiro — Enter accepts the Claude Code default) unless you pass `--agent`
(or export `CHORUS_AGENT`, or already have one stored), then checks the selected
CLI is on `PATH` and warns if it is missing. Pass `-y` / `--yes` — or run on a
non-TTY — to skip the prompt and take the default.

> **Why a command instead of a hand-written unit?** The generated unit runs the
> daemon in the **foreground** (`Type=simple`, no `-d`) so systemd owns the
> process directly. Hand-writing a `Type=forking` unit around `chorus daemon -d`
> looks reasonable but breaks badly: `-d` self-daemonizes (it forks a detached
> child and writes a JSON pidfile systemd can't parse), so systemd never adopts
> the child as `MainPID`, marks the service failed, and `Restart=on-failure`
> retries every few seconds — each retry's `-d` preflight then finds the previous
> orphan alive via the pidfile and refuses, an infinite restart loop that also
> pins the server-side connection rows. Let `install` write the right unit.

> Pre-authorize YOLO before enabling auto-start: run `chorus daemon` once on a
> terminal and confirm the `y/N` prompt (persists `yoloAckAt`), **or** pass
> `--chorus-only` to `install` to keep the unattended daemon restricted.
> `install` also needs credentials the unit can see — run `chorus login` first
> so they land in `~/.chorus/daemon.json` (not just your shell env).

### Manual setup (macOS, or advanced Linux customization)

`chorus daemon install` is Linux-only; on macOS it prints the plist below for you
to install by hand, and on Windows it prints the foreground command to wrap in
Task Scheduler. Use these templates directly if you need to customize the unit.

> Replace `/usr/local/bin/chorus` with your actual install path (`which chorus`).

### macOS — launchd LaunchAgent

Save as `~/Library/LaunchAgents/dev.chorus.daemon.plist`, then
`launchctl load ~/Library/LaunchAgents/dev.chorus.daemon.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.chorus.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/chorus</string>
    <string>daemon</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/chorus-daemon.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/chorus-daemon.log</string>
</dict>
</plist>
```

Unload with `launchctl unload ~/Library/LaunchAgents/dev.chorus.daemon.plist`.

### Linux — systemd user service

Save as `~/.config/systemd/user/chorus-daemon.service`, then
`systemctl --user enable --now chorus-daemon`:

```ini
[Unit]
Description=Chorus daemon
After=network-online.target

[Service]
Type=simple
# PATH must include the dir holding `claude` (a unit does NOT inherit your shell PATH).
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/local/bin/chorus daemon
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

To keep the service running after you log out:
`loginctl enable-linger "$USER"`. Stop/disable with
`systemctl --user disable --now chorus-daemon`. Logs: `journalctl --user -u chorus-daemon`.

**Boot auto-start checklist (learned the hard way).** A systemd unit runs with a
minimal environment — it does **not** source `~/.zshrc` / `~/.bashrc`. Two things
bite operators who rely on their interactive shell setup:

1. **Persist credentials with `chorus login`, not shell env.** If your
   `CHORUS_URL` / `CHORUS_API_KEY` live only in `~/.zshrc`, the unit can't see
   them and the daemon crash-loops (`Restart=on-failure` will retry forever).
   Run `chorus login` once so the credentials land in `~/.chorus/daemon.json`,
   which the daemon reads directly. (Re-running `chorus login` later is safe —
   writes are field-level merges, so your `cwds` / `yoloAckAt` survive.)
2. **Put `claude` on the unit's PATH.** The unit's PATH usually omits
   `~/.local/bin`, where `claude` is commonly installed. Without it the daemon
   starts and subscribes but every wake fails to spawn `claude` — and it now
   prints a loud `⚠ claude CLI NOT FOUND` line at startup (visible in
   `journalctl --user -u chorus-daemon`). Set `Environment=PATH=...` as above
   (or `Environment=CHORUS_CLAUDE_PATH=/abs/path/to/claude`).

Alternatively, declare credentials and paths explicitly on the unit instead of
relying on the login file — e.g.
`Environment=CHORUS_URL=… CHORUS_API_KEY=cho_… CHORUS_DAEMON_CWDS=/path/a:/path/b`
and `ExecStart=/usr/local/bin/chorus daemon --chorus-only` for a restricted
unattended posture.

---

## Quick reference

| Need | Command / setting |
|------|-------------------|
| Start (foreground) | `chorus daemon` |
| Start (background) | `chorus daemon -d` |
| Install as a boot service (Linux) | `chorus daemon install [--cwd …]` |
| Remove the boot service | `chorus daemon uninstall` |
| Stop / status / logs / restart | `chorus daemon stop` / `status` / `logs` / `restart` (delegate to systemd when installed) |
| Restrict the woken agent | `--chorus-only` / `CHORUS_CHORUS_ONLY=1` |
| Force full autonomy | `--yolo` / `CHORUS_YOLO=1` (also the default) |
| Verbose per-wake logs | `--verbose` / `CHORUS_VERBOSE=1` |
| Choose agent backend | `--agent claude-code|codex|kiro` / `CHORUS_AGENT` |
| Point at a `claude` binary | `CHORUS_CLAUDE_PATH=/path/to/claude` |
| Save credentials | `chorus login` (or interactive on first `chorus daemon`) |
| Call MCP tools directly | `chorus mcp call|whoami|list` — see [MCP_CLIENT.md](./MCP_CLIENT.md) (reuses these same credentials + `--agent`) |
| Per-subcommand help | `chorus daemon --help`, `chorus login --help`, `chorus mcp --help` |
