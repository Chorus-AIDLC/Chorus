# Technical Design: daemon Codex backend

## Overview

Add a second spawner backend behind the daemon's existing `--agent` selection. The wake pipeline (SSE → EventRouter → WakeQueue → Waker) stays backend-agnostic; only the leaf that turns a wake into a subprocess changes. We extract the implicit `ClaudeSpawner.wake(...)` contract into an explicit interface and add a `CodexSpawner` that satisfies it against `codex exec`.

The design is shaped by four verified divergences between Codex 0.142.3 and Claude Code (see proposal §Why). Everything below follows from them.

## Architecture

```
resolveAgentType(flags, env)  →  "claude-code" | "codex"
                                        │
                  daemon.mjs spawner-injection seam
                    (deps.spawner ?? selectSpawner(agentType, {logger, permissionMode}))
                                        │
              ┌─────────────────────────┴─────────────────────────┐
        ClaudeSpawner                                         CodexSpawner
   (claude -p --session-id/--resume,                  (codex exec --json / exec resume <id>,
    transcript-file probe = new/resume,                id-map lookup = new/resume,
    --allowedTools / --skip-permissions)               --sandbox / --dangerously-bypass…)
              └──────── both implement Spawner.wake(params) → result ────────┘
```

The Waker is unchanged: it passes `sessionId` (the Chorus anchor — direct idea uuid, else entity uuid), `isNew` (its own transcript probe), `cwd`, `mcpConfigPath`, `onMessage`, `onChild`, and consumes `{ sessionId, exitCode, isNew }`. **Key move:** the waker's `isNew` and `mcpConfigPath` are *Claude-shaped*. To keep the waker backend-agnostic without a rewrite, the **spawner owns the final new-vs-resume decision and the MCP wiring** — the Claude spawner honors the passed `isNew`/`mcpConfigPath`; the Codex spawner ignores them and derives its own (id-map for new-vs-resume; user config for MCP). This is the smallest change that respects "each backend owns its session model" (Q2) and "rely on user config" (Q4).

## Module Contracts

### Spawner interface (the seam)

```
wake({
  prompt: string,          // fed over stdin, NEVER argv
  sessionId: string|null,  // Chorus anchor (direct idea uuid | entity uuid)
  isNew: boolean,          // Claude: authoritative; Codex: advisory (spawner re-derives)
  mcpConfigPath?: string,  // Claude: --mcp-config file; Codex: ignored
  cwd?: string,            // spawn cwd (same value the waker probed)
  onMessage?: (obj) => void,  // each parsed stream event
  onChild?: (child) => void,  // live ChildProcess, sync, only on successful spawn
}) → Promise<{ sessionId: string, exitCode: number|null, isNew: boolean }>
```

Invariants both backends honor (carried over from `ClaudeSpawner`, all verified there):
- **Never throw into the wake path.** A failed executable resolution / spawn / stdin EPIPE resolves with `exitCode: null` and a visible `logger.error`/`warn` — never an uncaught exception (one bad wake must not kill the daemon).
- **`onChild` fires exactly once, synchronously, only on a successful spawn**, before the promise resolves — the waker registers the handle for the interrupt path.
- **stdout parsed via `parseNdjsonChunk`** (already platform-neutral and shared) with a carry-over buffer; malformed lines warn-and-skip.
- **POSIX `detached: true`** (process-group leader) so `killProcessTree` can group-kill descendants; Windows uses `taskkill /T /F`. stdio stays `["pipe","pipe","pipe"]`.
- **Returned `sessionId`** is the id the daemon should anchor on going forward. Claude returns the same uuid it was given; **Codex returns its generated `thread_id`** (observed from the stream) — the waker already tracks `observedSessionId` from `onMessage`, so the return value reconciles.

### `CodexSpawner` specifics

- **buildArgs (new):** `["exec", "--json", sandboxFlag…]`, prompt via stdin. `--skip-git-repo-check` is included so a non-repo cwd still runs. The model/provider come from the user's config (not forced here).
- **buildArgs (resume):** `["exec", "resume", "<thread_id>", "--json", sandboxFlag…]`.
- **Sandbox flag from permission mode:** `yolo → ["--dangerously-bypass-approvals-and-sandbox"]`; `chorus → ["--sandbox", "read-only"]`. (Mirrors `ClaudeSpawner`'s `permissionMode` constructor option.)
- **Thread-id capture:** on each `onMessage`, if the event carries the session/thread id (`session_meta.payload.id` or `thread.started.thread_id` — verify exact shape against installed version at impl time), record it as `observedThreadId`. On a successful, non-interrupted exit of a *new* run, persist `anchor (sessionId) → observedThreadId` via `codex-session-map`.
- **new-vs-resume:** look up `sessionId` in the id map. Hit → resume with stored `thread_id`. Miss → new run. This *replaces* the waker's transcript-file probe for the Codex backend (the probe targets Claude's `~/.claude/projects/.../<id>.jsonl` layout, which does not apply).

