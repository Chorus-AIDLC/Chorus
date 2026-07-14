# Technical Design: daemon Kiro backend

## Overview

Add a third spawner backend behind the daemon's existing `--agent` selection. The wake pipeline (SSE → EventRouter → WakeQueue → Waker → spawner) stays backend-agnostic; only the leaf that turns a wake into a subprocess changes. `KiroSpawner` satisfies the same `Spawner.wake(...)` contract that `ClaudeSpawner` and `CodexSpawner` already implement, and `selectSpawner(agentType, opts)` dispatches to it.

The design follows five verified facts about Kiro CLI 2.12.1 vs Codex/Claude (see proposal §Why): (1) `chat --no-interactive` with stdin prompt + trust flags; (2) native `--resume-id` where **Kiro owns the id** (Codex-like); (3) **no** structured chat-turn stream; (4) but a structured on-disk **session store**; (5) a v2/v3 engine fork we pin to v2. Where Kiro matches Codex (own-id resume, MCP-from-user-config, env key, detached kill) the Codex modules are the template; where it diverges (transcript reconstruction, `--resume-id` vs `exec resume`, `--agent chorus` profile) the design calls it out.

## Architecture

```
resolveAgentType(flags, env)  →  "claude-code" | "codex" | "kiro"
                                        │
                     spawner-select.mjs  selectSpawner(agentType, {logger, permissionMode, creds})
                                        │
        ┌───────────────────────────────┼───────────────────────────────┐
  ClaudeSpawner                    CodexSpawner                      KiroSpawner
 (claude -p,                 (codex exec --json,              (kiro-cli chat --no-interactive
  transcript-file probe,      id-map = new/resume,             --agent chorus,
  --mcp-config,               --sandbox flags,                 id-map = new/--resume-id,
  --allowedTools)             MCP from ~/.codex config)         --trust-* flags,
        │                            │                          MCP from .kiro/settings,
        │                            │                          transcript from session store)
        └──────── all implement Spawner.wake(params) → { sessionId, exitCode, isNew } ────────┘
```

The Waker is unchanged. As with Codex, the waker's `isNew` (a Claude transcript probe) and `mcpConfigPath` (a Claude `--mcp-config` file) are Claude-shaped; `KiroSpawner` **ignores** them and derives its own new-vs-resume (from the id map) and MCP wiring (from the plugin config + env key). This is the same "each backend owns its session model" move the Codex backend already established.

## Module Contracts

### Spawner interface (unchanged seam)

`KiroSpawner` implements the existing contract verbatim — no interface change:

```
wake({
  prompt: string,          // fed over stdin, NEVER argv
  sessionId: string|null,  // Chorus anchor (direct idea uuid | entity uuid)
  isNew: boolean,          // Claude: authoritative; Kiro: advisory (spawner re-derives from id map)
  mcpConfigPath?: string,  // Claude: --mcp-config; Kiro: ignored (uses .kiro/settings/mcp.json)
  cwd?: string,            // spawn cwd
  onMessage?: (obj) => void,  // per reconstructed transcript entry (see below)
  onChild?: (child) => void,  // live ChildProcess, sync, only on successful spawn
}) → Promise<{ sessionId: string, exitCode: number|null, isNew: boolean }>
```

Invariants carried over from the other spawners (all must hold for Kiro):
- **Never throw into the wake path.** Failed executable resolution / spawn / stdin EPIPE / session-store read resolves with `exitCode: null` (or a completed exit) and a visible log — never an uncaught exception.
- **`onChild` fires exactly once, synchronously, only on a successful spawn.**
- **POSIX `detached: true`** (process-group leader) so `killProcessTree` group-kills descendants; Windows `taskkill /T /F`. stdio `["pipe","pipe","pipe"]`.
- **Returned `sessionId`** is the id the daemon anchors on going forward — Kiro returns its **generated** `sessionId` (read from the store / metadata after the run), reconciled by the waker's `observedSessionId` tracking.

### `KiroSpawner` specifics

- **buildArgs (new):** `["chat", "--no-interactive", "--agent", "chorus", ...trustFlags]`, prompt via stdin. Engine left at v2 default (no `--v3`).
- **buildArgs (resume):** `["chat", "--no-interactive", "--resume-id", "<sessionId>", "--agent", "chorus", ...trustFlags]`, prompt via stdin.
- **Trust flags from permission mode:** `yolo → ["--trust-all-tools"]`; `chorus → ["--trust-tools=fs_read,<chorus-mcp-tool-names>"]` (the exact trustable Chorus MCP tool identifiers verified at impl time against `kiro-cli` — MCP tool trust names are namespaced, e.g. `@chorus/<tool>`). Mirrors `CodexSpawner`'s `permissionMode` constructor option.
- **sessionId capture:** `chat --no-interactive` has no id-bearing stream event, so capture is **post-run**: after the child exits, resolve the run's `sessionId` by reading Kiro's session store for this cwd — either the most-recent session created during the run (compare `--list-sessions` / store `updated_at` before vs after), or (on resume) the `--resume-id` we passed. Persist `anchor → sessionId` on a successful new run.
- **new-vs-resume:** look up `sessionId` (the Chorus anchor) in the id map. Hit → `--resume-id <stored>`. Miss → new run. Replaces the waker's Claude transcript probe.

