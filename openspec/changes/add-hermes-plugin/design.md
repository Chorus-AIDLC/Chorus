# Design: Chorus plugin for Hermes Agent

## Context

Hermes Agent (Nous Research, Python, tested at commit `2b52acc2d`) has:
- **Native plugins**: `plugin.yaml` + `register(ctx)`. A plugin can register tools, hooks, skills, CLI commands, gateway platforms and approval transports.
- **Portable Agent Plugins**: `plugin.json` + `skills/` + `mcp.json`.
- **An MCP client**: streamable HTTP with headers. Native `mcp_servers` in `config.yaml` expand `${VAR}` everywhere; portable `mcp.json` expands `${VAR}` only in headers, not in `url` (Task 1 spike 5).
- **A long-running messaging gateway**: installable as a systemd or launchd service.
- **Subagents**: `delegate_task`.

Elaboration decided:
- Use a native plugin, without the Chorus daemon.
- Schedule online through the gateway, like OpenClaw.
- One gateway per repository.
- Route approvals through Chorus comments.
- Ship a separate portable MCP package.
- Install from a git subdirectory pinned to a release tag. Hermes `--ref` accepts only a 40-hex SHA, so the tag is resolved to its peeled SHA via `git ls-remote` first (Chorus release tags are lightweight, so the unpeeled fallback is the path that actually answers today).
- Add a `chorus agents add` adapter.
- Match the Codex plugin's hooks.
- Keep an independent skill copy.
- Build reviewers on `delegate_task`.
- Accept on a full AI-DLC run.
- Ship README, connect docs, maintenance skill, and unit tests.

## Goals / Non-goals

**Goals**
- A Hermes user can install both directories, export two environment variables, and run `hermes gateway`. Chorus then shows the agent online and can wake it for every daemon wake action.
- Interactive Hermes sessions (CLI and TUI) get the same check-in, skills and reminders.

**Non-goals**
- A per-wake working directory. One gateway serves one repository; multi-repo needs multiple Hermes profiles or gateways.
- Changes to Hermes core.
- A daemon (`chorus daemon`) spawner for Hermes.
- npm or PyPI publication.

## Layout

```
packages/chorus-hermes/
├── README.md                    # install, configure, troubleshoot, develop
├── chorus/                      # native plugin (plugin.yaml name: chorus)
│   ├── plugin.yaml              # version == root package.json; kind: standalone (there is no "general" kind)
│   ├── __init__.py              # register(ctx): hooks, skills, platform, approval transport
│   ├── chorus_hermes/
│   │   ├── config.py            # env: CHORUS_URL, CHORUS_API_KEY; cwd from terminal.cwd
│   │   ├── mcp_client.py        # minimal JSON-RPC over HTTP to /api/mcp (hooks + adapter only)
│   │   ├── rest.py              # /api/daemon/* calls, {success,data} unwrap
│   │   ├── spec_mode.py         # port of resolve-spec-mode.sh
│   │   ├── hooks.py             # pre_llm_call check-in, transform_tool_result reminders, reviewer guard
│   │   ├── reminders.py         # text ported from plugins/chorus/hooks/on-post-*.sh
│   │   ├── prompts.py           # port of cli/prompts.mjs
│   │   ├── sse.py               # SSE parser + reconnect/backoff + heartbeat ack
│   │   ├── router.py            # wake-routing rules (WAKE_ACTIONS, suppressWake, target)
│   │   ├── adapter.py           # ChorusPlatformAdapter(BasePlatformAdapter)
│   │   ├── turns.py             # turn-advance / execution-state / transcript bookkeeping
│   │   └── approval.py          # chorus approval transport
│   ├── skills/<name>/SKILL.md   # independent copy, Hermes-adapted
│   └── tests/                   # pytest (unit, with fakes for Hermes + HTTP)
└── chorus-mcp/                  # portable package
    ├── plugin.json
    └── mcp.json                 # {"$schema":".../mcp.schema.json","mcpServers":{"chorus":{"type":"streamable-http","url":"http://localhost:8637/api/mcp","headers":{"Authorization":"Bearer ${CHORUS_API_KEY}"}}}}
```

