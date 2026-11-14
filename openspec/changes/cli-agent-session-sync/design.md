## Context

- `chorus agents run` (`cli/agent-launcher.mjs`) spawns the configured agent binary in the foreground with inherited stdio and injected `CHORUS_URL` / `CHORUS_API_KEY` / `CHORUS_AGENT_PROFILE`. It registers nothing in Chorus today.
- `DaemonSession` (`prisma/schema.prisma`) already models ad-hoc (`directIdeaUuid = null`) and Idea-anchored conversations with a Chorus `sessionId`, a backend-owned `backendSessionId`, an `originConnectionUuid` (the daemon connection/cwd that owns the on-disk transcript) and `runtimeCwd`. Turns (`DaemonSessionTurn`) carry `status = pending | running | ended | interrupted`; pending human-instruction turns are delivered live to the origin connection or recovered by reconnect backfill (`/api/daemon/pending-turns`).
- Transcript text is appended per turn via `POST /api/daemon/transcript` (agent-key auth, owner-scoped, user/assistant only) and fanned out over SSE.
- Claude resume: the daemon generates the id, uses `claude --session-id <uuid>` for a new run and `--resume <uuid>` to continue; continuation is cwd/machine-bound (`cli/claude-spawner.mjs`). Codex/Kiro self-generate ids, mapped by `cli/session-map.mjs`. Kiro interactive runs persist `~/.kiro/sessions/cli/<id>.{jsonl,json}` (`cli/kiro-transcript.mjs`).
- Decisions from elaboration: default-on (`--no-sync` opt-out); live transcript; queue Chorus sends while the CLI runs; ad-hoc by default with optional `--idea`; all resumable backends; warn-and-continue when no daemon; non-live backends degrade to upload-on-exit; queued turns auto-resume immediately on CLI exit.

## Goals / Non-Goals

**Goals:** a terminal-started conversation becomes a normal Chorus daemon session that can be read live and continued from the UI by the local daemon, with zero impact on the interactive agent when anything fails.

**Non-Goals:** concurrent writes to one conversation from terminal and daemon; injecting Chorus messages into the running TUI; syncing tool calls/thinking; continuing on a different machine or cwd; a new MCP tool or permission bit; syncing `--no-sync` or non-resumable backends (opencode/openclaw/dsh) beyond registration.

## Decisions

### D1 — Server-authoritative CLI lease (not a local lock)
Add to `DaemonSession`: `cliLeaseHolder String?` (opaque per-run id), `cliLeaseExpiresAt DateTime?`, `cliHost String?`, `cliCwd String?`, `continuable Boolean @default(true)` (a **stored** flag, set false by `release { continuable:false }` or registration when the resume identity cannot be established), and make the origin binding lazy (see D5). The CLI heartbeats every 15 s with a 60 s TTL. Delivery gating lives in one server predicate `isCliLeased(session, now)` consulted by every path that delivers a pending turn (live wake emit, pending-turns backfill, coalescing). *Why not a local lock file the daemon checks:* the server already decides delivery; a server lease also gives the UI its "Running in CLI" state and survives multi-connection daemons. Alternative rejected.

### D2 — Endpoints (agent API key, owner-scoped, 404 on foreign, no MCP tool)
- `POST /api/daemon-sessions/cli` `{ agentType, host, cwd, ideaUuid?, backendSessionId?, title? }` → `{ sessionUuid, sessionId, turnUuid, leaseHolder, leaseTtlSec, originBound: boolean }`. Creates the ad-hoc/anchored session, one `trigger = "cli_session"` turn that receives the CLI transcript (see D8 for its status semantics), and the lease. The response `sessionId` is what the CLI feeds into `backendSessionKey` (D3).
- `POST /api/daemon-sessions/cli/:sessionUuid/heartbeat` `{ leaseHolder, backendSessionId? }` → renews lease; late `backendSessionId` report allowed.
- `POST /api/daemon-sessions/cli/:sessionUuid/release` `{ leaseHolder, continuable: boolean, reason? }` → ends the CLI turn, clears the lease, then runs D4 drain.
- Transcript reuses `POST /api/daemon/transcript` against the CLI turn (no new ingest path).
Errors: stale `leaseHolder` → 409; unknown/foreign session → 404; invalid idea → 400.

