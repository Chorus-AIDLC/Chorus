# Testing chorus-pi

Two layers run anywhere (no Pi session, no live Chorus); a shell precheck + two more layers need a fresh Pi session with Chorus reachable.

## Quick start

```bash
cd packages/chorus-pi

# Layer A — static validation (TS, JSON, frontmatter, cross-refs, no residual)
bash test/static.sh

# Layer B — unit tests for the extracted pure helpers
bun test test/lib.test.ts

# Layer B′ — extension-event tests (drive the real chorus.ts factory
#         with a fake pi + mocked fetch; covers the session-lifecycle fixes)
bun test test/ext-events.test.ts

# one-command offline suite = Layer A + Layer B + Layer B′
bash test/all.sh

# Layer C/D setup — shell precheck BEFORE launching a fresh Pi session
bash test/precheck.sh
# then: launch a fresh `pi` session and paste test/verify-pi-session.md to it
```

Layers A + B + B′ must all be green before any integration work. They run in <1s and need no runtime.

## Layer A — Static validation (`test/static.sh`)

Verifies the package is well-formed and internally consistent, with no runtime deps:

| Check | What it asserts |
|---|---|
| A1 TS transpile | `extensions/chorus.ts` builds with `bun build` |
| A2 package.json | `pi.extensions` (array), `pi.skills` (array), `bin.chorus-mcp-call` present; `@narumitw/pi-subagents` absent from every dependency block (reviewers use pi's bundled official subagent pattern) |
| A3 skill frontmatter | every skill has `name` + `description`; name matches Agent Skills rules (lowercase, hyphens ok, no leading/trailing/double hyphen) |
| A4 agent frontmatter | every agent has `name` + `description` + `tools`; reviewer `tools` is read-only (no write/edit/replace) |
| A5 wrapper syntax | `bash -n bin/chorus-mcp-call.sh` |
| A6 no residual | no `Claude Code` / `CLAUDE_PROJECT_DIR` / `.claude/` / `subagent_type` / `run_in_background` / `subagent_spawn` / `subagent_manage` / `TeamCreate` / `Task({` / `Agent({` references left in skills/agents/bin (the last two are Claude-Code-era dispatch/close names — the only dispatch tool here is `subagent`, with no handle to close) |
| A7 skill cross-refs | every `/skill:X` in a skill maps to a real `name:` in `skills/*/SKILL.md` |
| A8 agent cross-refs | every `agent: "X"` spawn in a skill maps to either a `chorus-*-reviewer` in `agents/` or a pi official subagent example agent (scout/planner/reviewer/worker) |

A8 is the key end-to-end-consistency check: it proves the skills don't reference a reviewer that wasn't ported.

## Layer B — Unit tests (`test/lib.test.ts`)

Tests the pure helpers extracted to `lib/lib.ts` (no Pi runtime, no live MCP):

- `isReviewerAgent` — the three reviewer names match; workers/example-agents/partials reject
- `isWorkerAgent` — positive worker allowlist (`["worker"]`); the example read-only agents (scout/planner/reviewer) and arbitrary custom agents reject
- `subagentTaskItems` — enumerates the (agent, task) items of a `subagent` tool call across single / parallel / chain modes; `setTask` mutates the ORIGINAL input in place; skips items with a missing/non-string agent or task; empty for non-object input
- `sessionWorkflow` — UUID appears in every chorus_* step; contains the "do not manage lifecycle" line; starts with a blank separator line
- `resolveSpecMode` — the 13-case contract matrix (explicit `lite`/`openspec`/`off`/invalid/unset × OpenSpec usable / no dir / dir-but-no-CLI / disabled), plus the reason-precedence and short-circuit cases: `enableOpenSpec=false` outranks `CHORUS_OPENSPEC_MODE=off`, the CLI is probed only when the dir exists and OpenSpec isn't disabled, and `specFail` is set only when an explicit `openspec` cannot be honored (never a silent downgrade)
- `buildSessionBanner` — the banner states: not-configured / connection-failed / connected × each resolved spec mode (`openspec` / `lite` / `off`) / connected + unhonorable explicit `openspec`; not-configured is checked before connection-failed
- `parseMaxCodeReviewRounds` — default 3, 0 = unlimited, negatives/non-integers fall back to default
- `resolveChorusBin` — resolves `bin/chorus-mcp-call.sh` relative to the extension for local-path installs
- `parseChorusServerFromMcpJson` / `resolveChorusConfigFromMcpJson` — read the chorus server entry out of `.mcp.json` (the env-fallback path); the resolver only accepts a COMPLETE candidate (both url + apiKey) so a partial project config cannot shadow a complete global one
- `normalizeChorusToolName` / `resolveChorusToolName` — strip the chorus server prefix in MCP gateway mode

These catch logic regressions in the ported behavior without needing a session.

## Layer B′ — Extension-event tests (`test/ext-events.test.ts`)

Drives the **real** `extensions/chorus.ts` default factory against a fake `pi` (handlers captured off `pi.on`) and a mocked global `fetch` (so `mcpCall` never hits the network). Covers the ephemeral-subagent session lifecycle at the event level:

- **worker dispatch** — a `subagent` tool call for a `worker` creates a Chorus session on `tool_call`, mutates the worker's task in place with the injected `sessionWorkflow`, and closes the session on `tool_result`; `tool_execution_end` is then an idempotent no-op
- **parallel / mixed** — one session per worker task; a `chorus-*-reviewer` task in the same parallel dispatch gets NO session and its task is not mutated
- **non-worker agents** — scout/planner/reviewer/`chorus-*-reviewer` create no session; `worker` does
- **no leak** — a failing `chorus_close_session` retains the session so `session_shutdown` retries it (both closes target the same session); a `subagent` tool error still closes the created session; `tool_execution_end` closes the session if `tool_result` never fired
- **reviewer nudges** — `chorus_submit_for_verify` (direct) and `chorus_pm_submit_proposal` (gateway `event.input.tool`) fire a `pi.sendUserMessage` steer; a non-trigger chorus tool fires none

Module-scope state (`callSessions`) is reset between tests by invoking the `session_shutdown` handler. Runs in its own `bun test` invocation (set in `test/all.sh`) so its `globalThis.fetch` override cannot leak into `test/lib.test.ts`.

## Layer C — Load + connection (needs a fresh Pi session + Chorus running)

These verify Pi discovers the package and the extension's `session_start` actually calls `chorus_checkin` over the real MCP. Run in a **new** Pi session (the running session won't pick up a freshly installed extension).

