# Chorus for Hermes Agent

Chorus integration for [Hermes Agent](https://github.com/NousResearch/hermes-agent)
(Nous Research). Two independently installable directories:

| Directory | Hermes plugin type | What it provides |
|---|---|---|
| `chorus/` | native plugin (`plugin.yaml` + `register(ctx)`) | session check-in and reminders, Chorus skills, the `chorus` gateway platform, the `chorus` approval transport |
| `chorus-mcp/` | portable Agent Plugins v1 package (`plugin.json` + `mcp.json`) | the `chorus` MCP server, so the model gets `mcp__chorus__*` tools |

> Status: skeleton. The native plugin currently registers nothing; hooks, skills,
> the gateway platform and the approval transport land in follow-up tasks.

Compatibility is pinned to Hermes commit `2b52acc2d`.

## Install

Hermes `--ref` accepts only a full 40-character commit SHA, so resolve the
release tag first. Chorus release tags are **lightweight**, so the peeled
`^{}` query returns nothing for them and the unpeeled ref is the one that
answers; keep both lines.

```bash
VERSION=0.21.1   # the Chorus release you want
REPO=https://github.com/Chorus-AIDLC/Chorus.git
SHA=$(git ls-remote "$REPO" "refs/tags/v$VERSION^{}" | cut -f1)
[ -n "$SHA" ] || SHA=$(git ls-remote "$REPO" "refs/tags/v$VERSION" | cut -f1)
[ -n "$SHA" ] || { echo "error: tag v$VERSION not found on $REPO" >&2; exit 1; }

hermes plugins install Chorus-AIDLC/Chorus/packages/chorus-hermes/chorus     --ref "$SHA" --enable
hermes plugins install Chorus-AIDLC/Chorus/packages/chorus-hermes/chorus-mcp --ref "$SHA" --enable
hermes plugins list --plain --no-bundled   # both: enabled  git pinned@<sha8>
```

Never install unpinned; if the tag does not resolve, stop.

## Configure

Credentials are read only from the environment (or `~/.hermes/.env`):

```bash
export CHORUS_URL=https://chorus.example.com     # no trailing /api/mcp
export CHORUS_API_KEY=<your cho_ agent key>
```

**MCP URL.** Portable `mcp.json` URLs are not env-expanded (see note 5), so
`chorus-mcp/mcp.json` ships the literal loopback URL
`http://localhost:8637/api/mcp` (a local `pnpm dev` Chorus). For any other
deployment add a native entry, which Hermes *does* expand and which wins over
the portable server of the same name:

```bash
hermes config set mcp_servers.chorus.url '${CHORUS_URL}/api/mcp'
hermes config set mcp_servers.chorus.headers.Authorization 'Bearer ${CHORUS_API_KEY}'
```

The single quotes matter: the config stores the `${VAR}` placeholders, never the
values. With the native entry present Hermes logs
`Portable MCP server 'chorus' conflicts with native config; skipping` — expected.

**Gateway working directory.** Set `terminal.cwd` in `~/.hermes/config.yaml` to
the repository this gateway serves. The plugin reports `realpath(terminal.cwd)`
to Chorus and refuses to connect when it is unset or a placeholder (`.`, `auto`,
`cwd`).

**Approvals through Chorus.** To answer dangerous-command approvals of
Chorus-woken gateway turns from Chorus, select the plugin's transport and keep
the built-in prompt for everything else:

```bash
hermes config set security.approval.transport chorus
hermes config set security.approval.transport_fallback builtin   # required for CLI/TUI prompts
hermes config set approvals.timeout 300                          # seconds; no reply = deny
hermes config set approvals.mode manual   # optional: the default "smart" guardian may approve first
```

With the default `approvals.mode: smart`, Hermes' guardian model decides
low-risk commands itself and only escalates the rest to a human, so a command
may run without a Chorus approval comment. Use `manual` to have every flagged
command go to the owner.

When a woken turn needs approval, the agent comments on the Chorus entity it is
working on, @mentioning you, with the redacted command, the allowed replies and a
6-character token. Reply on that entity with `approve once <token>`,
`approve session <token>` (when offered), `approve always <token>` (when
offered) or `deny <token>`. Only the agent owner's reply counts; any other owner
reply carrying the token denies, and no reply within `approvals.timeout` denies.
Approval replies never start a new agent turn. Sessions that were not started by
a Chorus wake (interactive CLI/TUI, other gateway platforms) are declined by the
transport, so without `transport_fallback: builtin` Hermes denies them instead of
prompting.

## Develop

```bash
python -m pytest packages/chorus-hermes/chorus/tests     # needs pytest, httpx, pyyaml
hermes plugins validate packages/chorus-hermes/chorus
hermes plugins validate packages/chorus-hermes/chorus-mcp
```

Tests use fakes only (a recording `ctx`, `httpx.MockTransport`) and never import
Hermes. Package checks: `plugin.yaml` / `plugin.json` versions equal the root
`package.json` version (bumped by the release skill), no `cho_…` key and no
commit SHA is committed, and `mcp.json` exists only in `chorus-mcp/`.

Shared modules in `chorus/chorus_hermes/`:

- `config.py` — `CHORUS_URL` / `CHORUS_API_KEY` / `CHORUS_ALLOWED_USERS` from the
  environment; `terminal_cwd()` from the Hermes config.
- `mcp_client.py` — stateless JSON-RPC `tools/call` to `/api/mcp` over httpx
  (sync and async; JSON or SSE replies; no `initialize` needed because Chorus MCP
  is stateless per request).
- `rest.py` — Chorus REST calls with `{success, data}` unwrapping.

## Hermes compatibility notes

Verified against Hermes `2b52acc2d` (`~/.hermes/hermes-agent`). Paths are
relative to the Hermes checkout.

### 1. Can a general plugin call `register_platform`? — Yes, one directory suffices

- There is no `kind: general`. Valid kinds are
  `standalone|backend|exclusive|platform|model-provider`
  (`hermes_cli/plugins_manifest.py:27`); an unknown kind is logged and treated as
  `standalone` (`plugins_manifest.py:505-512`). Measured: a plugin with
  `kind: general` logged `unknown kind 'general' (valid: ...); treating as
  'standalone'`. `chorus/plugin.yaml` therefore declares `kind: standalone`.
- `PluginContext.register_platform` has no kind check
  (`hermes_cli/plugins.py:808-837`). `kind: platform` only changes *bundled*
  plugins to lazy loading (`hermes_cli/plugins_discovery.py:295`).
- Measured with a throwaway standalone user plugin calling
  `ctx.register_platform("chorusspike", ...)`: after `hermes plugins enable`,
  `platform_registry.get("chorusspike")` returned
  `('chorusspike', 'plugin', 'chorus-spike')` and `load_gateway_config()` had the
  platform enabled. No `chorus-platform/` split is needed.

### 2. Turn completion and crash override points in `BasePlatformAdapter`

- `on_processing_complete(event, outcome)` (`gateway/platforms/base.py:3535`,
  `ProcessingOutcome` = `SUCCESS|FAILURE|CANCELLED` in
  `gateway/platforms/event.py:37`) is the single completion hook. It is called by
  `_process_message_background` (`base.py:4563`) after the final reply has been
  sent (`base.py:4646`, `SUCCESS`, or `FAILURE` when delivery failed), on
  cancellation (`base.py:4656`: `CANCELLED` for an expected cancel such as `/stop`,
  otherwise `FAILURE`), and when the handler raises (`base.py:4661`, `FAILURE`,
  followed by `_notify_turn_error` at `base.py:4422`, which `send()`s a warning).
- `on_processing_start(event)` (`base.py:3532`) marks turn start.
- `agent_loop_stopped` is a plugin hook (`hermes_cli/plugins.py:140-143`,
  fired from `gateway/run_agent_cache.py:511`) with `session_key, platform,
  reason`; use it to tag interrupt reasons.
- Plan change: override `on_processing_complete` instead of wrapping
  `_process_message_background`; the base class already converts exceptions into
  `FAILURE`. Caveat: provider/model errors that the runner turns into a reply text
  arrive as `SUCCESS`; the adapter should also watch the `api_request_error`
  hook keyed by session if it needs to distinguish them.
- Authorization: with no env allowlist, the gateway accepts senders listed in the
  adapter's `config.extra["allow_from"]` (`gateway/authz_mixin.py:482-507`,
  reached from `authz_mixin.py:667-675`), so the adapter seeds
  `extra["allow_from"] = [<owner uuid>]` at connect. If the operator sets
  `GATEWAY_ALLOWED_USERS` or `CHORUS_ALLOWED_USERS` (the entry's
  `allowed_users_env`), that list is used instead and must contain the owner uuid.
  `authorization_is_upstream` (`base.py:2064`, honored at `authz_mixin.py:537-541`)
  is documented as relay-only; we do not use it.