### Transcript reconstruction (transcript decision: store-first, plain-text fallback)

Kiro emits no per-message stream, so `onMessage` is fed **post-run** from Kiro's on-disk store rather than live from stdout:

- **Primary (option 2):** after the child exits, read `~/.kiro/sessions/cli/<sessionId>.jsonl` for the run's session. Each line is `{version, kind, data}` with `kind ∈ {Prompt, AssistantMessage, ...}` and the body in `data.content[]` (only `text` content blocks are kept; thinking/toolUse/toolResult dropped). Map `Prompt → user`, `AssistantMessage → assistant`, forward each via `onMessage`. **Child sessions:** reviewer subagents create separate sessions with `parent_session_id` pointing at ours — walk children so subagent turns are captured. (Child detection keys on `parent_session_id`, NOT `session_created_reason`, which is `"subagent"` even on root sessions.)
- **Fallback (option 1):** capture the run's stdout as **one plain-text transcript entry**, ANSI-stripped (headless stdout is color-styled with spinner frames + a `> ` answer marker — `stripAnsi` cleans it).
- **⚠️ Verified live at the integration checkpoint (kiro-cli 2.12.1):** `chat --no-interactive` does **NOT** persist a session to the cli store — only interactive/TUI runs write it. So on the daemon's headless path the store lookup normally finds nothing and **the plain-text fallback is the effective (common) path, not a rare degrade.** The store-reconstruction code is kept because it is correct + richer (and would light up if a future Kiro persists headless sessions or when subagent sessions are written), but the fallback must produce clean text — hence `stripAnsi`. Two consequences follow the same root cause: (a) `--resume-id` resume is best-effort — a headless run leaves no session to resume, so a re-wake simply starts fresh (honest degrade, no crash); (b) the transcript reconstruction runs **regardless of whether a sessionId was captured**, so the fallback always fires.
- The reconstruction reader lives in a small helper (e.g. `cli/kiro-transcript.mjs`) so it is unit-testable against a fixture store and the fallback is a clean branch. A dialect extension in `upload-hooks.mjs` is only needed if the reconstructed entries don't fit the existing user/assistant envelope.

### `kiro-session-map` (daemon-local persistence)