### C0. Install + configure

```bash
# the package — ships the official subagent pattern (extensions/subagent/) and
# discovers the 3 reviewer agents package-relative, so NO subagents dep and NO
# manual copy of agents/*.md into ~/.pi/agent/agents/ is needed.
pi install npm:@chorus-aidlc/chorus-pi
# (or, from a repo checkout: pi install ./packages/chorus-pi)

# env + mcp (adjust URL/key)
export CHORUS_URL=http://localhost:8637
export CHORUS_API_KEY=cho_your_key
pi mcp add chorus --url "${CHORUS_URL}/api/mcp" --bearer-token-env-var CHORUS_API_KEY
```

The example uses native MCP on stable Pi >=0.99.0 <2.0.0. For Pi
0.84.4–0.98.x instead install `npm:pi-mcp-adapter@5.0.0` and configure its
global `mcp-adapter.json` with env-referenced Chorus headers and
`mcpServers.chorus.directTools: true`. Do not run native `pi mcp` commands on
those old hosts. See `docs/CONNECT_PI.md` for config paths and warning-only
migration; preserve user settings and use isolated agent/project directories
for probes. Native codemode is supported without forcing direct exposure;
legacy gateway-only calls do not trigger the reviewer nudges below.

### C1. Discovery checks (in the new Pi session)

| Check | How | Expected |
|---|---|---|
| Skills discovered | type `/skill:chorus` | the skill loads (autocomplete shows all 12) |
| Agents discovered | dispatch `subagent({ agent: "chorus-task-reviewer", ... })` (or inspect discovery) | the 3 reviewer agents are found package-relative — with NO copy into `~/.pi/agent/agents/` |
| MCP connected | `/mcp` panel | `chorus` green/plug icon, 40+ `chorus_*` tools |
| Extension loaded | send any prompt; watch the first turn | a `# Chorus Plugin — Active` context message appears (from `before_agent_start` injection) with your checkin JSON + `CHORUS_OPENSPEC_ACTIVE=…` |

If the injected context reads `# Chorus: connection failed`, the extension couldn't reach `CHORUS_URL` — check the env vars are exported in the shell that launches Pi and that Chorus is up.

## Layer D — Session injection + reviewer nudge (the core runtime behavior)

These verify the `tool_call`-mutation session injection and the `tool_result` reviewer nudge — the behaviors that make this port match Claude Code's auto session lifecycle (and exceed the Codex port, which can't do either).

### D1. Session UUID injection into a dispatched worker

Dispatch a worker via the `subagent` tool and have it echo the injected block:

```
subagent({
  agent: "worker",
  task: "If your task contains a line starting with 'Session UUID:', print that line and stop. Otherwise print 'NO SESSION'."
})
```

Expected: the worker prints `Session UUID: <some-uuid>` — proving the extension's `tool_call` handler created a Chorus session and appended `sessionWorkflow(uuid)` to the worker task's text before the ephemeral child `pi` process started.

The children are ephemeral (spawn → run → exit within the single `subagent` tool call), so there is no separate close step: the extension closes the session automatically when the `subagent` tool call returns (`tool_result` / `tool_execution_end`). Check the Chorus backend (Web UI → sessions, or `chorus_list_sessions`) — the session should be `closed` right after the tool call completes.

### D2. Reviewer nudge after proposal submission

As a PM-role agent, submit a proposal and watch for the steer message:
```
chorus_pm_submit_proposal({ proposalUuid: "<uuid>" })
```
Expected: shortly after, a user-style steer message appears prompting you to spawn `chorus-proposal-reviewer` (unless `CHORUS_ENABLE_PROPOSAL_REVIEWER=false`).

