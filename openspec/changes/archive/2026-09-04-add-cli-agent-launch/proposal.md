# Add `chorus agents run` — launch a configured coding agent

## Why

Today, to start a coding agent (Claude Code, Codex, Kiro, pi, …) wired to a
Chorus instance, a user must manually discover and export the right connection
and identity variables (`CHORUS_URL`, `CHORUS_API_KEY`, `CHORUS_AGENT_PROFILE`)
before running the agent binary. That is fiddly and error-prone, especially on a
machine that has several agents configured in `~/.chorus/daemon.json`.

The original idea framed this as "load the variables into the current shell".
That is not achievable: a child process cannot mutate its parent shell's
environment (a POSIX invariant — the child receives a *copy*). The owner
redirected the work to the robust path instead: **have the CLI launch the agent
itself as a child process, injecting the environment only into that child.** This
sidesteps the parent-shell problem entirely and never leaks the API key into the
parent shell or terminal history.

The credential-injection machinery already exists — the daemon's spawners
(`ClaudeSpawner`, `CodexSpawner`, …) inject exactly this environment when they
wake an agent headlessly. This change surfaces the same injection as a
foreground, interactive command.

## What Changes

- **New subcommand `chorus agents run`** (peer of `list` / `add` / `remove`):
  `chorus agents run --name <name|uuid> [--type <type>] -- <agent args…>`.
  - Selects which configured agent (profile) to act as, reusing the existing
    `resolveMcpCredentials` selection semantics.
  - Resolves the agent binary from the agent's `agentType` (overridable with
    `--type`), then `exec`s it in the **foreground** with the user's TTY.
  - Injects `CHORUS_URL` / `CHORUS_API_KEY` / `CHORUS_AGENT_PROFILE` into the
    child environment only.
  - Passes every token after `--` through to the agent binary **verbatim, with
    no validation** — the agent's full flag surface is available.
  - Forwards the child's exit code as the command's own exit code.
- **No env-export path in v1.** Emitting `export …` lines for `eval` is deferred
  as a possible later enhancement.

## Capabilities

- `cli-agent-launch` — the `chorus agents run` command: agent selection, type →
  binary resolution, credential injection, verbatim passthrough, foreground
  launch, and its error surface.

## Impact

- **Affected code:** a new `cli/agent-launcher.mjs` module, a `run` branch in
  `cli/agents.mjs` (`runAgents` dispatch + group help), and a small credential
  resolver addition in `cli/credentials.mjs` (return the selected agent's
  `agentType` alongside url/apiKey). All plain ESM, zero new dependencies —
  ships in the npm package.
- **Docs:** the `chorus-cli` skill gains the `run` command contract; user docs
  gain a short "launch an agent" section.
- **No schema, API, or web changes.** No secret is ever printed to stdout, logs,
  or error messages.