### 3. How the approval transport gets the current session key

- `ApprovalRequest` carries no session key (`hermes_cli/approval_transport.py:41-53`);
  the key is only folded into `digest` (`approval_transport.py:72`).
- `present()` runs on a fresh daemon thread under `asyncio.run`
  (`approval_transport.py:124-139`); `threading.Thread` does not copy
  contextvars, so `tools.approval_context.get_current_session_key()`
  (`tools/approval_context.py:103`) is not reliable inside `present()`.
- The host fires `pre_approval_request` **synchronously, immediately before**
  invoking the transport, with `session_key`, `request_id` and `request_digest`
  (`tools/approval_prompt.py:236-247`). The transport therefore records
  `request_id -> session_key` in a `pre_approval_request` hook and looks it up in
  `present(request)` by `request.request_id`.
- Returning `None` is not a fallback: a non-`ApprovalDecision` result is
  `invalid` and becomes `deny` (`approval_transport.py:177-179`). The built-in
  prompt is reached only when the operator sets
  `security.approval.transport_fallback: builtin`
  (`tools/approval_context.py:321-333`, `approval_prompt.py:_transport_choice`).
  Unmapped requests (e.g. interactive CLI sessions) therefore raise, which yields
  `error` → builtin fallback when enabled, otherwise deny. The README for the
  transport will recommend `transport_fallback: builtin`.