### D3 — Backend adapters (`cli/cli-session-sync/<backend>.mjs`)
One contract per backend:
```
{ prepareArgs(userArgs, ctx) -> { args, backendSessionId|null },
  discoverSessionId(ctx) -> Promise<string|null>,     // self-generated ids
  transcriptSource(ctx) -> { mode: "live"|"on_exit", next(): Promise<Message[]> } }
```
**Resume identity MUST equal what the daemon will compute on its next wake** — the daemon does not read the server's `backendSessionId` to resume:

- **Claude Code (caller-supplied id):** the daemon resumes with `backendSessionKey(sessionId, agentUuid)` (`cli/claude-spawner.mjs` `#wake`). The CLI therefore computes the *same* key from the server-returned `sessionId` and its agent uuid, and injects `--session-id <that key>`. If the user passed their own `--session-id/--resume/--continue` (verify exact short flags) after `--`, the CLI does NOT inject and registers the session with `continuable:false` (the daemon could not find that conversation under its derived key). Live: tail the Claude JSONL transcript for (cwd, key), reusing the claude-spawner message filter (drop tool/thinking/synthetic).
- **Pi (caller-supplied id):** same as Claude — the daemon uses `backendSessionKey(anchor, agentUuid)` via `buildPiArgs({ sessionId })` (`cli/pi-spawner.mjs`). The CLI injects that key with Pi's interactive session argument (verify the flag for interactive mode). Pi is NOT a discovery backend. Transcript mode per verified behavior, default `on_exit`.
- **Codex / Trae (self-generated id, Codex App Server family):** discover the new thread id from the backend's session store (cwd match, created after launch, single newest; ambiguity → `continuable:false`) and write it into the Codex/Trae session map **with the ownership metadata the CodexSpawner checks** (it refuses legacy entries of unknown ownership), keyed exactly as the daemon looks it up. Codex: live tail of its rollout file; Trae: per verified behavior.
- **Kiro (self-generated id):** discover `~/.kiro/sessions/cli/<id>` and write the Kiro session map. Today `KiroSpawner.verifySessionOwnershipFn` defaults to `() => false` and `spawner-select.mjs` never injects one, so *no* mapped Kiro session is ever resumed. This change adds an ownership record (agentUuid + anchor written by the CLI sync / daemon) and wires a real `verifySessionOwnershipFn` in `spawner-select.mjs` that accepts entries owned by the same agent for the same anchor. Transcript: `on_exit` reconstruction via `cli/kiro-transcript.mjs`.
**Developers MUST verify each backend's on-disk paths, file formats and resume flags against the installed CLI version** — the paths above are from repo code/comments, not re-verified official docs.

### D4 — Drain on release/expiry
Drain triggers (all idempotent; the drain claims the lease clear with a conditional `updateMany WHERE cliLeaseHolder = X AND cliLeaseExpiresAt < now` so concurrent triggers deliver once):
1. `release` — immediate.
2. **Daemon heartbeat piggyback** — `POST /api/daemon/connection-heartbeat` (sent by every online daemon on each SSE heartbeat) sweeps expired CLI leases on sessions bound to that connection. Draining only matters when the origin daemon is online, and an online daemon heartbeats continuously, so expiry is observed within one heartbeat interval after the TTL — no new server timer, works on multi-instance deployments.
3. **Lazy check** on session read / instruction send / pending-turns backfill: an expired lease is treated as released and drained.
The drain itself (`drainQueuedTurns(session)`): if origin bound and online, emit the normal human-instruction wake for the oldest pending turn (existing coalescing collapses duplicates); otherwise leave pending — existing reconnect backfill delivers them when the daemon comes online. The daemon then resumes through its existing per-backend path (derived `backendSessionKey` for Claude/Pi, ownership-checked session map for Codex/Trae/Kiro — see D3); the only new daemon-side logic is the Kiro ownership verifier.

