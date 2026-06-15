# Technical Design: Chorus CLI daemon core

## Overview

Add a client/daemon mode to the existing `chorus` npm CLI. Today `chorus.mjs` parses flags and boots the Next.js standalone server. We introduce a subcommand layer: a bare `chorus` (or `chorus serve`) keeps launching the server; `chorus daemon` and `chorus login` are new client-side commands that connect *out* to a remote Chorus server.

The daemon is a long-lived process that:
1. resolves connection credentials (url + `cho_` API key),
2. opens an SSE subscription to the agent's notification stream,
3. on a relevant notification, resolves the event up the Chorus lineage to its **root idea**,
4. spawns a **headless `claude -p`** subprocess keyed (via `--resume`) to that root idea's session, with the Chorus MCP server wired in,
5. lets Claude act through the existing `chorus_*` MCP tools (comment, report_work, claim, status changes),
6. on reconnect, backfills unhandled notifications.

The portable spine (SSE listener, event-router, MCP client, reconnect/backfill) is lifted from `packages/openclaw-plugin/src/{sse-listener,event-router,mcp-client}.ts`. The single replaced piece is the wake call: OpenClaw's in-process `runEmbeddedAgent` becomes a subprocess spawn.

## Architecture

```
chorus.mjs (subcommand router)
 ├─ (default / serve) → existing Next.js standalone launch  [unchanged]
 ├─ login   → CredentialResolver.interactiveLogin()         [cli-auth]
 └─ daemon  → Daemon.run()                                  [cli-daemon]
                ├─ CredentialResolver.resolve()             [cli-auth]
                ├─ ChorusMcpClient   (POST /api/mcp, Bearer cho_)   ← ported
                ├─ SseListener       (GET /api/events/notifications) ← ported
                │     └─ onReconnect → backfillUnhandled()
                ├─ EventRouter       (route by notification.action) ← ported
                │     └─ on task_assigned/mentioned/... → Waker.wake(event)
                ├─ LineageResolver   (event → rootIdeaUuid)         ← new
                ├─ SessionMap        (rootIdeaUuid ↔ claudeSessionId, persisted) ← new
                ├─ ClaudeSpawner     (headless claude -p, stream-json)  ← new
                └─ UploadHooks       (no-op stubs; reserved for derived idea) ← new
```

### Subcommand routing

`chorus.mjs` inspects `process.argv[2]`. If it is `daemon` or `login`, route to the new modules; otherwise fall through to today's flag parsing + server launch (so `chorus -p 9000` etc. are untouched). Keep the daemon/login code lazy-imported so the server-launch path pays no startup cost.

## Data Model

**No database changes in this change.** All daemon state is local to the host:

- `~/.chorus/daemon.json` — written by `chorus login`: `{ url, apiKey, agentUuid, agentName }`. `0600` perms.
- `~/.chorus/sessions.json` (or under a data dir) — the `rootIdeaUuid → { claudeSessionId, updatedAt }` map. Read on wake, written after each spawn that establishes/continues a session.

The `DaemonConnection` model and `AgentSession.connectionUuid` belong to the derived observability idea, not here.

## Module Contracts

Shared conventions every task must honor:

- **Credential shape**: `ResolvedCredentials = { url: string, apiKey: string, source: "flag"|"env"|"login-file"|"plugin-fallback" }`. `CredentialResolver.resolve(flags)` returns this or throws a single typed error with a human-actionable message (which sources were tried). The daemon and `login` both call the same resolver.
- **MCP call**: all server reads/writes go through the ported `ChorusMcpClient.callTool(name, args)` returning parsed JSON; never hand-roll fetch against `/api/mcp`. Auth header is `Authorization: Bearer <apiKey>`.
- **Lineage result**: `LineageResolver.rootIdeaFor(event) → Promise<string|null>`. For a task event: `chorus_get_task` → proposal → idea; for an idea event: `chorus_get_idea` then walk `parentUuid` to the top. Returns `null` if no idea ancestor exists (e.g. a quick-task with no idea) — caller then falls back to a per-entity session key. Cache within a daemon run.
- **Session key**: `SessionMap.resolve(rootIdeaUuid) → { sessionId, isNew }`. `isNew=false` means pass `--resume <sessionId>`; `isNew=true` means start fresh and capture the new session id from the first stream-json `system`/`init` message, then persist it.
- **Spawn result**: `ClaudeSpawner.wake({ prompt, sessionId|null, mcpConfigPath }) → Promise<{ sessionId, exitCode }>`. Non-blocking with respect to the SSE loop (the listener must keep reading while a subprocess runs); failures are logged, never thrown into the listener (no-silent-errors: log visibly, keep the daemon alive — see project memory `feedback_no_silent_errors`). **Not** unconditionally fire-and-forget — wakes are scheduled through the per-root-idea serial queue below.
- **Per-root-idea serialization**: `WakeQueue.enqueue(rootIdeaKey, () => Waker.wake(event))` runs at most **one** wake at a time **per root idea key** (the `rootIdeaUuid`, or the per-entity fallback key when there is no idea ancestor). Wakes for *different* root ideas run concurrently; wakes for the *same* root idea run strictly sequentially (FIFO). This is what makes the `idea_root` session anchor safe: a single root-idea session is one serial conversation, so two notifications under the same idea never spawn concurrent `claude --resume <sameSessionId>` against one session. The SSE loop enqueues and returns immediately; it never blocks on a running wake.
- **Upload hooks**: `UploadHooks.onConnect()/onSessionStart()/onTranscriptMessage()` are defined as no-op async stubs in this change so the derived observability idea can implement them without re-touching the wake path.

