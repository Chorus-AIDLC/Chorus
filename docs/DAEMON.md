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
  `opencode`, `openclaw` → `openclaw`, `dsh` → `dsh-jsonrpc-agent`. Agents added as
  opencode / openclaw / dsh are stored as `offline` (the daemon does not auto-wake
  them), so pass `--type` explicitly to launch those.
- **Passthrough.** Everything after `--` is handed to the agent **verbatim** and
  never inspected, so the agent's full flag surface is available. The launched
  agent inherits your terminal, and `chorus agents run` exits with its exit code.

See `chorus agents run --help`.

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
