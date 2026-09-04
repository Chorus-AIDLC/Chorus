# Design — `chorus agents run`

## Context

`chorus agents` (`cli/agents.mjs`) already dispatches `list` / `add` / `remove`.
Credentials live in `~/.chorus/daemon.json` under `agents[]`, each entry carrying
`agentUuid`, `agentName`, `url`, `apiKey`, and `agentType`. `cli/credentials.mjs`
`resolveMcpCredentials(flags, deps)` already resolves *which* agent to act as
(flag `--agent`/name → `CHORUS_AGENT_PROFILE` → single-agent default → hard error
on ambiguity) but returns only `{ url, apiKey, label }` — it discards `agentType`,
which the launcher needs to pick the binary.

The daemon spawners (`cli/claude-spawner.mjs`, `codex-spawner.mjs`, etc.) show
the injection contract to reuse: they build `childEnv = { ...process.env }` and
set `CHORUS_URL`, `CHORUS_API_KEY`, and `CHORUS_AGENT_PROFILE` (from
`agentUuid || agentName`). They spawn **headless** (`claude -p`, `codex exec`)
with piped stdio and `CHORUS_DAEMON_HEADLESS=1`. The launcher differs: it is
**interactive/foreground** — it inherits stdio, sets NO `CHORUS_DAEMON_HEADLESS`,
passes the user's args verbatim, and forwards the child exit code.

## Goals / Non-goals

- **Goal:** one command to launch any configured agent with creds injected and
  arbitrary agent args passed through untouched.
- **Non-goal (v1):** env-export / `eval` output; `--profile` sub-selection beyond
  agent identity; interactive agent picker; cleanup/unset semantics (a child
  process's env dies with it).

## Decisions

### D1 — Command shape & passthrough boundary (`run_dashdash`)

`chorus agents run --name <name|uuid> [--type <type>] [--] <agent args…>`

- Only `--name`, `--type`, `--help`/`-h` are chorus-owned flags, parsed from the
  front of argv.
- The first bare `--` token terminates chorus-flag parsing; **every token after
  it is passed to the agent binary verbatim** (no validation, no
  interpretation). This guarantees an agent's own `--name` / `--type` / anything
  never collides with chorus's flags.
- `--` is optional when there are no passthrough args (`chorus agents run --name X`
  launches the agent bare). If non-flag tokens appear before any `--`, treat the
  first such token as the start of passthrough too (lenient), but the documented
  form uses `--`.

### D2 — Type coverage (`all_known`) & type → binary map

Launch is a **superset** of daemon wake. The binary is resolved from a launch map
independent of the wake `agentType` classification:

| type (`--type` value or config `agentType`) | binary |
|---|---|
| `claude-code`, `claude` | `claude` |
| `codex` | `codex` |
| `kiro` | `kiro-cli` |
| `pi` | `pi` |
| `opencode` | `opencode` |
| `openclaw` | `openclaw` |
| `dsh` | `dsh-jsonrpc-agent` |

- Precedence: explicit `--type` > selected agent's `agentType` from daemon.json.
- **`offline` is intentionally not in the map.** Because `chorus agents add`
  stores `opencode` / `openclaw` / `dsh` as the daemon `agentType` `"offline"`
  (they are not daemon-wakeable), a config type of `offline` cannot be resolved
  to a binary. In that case the launcher errors, telling the user to pass an
  explicit `--type <claude|codex|kiro|pi|opencode|openclaw|dsh>`.
- Binary resolution walks `PATH` (shell-free, Windows `.cmd`/`.exe` aware),
  reusing the same resolver shape as the spawners
  (`resolveClaudePath`/`resolveCodexPath`/…). A missing binary is a clear,
  non-zero-exit error naming the binary and the `PATH` that was searched — never
  a silent failure.

### D3 — Environment injection (child only)

`childEnv = { ...process.env }` plus, from the selected agent:

- `CHORUS_URL` ← agent `url`
- `CHORUS_API_KEY` ← agent `apiKey`
- `CHORUS_AGENT_PROFILE` ← agent `agentUuid || agentName`

No `CHORUS_DAEMON_HEADLESS` (this is an interactive run). The harness's own
credentials (e.g. Codex `~/.codex/.env`, Claude `~/.claude/settings.json`) are
written by `chorus agents add` into each harness's own config and are NOT
re-handled here.

### D4 — Spawn & lifecycle

- `spawn(command, argv, { stdio: "inherit", env: childEnv, shell: false, cwd: process.cwd() })`.
  `stdio: "inherit"` gives the agent the real TTY, so Ctrl-C reaches the child
  directly (shared process group) — no manual signal forwarding needed for the
  common case.
- Windows `.cmd`/`.bat` shims are launched via `cmd.exe /d /s /c <path> …args`
  (reusing the `resolveSpawnCommand` pattern) so `shell: false` stays true and
  there is no shell word-splitting/injection surface.
- The command resolves with the child's exit code; the CLI process exits with
  the same code. A spawn failure (ENOENT, etc.) exits non-zero with a visible
  error.

### D5 — Credential resolver addition

Add `resolveLaunchAgent(flags, deps)` to `cli/credentials.mjs` returning
`{ url, apiKey, agentUuid, agentName, agentType, label }` for the selected agent,
mirroring `resolveMcpCredentials`'s selection precedence but preserving
`agentType`. Ambiguity and "no agents configured" produce the same clear errors.

## Secret handling

The `cho_` API key is injected into the child env only. It is never written to
stdout, never logged, and never included in any error message. `chorus agents
run` prints at most a one-line diagnostic naming the selected agent (name/uuid)
and the binary — never the key or the url userinfo.

## Risks

- **dsh is a JSON-RPC runtime, not a REPL.** Launching `dsh-jsonrpc-agent`
  interactively is unusual but honored under the `all_known` decision + verbatim
  passthrough; the user owns what they pass.
- **`offline` type ambiguity** is handled by requiring an explicit `--type`
  rather than guessing.

## Testing

Unit tests (Vitest, injecting `spawnImpl` / `env` / `readJson` — no real disk,
env, or subprocess), covering: argv split at `--`, flag parsing, agent selection
(single/multi/ambiguous/`--name`/profile), `--type` override vs config default,
`offline`-without-`--type` error, type→binary map, missing-binary error,
childEnv contents, exit-code forwarding, and absence of any secret in stdout/err.