### 4. Is `plugins.enabled` needed in addition to `platforms.chorus.enabled`? — `plugins.enabled` yes, `platforms.chorus.enabled` no

- Every non-bundled plugin must be in `plugins.enabled`
  (`hermes_cli/plugins_discovery.py:297-301`); `hermes plugins install --enable`
  writes it.
- Plugin platforms are auto-enabled when the entry's `is_connected` passes and
  `check_fn` is true (`gateway/config_env.py:396-430`, `441-450`). The adapter
  registers `is_connected` = `CHORUS_URL` and `CHORUS_API_KEY` set, so no
  `platforms.chorus` block is required. An explicit `platforms.chorus.enabled:
  false` is respected (`config_env.py:404-405`). Measured with the spike plugin:
  enabled in `load_gateway_config()` without any `platforms:` entry.

### 5. Does portable `mcp.json` expand `${VAR}` in `url`? — No (headers: yes)

- `_validate_remote_url` documents "No expansion" and requires an absolute
  `http(s)` URL (`hermes_cli/agent_plugins.py:293-318`); HTTP is allowed only for
  `localhost`/loopback. Measured: `"url": "${CHORUS_URL}/api/mcp"` →
  `hermes plugins validate chorus-mcp` printed
  `⚠ mcp:chorus: url scheme must be http or https` and the server was dropped.
- Headers are validated without expansion (`agent_plugins.py:284-290`) and
  interpolated at connect time (`tools/mcp_tool_discovery.py:161`,
  `tools/mcp_tool_config.py:348-363`); an unresolved `${VAR}` fails closed
  (`mcp_tool_config.py:365-379`).
- Native `mcp_servers` in `config.yaml` *are* interpolated, including `url`
  (`mcp_tool_config.py:441-460`), and win over a portable server of the same name
  (`mcp_tool_config.py:426-438`).
- Plan change: `chorus-mcp/mcp.json` ships `http://localhost:8637/api/mcp` with
  `Authorization: Bearer ${CHORUS_API_KEY}`; non-loopback deployments add the
  native `mcp_servers.chorus` entry shown above. `chorus agents add --agents hermes`
  writes it into `$HERMES_HOME/config.yaml` when `CHORUS_URL` is not the loopback
  default (literal `<CHORUS_URL>/api/mcp` URL, header kept as the
  `Bearer ${CHORUS_API_KEY}` placeholder, other config preserved, idempotent).
- Measured (live, `CHORUS_URL` = a remote Chorus):
  - native entry: `hermes chat -Q -q "Call ... chorus_checkin ..."` →
    `TOOL=mcp__chorus__chorus_checkin AGENT_NAME=Clay AGENT_UUID=00fc5c33-6c04-4516-af2c-0715221d5ad2`.
  - portable package alone (native entry removed, a throwaway loopback proxy on
    `127.0.0.1:8637` forwarding to `CHORUS_URL`): same answer; the proxy saw
    `POST /api/mcp 200` with the `Authorization` header present, proving the
    portable header expansion.

### 6. `hermes plugins validate` rules and `owner/repo/subdir` + `--ref`

- `validate` is the catalog-admission CI gate (`hermes_cli/plugin_validate.py:1-11`,
  checks listed at `plugin_validate.py:469-505`). Rules that only matter for
  catalog admission (the runtime loader and `hermes plugins doctor` do not enforce
  them): **declared tools/hooks/middleware** must equal what `register()`
  registers (`plugin_validate.py:375-438`; the `provides_*` lists), and
  **built-in tool collisions** (`plugin_validate.py:444-466`). The later tasks keep
  `provides_hooks` in sync anyway so validate stays green.