**MCP URL (spike 5).** Portable `mcp.json` URLs are validated without expansion and must be absolute http(s) (HTTP only for loopback), so `${CHORUS_URL}/api/mcp` is rejected and the server dropped. The portable package therefore ships the literal loopback URL of a local Chorus (`http://localhost:8637/api/mcp`) with the key header still `${CHORUS_API_KEY}`. Any other deployment uses a native `mcp_servers.chorus` entry in `~/.hermes/config.yaml` (`url: ${CHORUS_URL}/api/mcp`, `headers.Authorization: Bearer ${CHORUS_API_KEY}`), which Hermes expands and which wins over the portable server of the same name; `chorus agents add` writes that entry (placeholders only, never values) when `CHORUS_URL` is not loopback.

The hooks and the adapter need to call Chorus outside the model's tool loop (check-in, notification re-read, comments for approvals). `mcp_client.py` therefore does stateless JSON-RPC `tools/call` POSTs to `/api/mcp`, which works because Chorus MCP is stateless per request. It uses `httpx`, which Hermes already depends on, so the plugin adds no new dependencies.

## Session lifecycle (Codex parity)

| Codex hook | Hermes mechanism |
|---|---|
| `SessionStart` (`startup\|resume\|clear\|compact`) → `on-session-start.sh` | `pre_llm_call` returns `{"context": block}` on `is_first_turn`, and on the first turn after `on_session_reset` or context compression (tracked per `session_id`). `on_session_start` only warms a check-in cache, because its return value is ignored. |
| `PostToolUse` `.*chorus_pm_submit_proposal` | `transform_tool_result`: appends the reviewer reminder |
| `PostToolUse` `.*chorus_submit_for_verify` | `transform_tool_result`: appends the task-reviewer reminder |
| `PostToolUse` `.*chorus_admin_verify_task` | `transform_tool_result`: branches A, C and B from `on-post-verify-task.sh`, which query the proposal and its tasks through `mcp_client` |

`post_tool_call` is an observer and cannot reach the model, so the reminders use `transform_tool_result`. All callbacks are wrapped so that an exception falls back to the original value, and each one stays well under `plugins.hook_callback_timeout` (default 30s).

## Skills and reviewers

`register_skill` exposes skills as `chorus:<name>`. These are not listed in the system prompt's `<available_skills>`, so the session-start Quick Reference names them and tells the model to call `skill_view("chorus:<name>")`.

The skills start from `packages/chorus-pi/skills` and are adapted:
- human questions become elaboration rounds and comments;
- sub-agents become `delegate_task(goal, context)`;
- Claude- and Codex-specific paths are removed.

**Reviewers.** Reminders tell the parent to call `delegate_task` with a `context` that begins with the marker `[chorus-reviewer:<kind>]` and asks the child to `skill_view("chorus:chorus-<kind>-reviewer")`.
- `subagent_start` records the child `session_id`s whose goal or context carries the marker.
- `pre_tool_call` blocks write tools for those sessions: everything except Chorus read tools, `chorus_add_comment`, `read_file`, `search_files` and `skill_view`.
- `subagent_stop` clears the record.

## Gateway scheduling

The wire protocol follows OpenClaw's `daemon-client.ts`, plus the parts of the CLI daemon that OpenClaw lacks: `livenessAck`, the directed-wake check (`suppressWake` / `targetConnectionUuid`), and `markQueued`. The endpoints are listed in the `hermes-gateway-scheduling` spec.