- Single JSON file `~/.chorus/kiro-sessions.json`, shape `{ "<anchor-uuid>": "<kiro-session-id>" }`, keyed by the globally-unique Chorus anchor (safe across the daemon's multiple path-connections).
- `getSessionId(anchor) → string|null`, `setSessionId(anchor, id)`; atomic write (temp + rename, mode 0600), never throws into the wake path (a write failure logs and degrades to "next wake starts fresh"). Same contract as `codex-session-map.mjs` — factor a shared helper if the two are byte-identical apart from the filename.

### MCP authentication wiring (fallback decision = a: rely on plugin config)

The daemon does not write a Kiro MCP config. It relies on the Kiro plugin's `.kiro/settings/mcp.json`, whose `chorus` server carries a static Bearer header `Authorization: Bearer ${env:CHORUS_API_KEY}`. Before spawning, `KiroSpawner` sets the child env: `{ ...process.env, CHORUS_API_KEY: creds.apiKey, CHORUS_DAEMON_HEADLESS: "1" }` — key via env, **never argv** — so the woken Kiro authenticates its Chorus MCP calls as the daemon's agent. If the plugin/MCP config is absent, the woken Kiro simply lacks Chorus tools — logged, not fatal. The `--agent chorus` profile is what pulls in that MCP config plus the AI-DLC skills and steering.

## Risks & Mitigations

- **Kiro CLI drift.** Flags, engine names, session-store path/schema, and MCP tool trust names can change between releases. *Mitigation:* the implementation tasks MUST re-verify against installed `kiro-cli chat --help` + the live store; tests assert on our `buildArgs`, not Kiro's runtime; unknown store lines are skipped, not fatal.
- **Session-store schema is undocumented (transcript primary path).** The `.jsonl` `{kind, data.content[]}` shape is reverse-engineered, not a public contract. *Mitigation:* the plain-text-blob fallback is explicitly authorized (transcript decision) — reconstruction is best-effort and never blocks the wake; a parse failure degrades cleanly.
- **sessionId capture is post-run, not from a stream.** Unlike Codex's `thread.started` event, Kiro gives no in-stream id, so we infer the run's `sessionId` from the store. *Mitigation:* on resume the id is known (we passed `--resume-id`); on a new run, snapshot the store before/after and take the newly-created session.
  - **Concurrency (reviewer N1) — RESOLVED by unambiguous-only capture.** Confirmed at integration time: the WakeQueue serializes wakes **per idea-key** but runs **different keys concurrently** (default `maxConcurrency` 4), and all keys share the daemon's single repo cwd — so two fresh Kiro runs CAN be in flight in the same cwd at once. The capture is therefore hardened to be **unambiguous rather than "newest wins"**: `pickNewSessionId(before, after)` returns the new id **only when exactly one** brand-new session id appeared in the window; if **zero or several** new ids appeared (a concurrent same-cwd run), it returns null and the spawner **does not persist** — degrading to "not resumable this time" (a missed resume is a minor efficiency loss) rather than risk cross-wiring two ideas' conversations (a correctness bug). There is no "updated_at advanced" fallback: a fresh run always creates a new id, and a resume already knows its id.
- **Headless MCP not loading (the #5958 concern).** *Mitigation:* root cause was a missing node-22 in the workspace, not a Kiro bug; this host has node 22 + kiro 2.12.1. The first integration task validates headless MCP end-to-end **live**; the `chorus-api.sh` REST fallback (already in the plugin) is the contingency if it fails. node-22 documented as a prereq.
- **Plugin dependency.** `--agent chorus` requires the Kiro plugin installed (like Codex needs `~/.codex/config.toml`). *Mitigation:* documented prereq; absence is logged (no Chorus tools) rather than crashing.
- **Interrupt reaching Kiro's child shells.** *Mitigation:* `detached` process-group + group-kill is the mechanism the other two spawners already proved; reused unchanged (spawn `detached`, hand the child to `onChild`).
- **claude-code / codex regression.** *Mitigation:* those spawners are untouched; a test asserts the default agent still selects `ClaudeSpawner` and `--agent codex` still selects `CodexSpawner` with unchanged argv.

## Implementation Plan

1. Register `kiro` as a backend: `daemon-agent.mjs` (`KNOWN_AGENTS`, `backendCli`, `backendClientType`), `spawner-select.mjs` branch, server `DAEMON_CLIENT_TYPES` + presence label; reconcile the stale `client-args.mjs` list. Tests: resolution accepts kiro / rejects unknown; selection picks `KiroSpawner`; claude/codex argv unchanged.
2. `kiro-session-map.mjs` — persistence (round-trip / missing / corrupt / write-failure tests), sharing with `codex-session-map` where identical.
3. `KiroSpawner` — executable resolution, buildArgs (new/`--resume-id`, `--agent chorus`, trust per mode, prompt on stdin), spawn (detached, env key + `CHORUS_DAEMON_HEADLESS`), sessionId capture, id-map write. Unit tests on argv + capture.
4. Transcript reconstruction (`kiro-transcript.mjs`) from a fixture session store incl. a child subagent session, plus the plain-text fallback branch. Wire into the transcript-upload hook.
5. Live integration + validation on this host: confirm headless MCP loads under `--agent chorus` (build the REST fallback only if it fails); confirm a real wake → `kiro-cli chat --no-interactive` argv (new + resume), interrupt via process-group kill, and transcript capture end-to-end. Re-verify all flags/paths against installed `kiro-cli`.

## Verification notes for implementers (anti-hallucination)

Before coding, run and read:
- `kiro-cli chat --help` (confirm `--no-interactive`, `--resume-id`, `-r/--resume`, `--list-sessions`, `--trust-all-tools`, `--trust-tools`, `--agent`, `--agent-engine`, `--require-mcp-startup`, `--format`).
- `kiro-cli chat --list-sessions --format json` and the on-disk `~/.kiro/sessions/cli/<id>.jsonl` + `<id>.json` for the exact store schema and the `parent_session_id` / `session_created_reason` fields.
- The Kiro plugin's `.kiro/settings/mcp.json` (`public/kiro-plugin/`) as the MCP config the daemon relies on, and its agent name (`chorus`).
- The trustable Chorus MCP tool identifiers as Kiro names them (namespaced, verify exact form) for the restricted `--trust-tools=` set.
- `node --version` (headless MCP needs node ≥ 22 per the #5958 root cause).
