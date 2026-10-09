# chorus-pi — Chorus AI-DLC extension for the Pi coding agent

Chorus AI-DLC collaboration platform extension for [Pi](https://pi.dev). Ported from the Claude Code plugin (`public/chorus-plugin/`) and the Codex port (`plugins/chorus/`) following the same methodology documented in `docs/codex-plugin-plan.md`.

## What this package provides

- **12 skills** — `/skill:chorus`, `/skill:idea`, `/skill:proposal`, `/skill:develop`, `/skill:review`, `/skill:quick-dev`, `/skill:yolo`, `/skill:brainstorm`, `/skill:orchestrate`, `/skill:docs`, `/skill:chorus-cli`, `/skill:openspec-aware`
- **3 read-only reviewer sub-agents** — `chorus-proposal-reviewer`, `chorus-task-reviewer`, `chorus-code-reviewer`
- **1 worker sub-agent** — `chorus-worker`, a general-purpose Chorus implementer that claims and completes ONE task via the develop workflow (dispatch it with the `subagent` tool, single or parallel mode, for wave-based execution)
- **1 session-aware extension** (`extensions/chorus.ts`) — subscribes to Pi native events to automate checkin, context injection, reviewer nudges, and session lifecycle
- **The official pi subagent pattern** bundled at `extensions/subagent/` (the `subagent` tool + package-relative agent discovery)

## Supported hosts

The maintained range is stable Pi `>=0.84.4 <2.0.0` (Node >=22.19.0).
Pi >=0.99.0 uses native MCP; Pi 0.84.4–0.98.x uses the verified
`pi-mcp-adapter@5.0.0`, not an unbounded adapter update. The package is tested
as a packed artifact on isolated SDKs 0.84.4, 0.87.1, 0.99.0, and 1.0.2.
Prereleases, older hosts and Pi 2.x are not declared supported.

Legacy sessions must expose Chorus tools directly (`directTools: true` in
the adapter's Chorus server entry) for parent workflow reminders. Packaged
children instead load their role providers explicitly: `chorus_review` for
query/checkin/comment access, and `chorus_work` for task execution. They do not
require native or adapter gateway names. Existing adapter installations are
never automatically removed.

From the repository root, prepare isolated SDK installations and run:

```sh
node packages/chorus-pi/test/compat-matrix.mjs --artifact /absolute/path/to/chorus-pi.tgz
```

The runner expects `/tmp/chorus-pi-compat-<version>/node_modules` by default;
use `--roots` or `CHORUS_PI_SDK_ROOTS` to override. Both legacy installations
must include adapter 5.0.0; neither native installation may include it. The
36 scenarios use dummy credentials, local MCP fixtures and a deterministic
model, including actual bundled reviewer/worker CLI children. A missing host
or failed scenario fails verification; no production account is needed.

## Install

### Pi >=0.99.0: native MCP

Within the supported host range, use native MCP from Pi 0.99.0 onward.
The native path is verified on Pi 0.99.0 and 1.0.2. Install the Chorus package, export the
connection variables, and add the server with Pi's built-in CLI:

```bash
pi install npm:@chorus-aidlc/chorus-pi

export CHORUS_URL="https://your-chorus-instance.example"
export CHORUS_API_KEY="cho_your_key"
export CHORUS_AGENT_PROFILE="your-agent-profile"

pi mcp add chorus --url "${CHORUS_URL%/}/api/mcp" --bearer-token-env-var CHORUS_API_KEY
pi mcp list
```

The command writes the user-level `~/.pi/agent/mcp.json` with an
environment-referenced Authorization header. Native project configuration
lives in `.pi/mcp.json` (add `--local` to `pi mcp add`) and requires project
trust. Export `CHORUS_URL` and `CHORUS_API_KEY` for Chorus's own checkin/session
bookkeeping too when using native project `.pi/mcp.json`, which its fallback
does not discover. Global setup can instead discover the URL from the
version-appropriate file with `CHORUS_API_KEY` exported; the agent-dir override
is honored and explicit environment values take precedence.

If `pi-mcp-adapter` is already installed, Chorus warns but never removes it.
If you choose native MCP, manually remove it from its actual global or project
scope (for a global npm install, `pi remove npm:pi-mcp-adapter`). Also manually
remove any `"-builtin:mcp"` entry from that scope's `extensions` setting,
preserving unrelated entries and filters, then restart Pi. An
extension that registers `/mcp` replaces Pi's built-in MCP support in sessions;
shell `pi mcp list` always uses the built-in implementation, so that command
alone does not establish which route a running session uses.

Native MCP defaults to **codemode** exposure. Every native MCP subcall passes
through Pi's `tool_call` and `tool_result` pipeline with the real
`mcp__<server>__<tool>` name. Codemode child events also carry the enclosing
call's `parentToolCallId`; native codemode does expose these child events.
The Chorus workflow matcher uses each event's outer `toolName`, including
child events, and accepts any prefix ending exactly in
`chorus_pm_submit_proposal`, `chorus_submit_for_verify`, or
`chorus_admin_verify_task`. It never parses `input.tool` or script text.

An eligible successful child result emits its existing enabled reviewer
steering reminder. The enclosing `codemode` result adds no duplicate, and
failure/configuration gates and reviewer switches still apply. **There is no
requirement to force `direct` exposure**; direct native MCP events use the same
matcher. This event contract is documented in the installed Pi 1.0.2
`docs/mcp.md` Permissions section and `docs/extensions.md` nested-tool guidance.

Run the native host probe from a repository checkout with an installed Pi 1.x
(the npm package does not include the test files):

```bash
cd packages/chorus-pi
node test/pi1-native-mcp.mjs
# If Pi is not globally installed:
PI_SDK_DIR=/path/to/@earendil-works/pi-coding-agent node test/pi1-native-mcp.mjs
```

The [probe](test/pi1-native-mcp.mjs) drives real Pi sessions, native MCP and
QuickJS codemode against a local stdio fixture. It checks actual tool events,
parent IDs and reviewer steering messages across codemode/direct, individual
reviewer switches, missing Chorus configuration, failures and non-target names.
The model supplies deterministic tool calls; no model-provider credentials or
real Chorus business operations are involved. These SDK results supplement the
existing mocked offline tests and do not claim a production workflow transition.
This native-MCP probe covers parent transport/event behavior, not the new child
role-provider contract. Packaged reviewer lists no longer require native
`codemode`/`tool_search` or expand the parent's MCP tools. See
`test/agents.test.ts` for role-provider registration, agent-relative paths,
override precedence and bundled launcher argument regressions. Their read-only
project policy is unchanged.

### Legacy adapter route

For supported Pi versions below 0.99.0, use the verified adapter:

```bash
# Legacy MCP adapter
pi install npm:pi-mcp-adapter@5.0.0

# this package
pi install npm:@chorus-aidlc/chorus-pi
```

The adapter's default single `mcp` proxy does not expose an operation in the
outer tool name, so it does not trigger the three reviewer reminders with this
package. Use native MCP above, or configure the adapter to expose direct tools.
This limitation applies to the old adapter proxy, not native codemode.

Adapter5's primary global file is `~/.pi/agent/mcp-adapter.json` (or
`$PI_CODING_AGENT_DIR/mcp-adapter.json`), not native `mcp.json`. Configure
`mcpServers.chorus.directTools: true` with an env-referenced Authorization
header. Existing explicit exposure choices are preserved. Native project
`.pi/mcp.json` and the adapter's legacy discovery/import paths are not equivalent.
The extension's HTTP bookkeeping and child role tools select configuration from
the active MCP backend, including adapter5 on modern Pi. Adapter sessions read
project `.pi/mcp-adapter.json`, root `.mcp.json`, then the global adapter primary;
retained global native `mcp.json` cannot shadow an existing adapter primary.
Native sessions keep native discovery precedence and ignore stale adapter files.
Explicit environment values override file discovery; a complete file-based
connection does not require duplicate `CHORUS_URL` / `CHORUS_API_KEY` exports.
Unresolved environment credentials are not sent. No configuration is rewritten.

The `subagent` tool ships inside this package (pi's
official subagent reference pattern, at `extensions/subagent/`), and the three
reviewer agents are discovered directly from the package's own `agents/` dir —
there is **no** separate subagents dependency and **no** manual copy of agent
files into `~/.pi/agent/agents/`.

For the legacy adapter configuration and env vars, see
[`docs/CONNECT_PI.md`](../../docs/CONNECT_PI.md).

`chorus init` (a.k.a. `chorus agents add`) selects the backend from the stable
host version: native hosts install Chorus only and write global `mcp.json`;
legacy hosts install adapter5 first and write `mcp-adapter.json`. Fresh legacy
Chorus entries enable direct tools. When the adapter primary is absent, old
global `mcp.json` can seed it without changing the source; existing primary
files win and malformed/unreadable files are not overwritten. Other servers
and explicit exposure settings survive. Chorus credentials use
`Bearer ${CHORUS_API_KEY}`, not literal keys, with atomic 0600 writes.

`chorus upgrade --plugins` and `chorus init --update-installed` use the same
backend policy and targeted operations, never an all-extension update. The
verified adapter5 policy pin is retained; other adapter constraints and Chorus
pins/ranges are preserved and reported incomplete where incompatible with the
requested refresh. Native adapter pins do not prevent Chorus-only package
completeness, but conflict warnings still require manual attention.

Unknown/prerelease host versions never trigger speculative adapter changes or
an MCP-complete claim. Hosts below 0.84.4 or at/above 2.0.0 are unsupported and
receive no package operations; missing Pi gets conditional manual guidance.
Writing config is not a connectivity guarantee. Export `CHORUS_URL`,
`CHORUS_API_KEY` and optionally `CHORUS_AGENT_PROFILE` when launching interactive
Pi; the daemon injects them for wakes.

## Child role tools

All three reviewers declare `read, grep, find, ls, bash, chorus_review`; the
worker declares the same local tools plus `edit, write, chorus_work` instead of
`chorus_review`. Their agent-relative `subagentOnlyExtensions` loads
`../lib/child-review.ts` or `../lib/child-work.ts` with nicobailon `pi-subagents`
and the bundled dispatcher. The latter resolves paths against the agent file
and passes each via `-e`, separately from `--tools`. User/project agent overrides
retain precedence; if you copy an agent elsewhere, update its provider path.

Children use the role gateway for **all** Chorus access, on both native MCP and
adapter5 hosts (including default script mode), without changing user MCP config:

```js
chorus_review({ action: "discover" })
chorus_review({ action: "call", tool: "chorus_get_task", arguments: { taskUuid: "<uuid>" } })
chorus_work({ action: "discover" })
chorus_work({ action: "call", tool: "chorus_report_work", arguments: { taskUuid: "<uuid>", report: "Implemented and tested" } })
```

Discovery returns actual allowed remote schemas; use them for call arguments.
Reviewers allow `chorus_get_*`, `chorus_list_tasks`, `chorus_list_projects`,
`chorus_search`, `chorus_checkin`, and `chorus_add_comment`. Workers additionally
allow `chorus_claim_task`, `chorus_release_task`, `chorus_update_task`,
`chorus_report_work`, `chorus_report_criteria_self_check`,
`chorus_submit_for_verify`, `chorus_session_checkin_task`, and
`chorus_session_checkout_task`. Admin actions, entity creation, and session
creation/closure remain outside both roles. Forbidden calls fail before network
dispatch; missing config, remote failures, and cancellation remain visible.
No child requires `tool_search`, `codemode`, `mcp`, or `mcpScript`. Legacy custom
reviewer definitions still expand allowed direct operations via the same policy,
with unrestricted gateways removed; empty reviewer permissions fail closed.
Non-reviewer custom agents keep their existing declared tools or inheritance.

**This is a tool-surface policy, not a security sandbox.** Bash, test/build
subprocesses, inherited credentials, and network access are not isolated. Task
and code reviewers may run tests/builds that create outputs, but must not edit
source or perform git writes; proposal reviewers use inspection only. Comment
target scope is behavioral, not enforced per UUID. `chorus_checkin` can mark
notifications read, as can `chorus_get_notifications` by default (use
`autoMarkRead: false` to avoid that query's effect). Parent MCP exposure and
legacy gateway workflow-reminder limitations are unchanged.

## Wakeable daemon backend (`--agent pi`)

pi is a first-class **wakeable** Chorus daemon backend. The Chorus daemon can wake a
headless pi session on remote dispatch (assigned idea/task, `@mention`, proposal decision),
so pi joins the reversed-conversation loop like the Claude Code / Codex / Kiro backends:

```bash
chorus daemon --agent pi
```

The daemon resolves `pi` from PATH (override with `CHORUS_PI_PATH`), runs one headless
`pi --mode rpc` process per wake (pi 0.85.0 or newer), and exports `CHORUS_URL` / `CHORUS_API_KEY` / `CHORUS_AGENT_PROFILE`
into the woken session. pi has no permission system, so no sandbox flag is involved. `chorus init`
seeds a selected pi agent as wakeable in `~/.chorus/daemon.json` and can install the boot daemon
that wakes it. See [`docs/CONNECT_PI.md`](../../docs/CONNECT_PI.md#run-pi-as-a-wakeable-daemon-backend).

## Why Pi is the lowest-friction target

- **MCP: native from Pi 0.99.0, legacy adapter supported.** Native MCP reads global `mcp.json` or trusted-project `.pi/mcp.json` and exposes real `mcp__<server>__<tool>` child events even with default codemode. Legacy adapter5 uses global `mcp-adapter.json` with separate legacy discovery/import paths. `chorus agents add` selects the version-appropriate route. Both support environment-referenced Authorization headers; the Chorus extension uses its own HTTP connection for bookkeeping.
- **Hooks: TypeScript, not bash.** The extension replaces ~10 bash hook scripts with one TS file. No `curl`/`jq`, no Bash 3.2 compatibility traps (the `${2:-{}}` JSON-parse bug that plagued the Codex port is structurally impossible here).
- **Sub-agent sessions: automatic.** By monitoring `subagent` tool events, the extension auto-creates a Chorus session for each worker task in a dispatch and closes it when the dispatch returns (or when the run settles — `subagent:async-complete` / `process-terminal` — under nicobailon `pi-subagents`) — a capability the Codex port lacks (Codex has no sub-agent lifecycle events, so its workers manage sessions manually).
- **Skills: same standard.** Pi implements the Agent Skills standard, so the skill bodies port with find/replace only (Claude's `Task` tool → the `subagent` tool; `/chorus:develop` → `/skill:develop`).

## Structure

```
packages/chorus-pi/
├── package.json              # pi manifest (extensions + skills) + peerDeps
├── extensions/
│   ├── chorus.ts             # session_start / before_agent_start / tool_call / tool_result / tool_execution_end / session_shutdown
│   └── subagent/             # pi's official subagent pattern (copied from earendil-works/pi)
│       ├── index.ts          # registers the `subagent` tool (single / parallel / chain)
│       └── agents.ts         # agent discovery — incl. this package's own agents/ dir (package-relative, zero copy)
├── skills/                   # 12 Agent Skills standard SKILL.md (ported from public/chorus-plugin/skills)
│   ├── chorus/                # core overview + routing
│   ├── idea/ proposal/ develop/ review/  # AI-DLC stage workflows
│   ├── quick-dev/ yolo/       # shortcut + full-auto pipelines
│   ├── brainstorm/ orchestrate/  # divergent prelude + multi-agent orchestration
│   ├── docs/ chorus-cli/      # docs router + CLI reference
│   └── openspec-aware/        # opt-in spec-driven authoring sub-procedure
├── agents/                   # 4 sub-agents — discovered package-relative by extensions/subagent/agents.ts (no manual copy)
│   ├── chorus-proposal-reviewer.md   # read-only reviewers
│   ├── chorus-task-reviewer.md
│   ├── chorus-code-reviewer.md
│   └── chorus-worker.md              # task implementer (local edits + chorus_work)
├── bin/
│   └── chorus-mcp-call.sh    # stateless MCP-over-HTTP wrapper (from the Codex port) for OpenSpec byte-exact document mirroring
└── README.md
```
## Status

**Complete port** of the Claude Code / Codex plugins to Pi. All 12 skills, all 3 reviewer sub-agents plus the `chorus-worker` implementer, the session-aware extension, the bundled official subagent pattern, and the OpenSpec wrapper are implemented and validated (TS transpiles, JSON valid, all skill/agent names compliant with the Agent Skills standard, no Claude/Codex-specific references remain).

The packed package is also verified on Pi 0.84.4/0.87.1 with adapter5 and
0.99.0/1.0.2 with native MCP, including actual bundled reviewer/worker CLI
children. See the supported-host matrix above. The optional nicobailon
measurements below describe earlier legacy setups, not a new verification of
that third-party subagent implementation with native MCP.

The extension goes beyond the Codex port in one key way: by using Pi's `tool_call` event (pre-execution, mutable input), it **auto-injects the Chorus session UUID + workflow into each dispatched worker's task** — the Pi-native equivalent of Claude's `SubagentStart` hook. The Codex port has no pre-spawn mutation channel, so its workers must manage sessions manually. On Pi, dispatch a worker via the `subagent` tool and the extension handles session creation + context injection, then closes the session when the dispatch returns — or when the run settles (`subagent:async-complete` / `process-terminal`) under nicobailon `pi-subagents`.


### Subagent run modes: blocking (bundled) vs async (nicobailon `pi-subagents`)

The bundled `subagent` tool (pi's official reference pattern) is **blocking**:
spawn → run → exit within one tool call, so the extension closes the Chorus
session at `tool_result`. It is also the only implementation that takes a
composite call (`{ tasks: [...] }` / `{ chain: [...] }`). If you instead use the
nicobailon `pi-subagents` package's `subagent` tool, top-level launches are
**async (detached)** by default: `tool_result` returns immediately with
`details.asyncId` and the run completes later. That tool takes **one child per
call** — its public normalizer rejects top-level `tasks`/`chain` with *"Legacy
top-level chain and parallel inputs were removed; use workflowScript."* (verified
on 0.66.0 and 0.70.0), so a wave is several single dispatches rather than one
composite. The extension detects the async case (`asyncId`/`runId` in
`details`) and defers session close to `subagent:async-complete` /
`subagent:process-terminal` (with `session_shutdown` sweep as a final guard).
Tasks that already carry an injected `--- Chorus session` block (e.g. a
main-agent wave template) are never re-injected.

### Coexistence with nicobailon `pi-subagents`: load-order rule

The bundled subagent (pi's official reference pattern, at `extensions/subagent/`)
registers a tool named `subagent`. The nicobailon `pi-subagents` package registers
a tool with the **same name**. pi's extension loader rejects a duplicate tool
registration with a conflict error (verified on pi 0.84.4:
`Tool "subagent" conflicts with ...`), so the two cannot both register.

**Recommended setup (keep nicobailon, zero conflicts)**: exclude the bundled
subagent extension via a package filter in `settings.packages` — pi's package
entries accept an object form with per-resource glob patterns:

```json
"packages": [
  "npm:pi-subagents",
  {
    "source": "git:github.com/Chorus-AIDLC/chorus/packages/chorus-pi",
    "extensions": ["!extensions/subagent/**"]
  }
]
```

This keeps `chorus.ts` (session hooks) and the `agents/*.md` files (discovered
via `pi.subagents.agents`) while the bundled `subagent` tool never registers —
no conflict error, nicobailon wins deterministically.

| Setup | What happens |
|-------|--------------|
| Only `@chorus-aidlc/chorus-pi` (no external subagents) | Bundled subagent registers and handles dispatch (single/parallel/chain, blocking) |
| Both installed, with the filter above | nicobailon's `subagent` tool is the only one — one child per call (`tasks`/`chain` composites are not available). Chorus session hooks keep working (they match on the tool name) |
| Both installed, no filter: `npm:pi-subagents` listed **before** chorus-pi | nicobailon wins; the bundled subagent reports a conflict error at load (harmless inside an interactive session, noisy for CLI commands like `pi packages list`) |
| Both installed, no filter: `npm:pi-subagents` listed **after** chorus-pi | Bundled subagent wins (it loaded first); nicobailon's tool is rejected. Flip the order to switch |
**How to verify which implementation is active**: run
`subagent({ action: "list" })`. nicobailon output shows `Package agents /
Builtin agents / User agents` sections; the bundled subagent's output has no
such sections.

### Tips when combining with nicobailon `pi-subagents`

- **Sessions work with either tool.** Chorus hooks match on the tool name,
  so `checkin → in_progress → report → checkout → submit_for_verify` flows are
  identical; only close timing differs (blocking closes at `tool_result`, async
  closes on `subagent:async-complete`/`process-terminal`).
- **Children explicitly load their role tools.** Agent-relative
  `subagentOnlyExtensions` loads `chorus_review` or `chorus_work`; neither
  depends on the parent's ambient MCP adapter or inherited native MCP tools.
  Missing optional gateway names are not declared as required tools.
- **Reviewers and workers remain pinned to the background path.** The
  existing session-lifecycle routing is retained, independently of role-tool
  loading. Wait for completion with `bg_wait`/the run notification. The bundled
  dispatcher still blocks on its separate `pi --mode json` child. The extension pins the
  run-level `async: true` at `tool_call` whenever a `chorus-*-reviewer` or a
  worker (`worker`, `chorus-worker`) is in the call, **removing** the `clarify`
  property (`delete`, not `clarify: false` — `clarify: true` defeats async anyway,
  and nicobailon's public normalizer rejects a call whenever `clarify` is
  *defined*, `false` included: `params.clarify !== undefined` in
  `src/extension/public-execution.js`), and notifies once when it overrode an
  explicit `async: false`. One `subagent` call has one mode, so
  pinning any Chorus item pins the whole call. That covers `tasks[]` / `chain[]`
  calls, which are the bundled subagent's composite schema — nicobailon rejects
  top-level `tasks`/`chain` before dispatch, so under nicobailon a wave is one
  single dispatch per child.
  Known gaps of that hook: reviewers nested in a chain step's `parallel[]` or
  dynamic `expand` fanout are not enumerated, nor is a chain step that names only
  `agent` (its `task` defaults to `{previous}`, so the item carries no `task` to
  match on); children created inside a `workflowScript` are invisible to it;
  `{action:"resume"}` replays keep the stored run's mode; and spawns that bypass
  the `subagent` tool are never seen.
- **`workflowScript` / `runs.run` / `runs.all`**: nicobailon-only. The bundled
  subagent has no `workflowScript` mode — use its own `tasks`/`chain` composite
  schema (nicobailon rejects those top-level fields), or keep nicobailon for
  scripted waves. Note the gap above: children a `workflowScript` creates are
  invisible to the session hook, so a Chorus worker dispatched that way gets no
  auto-created session — prefer one call per child for Chorus work.
- **Model selection per reviewer**: nicobailon honors `subagent({..., model})`
  per call, `subagents.agentOverrides.<name>.model` in settings, and agent
  frontmatter `model:`. The bundled subagent honors only agent frontmatter
  `model:` (it reads `name`/`description`/`tools`/`model`; its schema has no
  per-call model parameter) — set it in `~/.pi/agent/agents/chorus-*-reviewer.md`.
- **Agent files**: bundled subagent reads package `agents/*.md` + `~/.pi/agent/agents/*.md`
  (user overrides package). nicobailon reads builtin/package/user/project with
  richer frontmatter (`excludeTools`, `thinking`, `inheritSkills`, `extensions`,
  per-agent `tools` allowlists, `model`, ...).
- **Tool-name clash**: both register a `subagent` tool and pi rejects a duplicate
  registration with a conflict error. To keep nicobailon (needed for its
  async/`workflowScript` features), use the package filter above (exclude
  `extensions/subagent/**`); if you instead rely on ordering, list
  `npm:pi-subagents` **before** chorus-pi. Either way, verify with
  `subagent({ action: "list" })` (nicobailon shows `Package/Builtin/User agents`
  sections; bundled does not).
## License

AGPL-3.0