```
gateway start → adapter.connect()
  spawn_task(sse_loop)
    GET /api/events/notifications?clientType=hermes&livenessAck=v1&host&cwd&startedAt&clientVersion
    connection_registered → store ids → sweep pending-turns
    ": heartbeat" → POST connection-heartbeat
    new_notification → router.accept()? → prompts.build() → dispatch(chat_id=idea:<uuid>)
    control → deliver_turn | interrupt | resume (own connectionUuid only)
dispatch → turns.start (turn-advance running, execution-state)
         → adapter.handle_message(MessageEvent(text, source=build_source(chat_id)))
         → on_processing_complete(event, outcome) → turns.finish
```

**Turn completion detection (spike 2).** The adapter overrides `BasePlatformAdapter.on_processing_complete(event, outcome)`, which `_process_message_background` calls once per turn after the final reply is sent: `SUCCESS` → `ended`; `CANCELLED` (expected cancel, e.g. `/stop`) → `interrupted`; `FAILURE` (handler exception or failed delivery) → `interrupted/crash` with a `wakeError`. `on_processing_start` marks the start. No override of `_process_message_background` is needed, since the base class already turns exceptions into `FAILURE`. The `agent_loop_stopped` hook (`session_key`, `reason`) supplies the interrupt reason. Provider errors that the runner renders as reply text arrive as `SUCCESS`. The adapter MUST therefore watch `api_request_error` per session, and when that session's turn completes with such an error recorded, report `interrupted/crash` with a `wakeError` of kind `execution`.

**Authorization.** The gateway authorizes the sender of each event. Every event the adapter builds uses the agent owner's uuid as `user_id`. At connect time the adapter seeds `self.config.extra["allow_from"] = [<owner uuid>]` (taken from `chorus_checkin`); with no env allowlist the gateway authorizes senders in the adapter's `extra.allow_from` (spike 2), so no manual allowlist step is needed. `CHORUS_ALLOWED_USERS` (`allowed_users_env`) or `GATEWAY_ALLOWED_USERS` remain overrides; when set they replace the seeded list and must contain the owner uuid. `is_connected` (both env vars set) auto-enables the platform, so only `plugins.enabled` is required, not `platforms.chorus.enabled` (spike 4).

**Working directory.** The adapter reports `cwd = realpath(terminal.cwd)`. When `terminal.cwd` is unset, it refuses to connect and logs guidance; it never silently reports `$HOME`.

## Approval transport

`register_approval_transport("chorus", present)`:
- `ApprovalRequest` carries no session key and `present()` runs on a separate thread without the caller's contextvars (spike 3). The plugin therefore registers a `pre_approval_request` hook, which the host fires synchronously right before invoking the transport with `session_key`, `request_id` and `request_digest`, and records `request_id → session_key`. `present(request)` looks up `request.request_id`.
- It maps the key back to the Chorus entity stored for that session. Returning `None` is not a fallback (the host treats it as `invalid` → deny). Requests without a mapping (e.g. interactive CLI sessions) raise, which the host turns into the built-in prompt only when `security.approval.transport_fallback: builtin` is set (the docs recommend it), otherwise deny.
- It posts a comment: `@owner Approval needed (token ABC123) … reply "approve once ABC123" / "approve session ABC123" / "deny ABC123"`.
- It awaits a future that the SSE router resolves when a `mentioned` or `comment_added` notification on that entity carries the token from the owner. Those notifications are matched by re-reading `chorus_get_comments`.
- Timeout returns `deny`.
- Approval replies never start a model turn. Before dispatching a `mentioned` / `comment_added` wake, or a pending turn with trigger `mentioned` (Chorus stores @mention replies as pending turns, `src/services/notification-turn.ts`, and the reconnect sweep would otherwise replay them), the router re-reads the triggering comment. A comment matching `^(approve (once|session|always)|deny) [A-Z0-9]{6}` goes to the transport, and the pending turn is closed `ended` without running the agent.

## `chorus agents add`