### `codex-session-map` (daemon-local persistence)

- Single JSON file under the daemon config dir (same dir family as `~/.chorus/daemon.json`; exact path chosen at impl, e.g. `~/.chorus/codex-sessions.json`), shape `{ "<anchor-uuid>": "<codex-thread-id>" }`.
- `getThreadId(anchor) → string|null` and `setThreadId(anchor, threadId)`; atomic write (temp + rename), never throws into the wake path (a write failure logs and degrades to "next wake starts fresh").
- cwd/multi-path note: the map is keyed by the Chorus anchor (idea uuid), which is already globally unique, so it is safe across the daemon's multiple path-connections.

### MCP authentication wiring (Q4 = c)

The daemon does not write a Codex MCP config. Instead, before spawning, `CodexSpawner` ensures the child env carries the daemon's own resolved API key under the variable the user's `[mcp_servers.chorus]` references via `bearer_token_env_var` (default `CHORUS_API_KEY`): `env: { ...process.env, CHORUS_API_KEY: creds.apiKey, CHORUS_DAEMON_HEADLESS: "1" }`. Key via env, **never argv**. If the user has no `chorus` server configured, Codex starts without Chorus tools — logged once, not fatal. (The daemon's resolved `creds.apiKey` is already available at construction; pass it into the spawner like `permissionMode`.)

## Risks & Mitigations

- **Codex CLI drift.** Flags / event field names / config keys can change between releases. *Mitigation:* the implementation task MUST re-verify against the installed `codex --help` and `../codex` source; tests assert on our `buildArgs`, not on Codex's runtime behavior; unknown stream events are skipped, not fatal.
- **Thread-id event shape uncertainty.** Docs say `thread.started.thread_id`; the on-disk rollout uses `session_meta.payload.id`. *Mitigation:* capture defensively — accept either, prefer the first id-bearing event; if none is seen, the run still completes (just won't be resumable, logged).
- **Wrong-agent MCP key.** If the user's config hard-codes a different key instead of `bearer_token_env_var`, the woken Codex would act as that other agent. *Mitigation:* document that the daemon relies on `bearer_token_env_var`; the env-exported daemon key only takes effect when the config references it. Out of scope to rewrite the user's config.
- **Interrupt reaching Codex's child shells.** Codex forks shells for tool calls. *Mitigation:* `detached` process-group + group-kill is exactly the mechanism `ClaudeSpawner` already proved for this; reused unchanged.
- **claude-code regression.** *Mitigation:* `ClaudeSpawner` is left byte-equivalent; the interface extraction is type/doc-only; a test asserts the default agent still selects `ClaudeSpawner` and its argv is unchanged.

## Implementation Plan

1. Add `codex` to `KNOWN_AGENTS`; extract the `Spawner` interface typedef; add `selectSpawner(agentType, opts)` and wire it at the `daemon.mjs` injection seam (claude-code unchanged).
2. `codex-session-map.mjs` — persistence with round-trip tests.
3. `CodexSpawner` — executable resolution, buildArgs (new/resume + sandbox), spawn (detached, stdin, JSONL parse), thread-id capture + map write, env key export. Full unit tests.
4. Integration check: a default-agent daemon still spawns Claude with identical argv; an `--agent codex` daemon selects `CodexSpawner` and (with a stub spawn) produces the expected `codex exec --json` argv for new and resume, with the prompt on stdin.

## Verification notes for implementers (anti-hallucination)

Before coding, run and read:
- `codex exec --help` and `codex exec resume --help` (flags: `--json`, `--sandbox`, `--dangerously-bypass-approvals-and-sandbox`, `--skip-git-repo-check`, `--ephemeral`).
- `../codex` source for the JSONL event carrying the thread/session id and for `bearer_token_env_var` handling in the MCP config loader.
- The installed `~/.codex/config.toml` `[mcp_servers.chorus]` block as the reference shape the daemon relies on.