## Cross-platform spawn (the load-bearing engineering point)

Parsing stream-json is plain JS and platform-neutral. Spawning is where the cross-platform work is, and it is all Windows:

1. **Prompt over stdin, not argv.** `claude -p` reads the prompt from stdin. Passing it as an argv arg hits the Windows ~32KB command-line limit and is a shell-escaping/injection surface. So: `spawn(claudePath, ["-p", "--output-format", "stream-json", "--mcp-config", cfgPath, ...resumeArgs])`, then `child.stdin.write(prompt); child.stdin.end()`. argv carries only flags.
2. **Resolve `claude.cmd` without a shell.** On Windows the `claude` bin is `claude.cmd` (npm shim); `spawn("claude", …)` without `shell:true` throws ENOENT because it won't resolve `.cmd`. Resolve the real executable path (walk PATH for `claude`, `claude.cmd`, `claude.exe`) and spawn that directly. Do **not** use `shell:true` (re-introduces the escaping/injection surface).
3. **MCP config to `os.tmpdir()`.** Write the `--mcp-config` JSON to `path.join(os.tmpdir(), …)`, never a hardcoded `/tmp`. Clean it up on process exit.
4. **NDJSON parsing.** Buffer stdout, split on `\n`, `JSON.parse` each non-empty line, and strip a trailing `\r` before parse so Windows `\r\n` pipes parse cleanly.

These mirror the kind of cross-platform work `chorus.mjs` already does (Windows `__dirname` patching, PGlite symlinks), so the package's all-platform publish promise (CLAUDE.md pitfall #9) is upheld.

## Concurrency model

The `idea_root` session anchor (one Claude session per root idea) and the requirement that wakes not block the SSE loop together force a specific concurrency design — otherwise two notifications resolving to the same root idea would launch two `claude --resume <sameSessionId>` subprocesses against one session, corrupting it.

- **Across root ideas → parallel.** Different root ideas have different sessions; their wakes run concurrently (bounded by a small max-concurrency cap to avoid spawning unboundedly many subprocesses under a burst).
- **Within one root idea → serial FIFO.** All wakes keyed to the same root idea run one at a time. The second wake for a root idea waits for the first subprocess to exit before spawning (and only then does it know the session id to `--resume`, since a fresh session's id is captured from the first run's output).
- **SSE loop never blocks.** On each notification the router resolves the root-idea key, then calls `WakeQueue.enqueue(key, task)` and returns immediately. The queue owns subprocess lifecycle; the listener keeps consuming events.
- **Backfilled wakes use the same queue**, so a reconnect burst for one root idea also serializes correctly rather than racing.

`WakeQueue` is a per-key FIFO with a global concurrency cap — a small in-memory structure (map of key → running/pending), no new dependency. A wake that throws is logged and the next queued wake for that key proceeds (a poisoned wake must not wedge the key's queue forever).

## Prompt construction

Per-notification-action prompt builders (ported shape from the OpenClaw event-router): e.g. `task_assigned` → "[Chorus] Task assigned: <title>. Task UUID … Project UUID … Use chorus_get_task to review, then chorus_claim_task to start." Claude is headless and acts only through MCP tools; the daemon does not need to interpret Claude's output for correctness (state lands in Chorus via tool calls). The transcript is captured for the future relay but is not load-bearing for this change.

## Implementation Plan

1. CLI scaffolding + subcommand router + credential resolver + `chorus login` (foundation).
2. Connection layer: port MCP client + SSE listener + reconnect/backfill.
3. Lineage resolver + persisted session map.
4. Cross-platform headless spawner + stream-json capture (parallel with 2/3).
5. Wake orchestration: event-router + prompt builders + the per-root-idea `WakeQueue` wiring 2/3/4 together + no-op upload hooks.
6. Integration checkpoint: end-to-end daemon run + bin packaging/`files` field.

## Risks & Mitigations

- **`claude` CLI flags drift** (`-p`, `--output-format stream-json`, `--resume`, `--mcp-config`): developers must verify exact flag names/shape against the installed Claude Code CLI docs rather than relying on memory; treat the spawner's arg list as a single place to update.
- **stream-json schema for session id capture**: the field that carries the session id on a fresh run must be confirmed against actual `claude -p --output-format stream-json` output (likely the initial `system`/`init` event). Verify empirically before relying on it.
- **Credential fallback to plugin config**: the path/shape of the Claude Code chorus plugin's stored url+key must be read defensively (file may be absent / differently shaped); treat as best-effort last resort.
- **No new deps**: resist pulling an SSE or MCP client library; the OpenClaw plugin's hand-rolled fetch-based SSE + the MCP SDK already in the repo are the reference. If the MCP SDK can't be reused without bloating the CLI bundle, a minimal fetch-based JSON-RPC client against `/api/mcp` is acceptable.
- **Daemon must never die on a single bad wake**: all per-event work is wrapped so a spawn/parse failure logs and continues (no-silent-errors, but also no crash-loop).
