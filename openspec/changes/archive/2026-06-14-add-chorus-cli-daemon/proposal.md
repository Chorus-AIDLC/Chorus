# Add Chorus CLI daemon core

## Why

The `chorus` npm CLI (`chorus.mjs`) today is **only a Next.js server launcher** — it has no subcommands and no client mode. There is no way for an operation a human performs in the Chorus UI (assigning a task to an agent) to reach a local coding agent. Users who run Claude Code locally must manually poll Chorus and copy task context by hand.

We want the CLI to additionally act as a **lightweight client daemon**: connect to a remote Chorus server as an agent, subscribe to that agent's notification stream, and on `task_assigned` **wake a local headless Claude Code** to do the work — so "operate the Chorus UI" directly drives the local agent.

`../multica` (a Go daemon with WebSocket wakeup that spawns an agent subprocess per task) was the reference, but it is too heavy: an always-on system daemon, per-task isolated workspace directories, repo caches, and garbage collection. We take only its light **spawn-and-capture + resume** core and skip the heavy surroundings. The in-repo OpenClaw plugin (`packages/openclaw-plugin/`) already proves the reusable spine: SSE listener → event-router (route by `notification.action`) → wake. The only OpenClaw-specific piece is the wake call itself (`runEmbeddedAgent`, an in-process host primitive); this change replaces it with a subprocess spawn of `claude` and ports the rest nearly verbatim.

## What Changes

- **New `chorus daemon` subcommand** on the existing CLI: authenticate as an agent, open an SSE subscription to `/api/events/notifications`, and on relevant notifications wake a local headless Claude Code.
- **New `chorus login` subcommand** + layered credential resolution: explicit flags > `CHORUS_URL` / `CHORUS_API_KEY` env > `~/.chorus/daemon.json` (written by `chorus login`) > fallback to the Claude Code chorus plugin's stored url+key. `chorus login` validates the key and echoes the resolved agent identity.
- **Lineage-anchored session continuity**: each inbound event is walked up the Chorus lineage (`task → proposal → idea`, then `idea.parentUuid`) to its **root idea**; the local Claude session id is keyed on that root idea. Same root → `--resume` the same session; new root → fresh session. A local `rootIdea → sessionId` map file persists this.
- **Cross-platform headless spawner**: spawn `claude -p` with `--output-format stream-json --mcp-config <chorus>`, feeding the prompt over **stdin** (not argv) and parsing the NDJSON output. Robust on Windows: resolve the real `claude.cmd` path without `shell:true`, write the MCP config to `os.tmpdir()`, strip `\r` when line-splitting.
- **Reconnect-with-backfill**: on SSE reconnect, fetch unhandled notifications and re-fire wakes (port of the OpenClaw plugin's `onReconnect` logic), so dispatches that arrived while the daemon was briefly disconnected are not lost.

### Out of scope (split to the derived idea & later work)

- The **DaemonConnection** data model, the dedicated "Daemons" management UI page, the real-time transcript-relay panel, heartbeat-timeout offline marking, and the "waiting for daemon" UI badge are all owned by the derived idea **"Daemon 连接可观测与管理"**. This change carries **zero** server/UI/DB changes; it only adds the npm-side daemon and reserves upload hooks (connection-register / session-register / transcript-report) for that derived idea to consume later.
- inbound bidirectional relay (typing in the UI to inject the next Claude turn) is deferred.
- always-on system daemon management (systemd/launchd), per-task workspace isolation, repo caches, and GC — explicitly avoided (multica's "heavy").

## Capabilities

- **cli-daemon** — the `chorus daemon` runtime: notification subscription, lineage→root-idea session mapping, headless Claude spawn + stream-json capture, reconnect backfill, and the reserved upload hooks.
- **cli-auth** — the `chorus login` command and the layered credential/address resolution used by the daemon.

## Impact

- Affected code: `chorus.mjs` (gains subcommand routing); new daemon modules under the CLI surface; reuse of the OpenClaw plugin's SSE/event-router/MCP-client logic as a portable internal module.
- No database migration, no API route changes, no UI changes in this change.
- Dependency posture: **no new npm dependencies** (CLAUDE.md pitfall #9). The daemon shells out to the user's existing `claude` binary; stream-json parsing is plain JS.
- Existing behavior (`chorus` with no subcommand → launch the server) is preserved; `daemon` and `login` are additive subcommands.