### D5 — Lazy origin binding
`originConnectionUuid` becomes nullable. At registration the server looks up a `DaemonConnection` for (agent, host) that serves the cwd — either its own cwd equals the launch cwd, or the cwd is one of that connection's discovered/directed working directories (daemon-directory-discovery); the latter binds with `runtimeCwd = launch cwd`. If found, bind. Otherwise store `cliHost/cliCwd` and bind on the next connection registration (or directory-discovery report) for the same agent + host that serves that cwd. Unbound sessions: send is blocked with a dedicated reason (reusing the offline-origin gate). All existing readers of `originConnectionUuid` must handle null (audit in task).

### D6 — Launcher integration and failure posture
`agent-launcher.mjs` gains `--no-sync` and `--idea <uuid>` (parsed before `--`; tokens after `--` remain verbatim). Sync runs in-process beside the child: register → spawn → heartbeat + transcript pump → on child exit flush (bounded, ≤ 5 s) → release → forward exit code. Every sync error is caught and logged to a file under `~/.chorus/logs/`; at most one stderr warning line at start (registration/no-daemon) and one at exit (upload failure). SIGINT/SIGTERM forwarding is unchanged; release is attempted on signals. The API key never appears in output (existing secret rule).

### D8 — The CLI turn is invisible to daemon turn machinery
The `cli_session` turn is created `running` (so the UI shows activity) with `wakeTargetConnectionUuid = null` and `admissionConnectionUuid = null`, and is **excluded by trigger** from every path that assumes a running turn belongs to a daemon process: connection-reconnect/stale finalization (`daemon-connection.service.ts` orphan interrupt), SSE-drop handling, open-session orphan reconciliation, single-running-turn assumptions and turn-advance/merge logic in `daemon-session.service.ts`, execution-state snapshot reconcile, and the interrupt/resume controls. A single helper `isDaemonOwnedTurn(turn)` (`trigger !== "cli_session"`) is used at each call site. The CLI turn ends only via `release` or lease expiry (D4), which set it `ended`. While it is running, pending human turns queue behind it; the UI Interrupt control is hidden for it. The server task MUST enumerate and test every call site that queries `status = "running"`.

### D7 — UI
Conversation surface reads `cliLease` (live/expired), `originBound`, `continuable` from the session read API. Shows a "Running in terminal" header badge, a queued hint under pending human turns, a disabled-send reason for unbound / not-continuable sessions. i18n en/zh, semantic tokens + `dark:` variants, design.pen updated.

## Module Contracts

- Session read/list payloads add `{ cli: { leased: boolean, host, cwd } | null, originBound: boolean, continuable: boolean }`.
- `trigger = "cli_session"` turns are never delivered to a daemon and are excluded from all daemon turn machinery via `isDaemonOwnedTurn` (D8); they end on release or lease expiry.
- Resume identity: CLI and daemon compute the backend id identically (`backendSessionKey(sessionId, agentUuid)` for Claude/Pi; session-map entry with ownership metadata for Codex/Trae/Kiro). `backendSessionId` on the server is informational (copy/takeover), not the resume source.
- Lease predicate `isCliLeased(session, now)` is the only gate — no path may deliver a pending turn without consulting it.

## Risks / Trade-offs

- **Session id discovery races** (two terminals in one cwd) → cwd + launch-time filter, ambiguity marks not continuable rather than guessing.
- **Backend on-disk formats change** → adapters fail soft to `on_exit` or "not continuable"; version noted in logs.
- **User resumes the same Claude session in another terminal after exit** while the daemon auto-resumes → accepted; same as today's `takeoverCommand` concurrency. Documented.
- **Nullable origin migration** touches many readers → dedicated audit + tests in the server task.
- **Lease TTL** trades crash-recovery latency (≤ 60 s) against heartbeat chatter.

## Migration Plan

Additive Prisma migration (new nullable columns; `originConnectionUuid` nullable). No backfill. Older CLIs simply never create CLI sessions. Rollback: older server ignores new columns; CLI treats 404 on `/cli` routes as "server too old" → warn and launch unsynced.

## Open Questions

- Exact live-tail capability of Pi and Trae interactive modes (verify during implementation; default `on_exit`).