Repeat with `chorus_submit_for_verify` (task-reviewer nudge) and `chorus_admin_verify_task` (code-reviewer nudge) to exercise all three `tool_result` nudge branches.

### D3. Reviewer agent actually runs

```
subagent({ agent: "chorus-task-reviewer", task: "Review task <task-uuid>. Post a VERDICT comment." })
```
Expected: the blocking subagent tool waits, the reviewer fetches the task via `chorus_get_task`, and posts a `chorus_add_comment` ending in `VERDICT: PASS` / `PASS WITH NOTES` / `FAIL`. This proves the agent frontmatter (read-only `tools` whitelist + the system-prompt body) ported correctly.

### D4. session_shutdown cleanup

Exit Pi (Ctrl+C / Ctrl+D). On the Chorus backend, any sessions still tracked by the extension should be closed (the `session_shutdown` handler flushes `callSessions` — e.g. a worker session whose close failed and was retained for retry).

## Layer E — End-to-end AI-DLC

The full pipeline. Requires an Admin-preset agent key (write on every resource + approve/verify admin bits).

```
/skill:yolo
Implement a "hello world" API endpoint at GET /hello that returns {"message":"hello"}.
```

Expected, in order:
1. Idea created → elaboration (auto-answered)
2. Proposal drafted (PRD + task DAG) → submitted → reviewer nudge → `chorus-proposal-reviewer` spawned → VERDICT
3. Proposal approved → tasks claimed → workers spawned (each gets an auto-injected session) → code written → submitted for verify → `chorus-task-reviewer` spawned → VERDICT
4. Tasks verified → last task triggers `chorus-code-reviewer` over the idea's aggregate change → VERDICT
5. Completion report + Idea closed

This exercises every extension event and every skill. If it completes with all VERDICTs PASS, the port is functionally equivalent to the Claude Code plugin.

## Mandatory packed-host compatibility matrix

Prepare isolated SDKs 0.84.4, 0.87.1, 0.99.0 and 1.0.2 under
`/tmp/chorus-pi-compat-<version>/node_modules` (override with `--roots` or
`CHORUS_PI_SDK_ROOTS`). Install adapter5 only in the two legacy roots:

```bash
npm install --prefix /tmp/chorus-pi-compat-0.84.4 --ignore-scripts --no-audit --no-fund @earendil-works/pi-coding-agent@0.84.4 pi-mcp-adapter@5.0.0
npm install --prefix /tmp/chorus-pi-compat-0.87.1 --ignore-scripts --no-audit --no-fund @earendil-works/pi-coding-agent@0.87.1 pi-mcp-adapter@5.0.0
npm install --prefix /tmp/chorus-pi-compat-0.99.0 --ignore-scripts --no-audit --no-fund @earendil-works/pi-coding-agent@0.99.0
npm install --prefix /tmp/chorus-pi-compat-1.0.2 --ignore-scripts --no-audit --no-fund @earendil-works/pi-coding-agent@1.0.2
mkdir -p /tmp/chorus-pi-compat-artifact
npm pack ./packages/chorus-pi --ignore-scripts --pack-destination /tmp/chorus-pi-compat-artifact
node packages/chorus-pi/test/compat-matrix.mjs --artifact /tmp/chorus-pi-compat-artifact/chorus-aidlc-chorus-pi-0.21.0.tgz
node packages/chorus-pi/test/config-discovery-matrix.mjs --artifact /tmp/chorus-pi-compat-artifact/chorus-aidlc-chorus-pi-0.21.0.tgz
node cli/__tests__/pi-mcp-config-host.mjs
pnpm exec vitest run cli/__tests__
```

Run from the repository root. The same packed artifact loads with all four
actual SDKs, real native/adapter MCP, local MCP/HTTP fixtures and a deterministic
model provider. The 36 scenarios cover checkin/context, workflow success/error
gates, native codemode/direct and legacy direct, actual bundled reviewer CLI
children with permitted/denied operations, worker/custom inheritance and session
cleanup. Missing a required host or a failed scenario blocks compatibility
acceptance; mocked unit tests and optional production-provider checks cannot
replace this evidence. The config-loader probe separately verifies generated
native/adapter5 files with all four real loaders.

The additional **16-scenario config-discovery matrix** generates files with
the real CLI writer, then loads the packed extension on each actual SDK without
exporting `CHORUS_URL`. Fresh/retained-old config and default/custom agent
directories exercise checkin, worker lifecycle and workflow reminders across
the installer/runtime boundary. Legacy primary beats retained old global config;
native hosts keep native selection. Run this in addition to, not instead of,
the original 36-scenario event/permissions matrix. Offline configuration tests
also cover malformed/partial/unreadable files and missing environment credentials.

`pi1-native-mcp.mjs` adds 15 native event scenarios on Pi 1.0.2; set `PI_SDK_DIR`
to the isolated SDK package path when Pi is not global. All these probes isolate
HOME, agent directory and cwd, use dummy credentials, and never change a live
Chorus business resource. Layers C–E are optional live-session checks requiring
explicitly authorized resources; the local matrix does not claim live-provider
or production workflow coverage.