- `cli/init/adapters.mjs` gets the descriptor `{id:"hermes", displayName:"Hermes", binaries:["hermes"], configDirs:["~/.hermes"], readState: readHermesInstallState, install: installHermes}`.
- `readHermesInstallState` parses `hermes plugins list --json` if available, otherwise checks for `~/.hermes/plugins/chorus/plugin.yaml`.
- `installHermes` resolves `v<version>` to its peeled SHA (`git ls-remote https://github.com/Chorus-AIDLC/Chorus.git 'refs/tags/v<version>^{}'`, falling back to the unpeeled ref for lightweight tags; it fails closed if unresolved). It then runs the two `hermes plugins install Chorus-AIDLC/Chorus/packages/chorus-hermes/<dir> --ref <sha> --enable` commands (the shorthand combines with `--ref`, spike 6), idempotently (it skips unless `updateInstalled`), and prints the post-install checklist. The SHA is never committed, since a release commit cannot contain its own SHA. The README shows the same resolve-then-install commands for manual installs.
- `agent-type-map.mjs` adds `hermes: "offline"`.
- Server: `DAEMON_CLIENT_TYPES += "hermes"`; a presence label `clientHermes` in all four locale files; `WAKE_ERROR_SOURCES += "hermes"`.

## UI

`AgentInstallGuide.tsx` gets a Hermes tab, using the same structure as the Pi and dsh tabs:
1. Install Hermes.
2. `chorus agents add --agents hermes`.
3. Configure and start the gateway.

i18n keys go in `messages/{en,zh,ja,ko}.json`, and the tab uses semantic tokens only, so both themes work. `docs/design.pen` is updated with the new tab.

## Risks / spikes (Task 1)

Outcomes are recorded in `packages/chorus-hermes/README.md` ("Hermes compatibility notes"); summary: (1) yes, a `kind: standalone` plugin may call `register_platform` (`general` is not a kind); (2) `on_processing_complete`; (3) `pre_approval_request` hook correlation by `request_id`, `None` = deny; (4) `plugins.enabled` only; (5) no `${VAR}` in portable `url`, headers yes; (6) `provides_*` declaration matching and built-in tool collisions are catalog-only, the security scan is enforced at install (`caution` blocks community sources), and `owner/repo/subdir` works with `--ref`.

1. Whether a `kind: general` plugin may call `register_platform`, or whether the platform must be a second `kind: platform` plugin directory. If so, the native directory splits into `chorus/` + `chorus-platform/` and the install docs list three directories.
2. The exact override points for turn completion and crash detection in `BasePlatformAdapter`.
3. The API that exposes the current session key to the approval transport.
4. Whether user platform plugins need `plugins.enabled` in addition to `platforms.chorus.enabled`.
5. Whether portable `mcp.json` `${VAR}` expansion works in `url` as well as in `headers`.
6. Which `hermes plugins validate` rules are catalog-admission-only, and whether `owner/repo/subdir` shorthand combines with `--ref <sha>`. If not, `chorus agents add` writes the literal URL (it is not a secret) and keeps the key as a placeholder.

Each finding is recorded in the README's "Hermes compatibility notes", and the later tasks adapt to it.

## Testing

- **pytest** under `packages/chorus-hermes/chorus/tests`, with fakes for `ctx`, `BasePlatformAdapter` and an HTTP mock (`httpx.MockTransport`). Coverage:
  - SSE parsing and backoff
  - routing rules
  - turn reporting order
  - approval correlation and timeout
  - reminder branches
  - spec-mode resolution
  - prompt parity: `node` renders the fixtures through `cli/prompts.mjs`, and pytest compares the output
- **vitest** for the server enum, the presence label, and the CLI adapter (`cli/__tests__/init-*.test.mjs`).
- **Package checks**: version sync, no secrets, no foreign tool references in skills.
- **End-to-end** on the local Hermes instance: run the gateway, assign an Idea to the Hermes agent, and drive elaboration → proposal → task → verify with Chorus-triggered wakes. The run is recorded in the task report.