- Not catalog-only: the **security scan** also runs at install, and an install from
  any git source is `community` trust (`tools/plugin_guard.py:327-341`), where a
  `caution` verdict is **blocked** without `--force` (measured below). Both
  directories must keep scanning `safe`.
- Portable `mcp.json` problems are only *warnings* in validate
  (`plugin_validate.py:_validate_portable_plugin`): "Validation passed" was
  printed even while the `chorus` server was dropped (note 5). Watch the `⚠` lines.
- Current result: `hermes plugins validate packages/chorus-hermes/chorus` and
  `.../chorus-mcp` both print `Validation passed.` with no warnings;
  `hermes plugins doctor chorus|chorus-mcp` → `OK: runtime discovery, manifest
  parsing, import, and registration passed`.
- `owner/repo/subdir` shorthand combines with `--ref <sha>`: the identifier is
  resolved to `(git_url, subdir)` independently of the revision
  (`hermes_cli/plugins_cmd.py:307-312`) and both are passed to
  `_clone_plugin_repo` (`hermes_cli/plugins_cmd_install.py:339-358`,
  `plugins_cmd_git.py:215`), which does a blobless sparse clone of the subdir at
  that SHA. Measured against GitHub:
  `hermes plugins install Chorus-AIDLC/Chorus/packages/chorus-cdk --ref <40-hex SHA of v0.21.1, d2136dc3…> --no-enable`
  printed `Cloning https://github.com/Chorus-AIDLC/Chorus.git (subdir:
  packages/chorus-cdk)...`, checked out the pinned subdir, and stopped at the
  security scan (`Decision: BLOCKED — Blocked (community source + caution
  verdict, 5 findings)`; nothing installed). So `chorus agents add` can use the
  shorthand; it does not need the literal URL.
- The install directory name is the manifest `name` (`plugins_cmd_install.py:365`):
  `~/.hermes/plugins/chorus` and `~/.hermes/plugins/chorus-mcp`.
- Also accepted: `<url>#<subdir>` and `<url>.git/<subdir>` (`plugins_cmd.py:297-304`).

### Resolve-then-install run (local repo)

`packages/chorus-hermes` is not on GitHub yet, so the SHA flow was exercised
against the local repository with a local WIP commit and a temporary
**lightweight** tag (deleted afterwards, never pushed). Real Chorus tags are
lightweight too: `git cat-file -t v0.21.1` → `commit`, and
`git ls-remote https://github.com/Chorus-AIDLC/Chorus.git 'refs/tags/v0.21.1^{}' 'refs/tags/v0.21.1'`
returns only `d2136dc3…<40 hex> refs/tags/v0.21.1` (no `^{}` line).

```text
$ REPO=file:///home/felix/dev/Chorus TAG=v0.21.1-hermes-wip
$ SHA=$(git ls-remote "$REPO" "refs/tags/$TAG^{}" | cut -f1)        # -> '' (lightweight)
$ [ -n "$SHA" ] || SHA=$(git ls-remote "$REPO" "refs/tags/$TAG" | cut -f1)
SHA=35fd9a11…   # 40 hex chars; full SHA elided, no SHA is committed
$ hermes plugins install "$REPO#packages/chorus-hermes/chorus" --ref "$SHA" --enable --force
Cloning file:///home/felix/dev/Chorus (subdir: packages/chorus-hermes/chorus)...
✓ Installed  file:///home/felix/dev/Chorus#packages/chorus-hermes/chorus
             Location: /home/felix/.hermes/plugins/chorus
$ hermes plugins install "$REPO#packages/chorus-hermes/chorus-mcp" --ref "$SHA" --enable --force
Cloning file:///home/felix/dev/Chorus (subdir: packages/chorus-hermes/chorus-mcp)...
✓ Installed  file:///home/felix/dev/Chorus#packages/chorus-hermes/chorus-mcp
             Location: /home/felix/.hermes/plugins/chorus-mcp
✓ Plugin chorus-mcp enabled.
$ hermes plugins list --plain --no-bundled
enabled      git pinned@35fd9a11 0.21.1   chorus
enabled      git pinned@35fd9a11 0.21.1   chorus-mcp
$ git tag -d v0.21.1-hermes-wip
```

Unknown tag (fail closed, nothing installed):

```text
$ T=v9.9.9-missing; SHA=$(git ls-remote "$REPO" "refs/tags/$T^{}" | cut -f1)
$ [ -n "$SHA" ] || SHA=$(git ls-remote "$REPO" "refs/tags/$T" | cut -f1)
$ [ -n "$SHA" ] || echo "error: tag $T not found on $REPO; nothing installed"
error: tag v9.9.9-missing not found on file:///home/felix/dev/Chorus; nothing installed
```
