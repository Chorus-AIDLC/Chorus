# Testing chorus-pi

Two layers run anywhere (no Pi session, no live Chorus); a shell precheck + two more layers need a fresh Pi session with Chorus reachable.

## Quick start

```bash
cd chorus-pi

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
| A2 package.json | `pi.extensions` (array), `pi.skills` (array), `bin.chorus-mcp-call`, peerDep `@narumitw/pi-subagents` all present |
| A3 skill frontmatter | every skill has `name` + `description`; name matches Agent Skills rules (lowercase, hyphens ok, no leading/trailing/double hyphen) |
| A4 agent frontmatter | every agent has `name` + `description` + `tools`; reviewer `tools` is read-only (no write/edit/replace) |
| A5 wrapper syntax | `bash -n bin/chorus-mcp-call.sh` |
| A6 no residual | no `Claude Code` / `CLAUDE_PROJECT_DIR` / `.claude/` / `subagent_type` / `run_in_background` / `TeamCreate` / `Task({` / `Agent({` references left in skills/agents/bin |
| A7 skill cross-refs | every `/skill:X` in a skill maps to a real `name:` in `skills/*/SKILL.md` |
| A8 agent cross-refs | every `agent: "X"` spawn in a skill maps to either a `chorus-*-reviewer` in `agents/` or a pi-subagents built-in (scout/planner/reviewer/worker) |

A8 is the key end-to-end-consistency check: it proves the skills don't reference a reviewer that wasn't ported.

## Layer B — Unit tests (`test/lib.test.ts`)

Tests the pure helpers extracted to `lib/lib.ts` (no Pi runtime, no live MCP):

- `isReviewerAgent` — the three reviewer names match; workers/built-ins/partials reject
- `isWorkerAgent` — positive worker allowlist (`["worker"]`); built-in read-only agents (scout/planner/reviewer) and arbitrary custom agents reject
- `extractAgentId` / `extractAgentIdFromToolResultEvent` — reads `result.details.agent.id` (the real `pi-subagents` `summarizeAgent()` path); falls back to `agentId` and `sa_<uuid>` text parsing; null on absence
- `sessionWorkflow` — UUID appears in every chorus_* step; contains the "do not manage lifecycle" line; starts with a blank separator line
- `detectOpenSpec` — all four branches (optout / no dir / dir-but-no-CLI / both present); CLI probed only when the dir exists
- `buildSessionBanner` — the five banner states (not-configured / connection-failed / connected+active / connected+opt-out / connected+not-set-up)
- `parseMaxCodeReviewRounds` — default 3, 0 = unlimited, negatives/non-integers fall back to default
- `resolveChorusBin` — resolves `bin/chorus-mcp-call.sh` relative to the extension for local-path installs
- `parseChorusServerFromMcpJson` / `resolveChorusConfigFromMcpJson` — read the chorus server entry out of `.mcp.json` (the env-fallback path); the resolver only accepts a COMPLETE candidate (both url + apiKey) so a partial project config cannot shadow a complete global one
- `normalizeChorusToolName` / `resolveChorusToolName` — strip the chorus server prefix in MCP gateway mode

These catch logic regressions in the ported behavior without needing a session.

## Layer B′ — Extension-event tests (`test/ext-events.test.ts`)

Drives the **real** `extensions/chorus.ts` default factory against a fake `pi` (handlers captured off `pi.on`) and a mocked global `fetch` (so `mcpCall` never hits the network). Covers the session-lifecycle fixes that needed an event-level check:

- **P1-2** — an unknown `subagent_spawn` result shape (neither extractor recognizes) closes the orphan Chorus session instead of leaking it
- **P1-3** — a failing `chorus_close_session` retains the `agentId→sessionUuid` mapping so `session_shutdown` can retry it; a *successful* close (the control test) deletes the mapping and is NOT retried
- **P2-1** — non-worker agents (scout/planner/reviewer/`chorus-*-reviewer`) do NOT create a session; `worker` does

Module-scope state (`sessionMap`/`pendingSessions`/`spawnMapped`) is reset between tests by invoking the `session_shutdown` handler. Runs in its own `bun test` invocation (set in `test/all.sh`) so its `globalThis.fetch` override cannot leak into `test/lib.test.ts`.

## Layer C — Load + connection (needs a fresh Pi session + Chorus running)

These verify Pi discovers the package and the extension's `session_start` actually calls `chorus_checkin` over the real MCP. Run in a **new** Pi session (the running session won't pick up a freshly installed extension).

### C0. Install + configure

```bash
# runtime deps (if not already installed)
pi install npm:pi-mcp-adapter
pi install npm:@narumitw/pi-subagents

# the package
pi install ./chorus-pi

# reviewer agents go to the discovery path (NOT the package manifest)
mkdir -p ~/.pi/agent/agents
cp chorus-pi/agents/*.md ~/.pi/agent/agents/

# env + mcp (adjust URL/key)
export CHORUS_URL=http://localhost:8637
export CHORUS_API_KEY=cho_your_key
# .mcp.json at repo root (pi-mcp-adapter auto-discovers it)
```

### C1. Discovery checks (in the new Pi session)

| Check | How | Expected |
|---|---|---|
| Skills discovered | type `/skill:chorus` | the skill loads (autocomplete shows all 8) |
| Agents discovered | `/subagents` panel | `chorus-proposal-reviewer`, `chorus-task-reviewer`, `chorus-code-reviewer` listed (plus built-ins) |
| MCP connected | `/mcp` panel | `chorus` green/plug icon, 40+ `chorus_*` tools |
| Extension loaded | send any prompt; watch the first turn | a `# Chorus Plugin — Active` context message appears (from `before_agent_start` injection) with your checkin JSON + `CHORUS_OPENSPEC_ACTIVE=…` |

If the injected context reads `# Chorus: connection failed`, the extension couldn't reach `CHORUS_URL` — check the env vars are exported in the shell that launches Pi and that Chorus is up.

## Layer D — Session injection + reviewer nudge (the core runtime behavior)

These verify the `tool_call`-mutation session injection and the `tool_execution_end` reviewer nudge — the behaviors that make this port match Claude Code's auto session lifecycle (and exceed the Codex port, which can't do either).

### D1. Session UUID injection into a spawned worker

Spawn a worker and inspect the task it actually received:

```
subagent_spawn({ agent: "worker", task: "Reply with the word OK and stop." })
```

Then, **inside the spawned worker's context**, verify its task prompt contains the injected block. The simplest way: ask the worker to echo the first line containing "Chorus session":

```
# In the main session, after the worker reports, check it saw the UUID.
# Or: spawn with a task that prints it:
subagent_spawn({
  agent: "worker",
  task: "If your task contains a line starting with 'Session UUID:', print that line and stop. Otherwise print 'NO SESSION'."
})
```

Expected: the worker prints `Session UUID: <some-uuid>` — proving the extension's `tool_call` handler created a Chorus session and appended `sessionWorkflow(uuid)` to `input.task` before the subprocess started.

Then close it and confirm the session closes:
```
subagent_manage({ action: "close", agentId: "<the sa_ id from spawn>" })
```
Check the Chorus backend (Web UI → sessions, or `chorus_list_sessions`) — the session should now be `closed`.

### D2. Reviewer nudge after proposal submission

As a PM-role agent, submit a proposal and watch for the steer message:
```
chorus_pm_submit_proposal({ proposalUuid: "<uuid>" })
```
Expected: shortly after, a user-style steer message appears prompting you to spawn `chorus-proposal-reviewer` (unless `CHORUS_ENABLE_PROPOSAL_REVIEWER=false`).

Repeat with `chorus_submit_for_verify` (task-reviewer nudge) and `chorus_admin_verify_task` (code-reviewer nudge) to exercise all three `tool_execution_end` branches.

### D3. Reviewer agent actually runs

```
subagent({ agent: "chorus-task-reviewer", task: "Review task <task-uuid>. Post a VERDICT comment." })
```
Expected: the blocking subagent tool waits, the reviewer fetches the task via `chorus_get_task`, and posts a `chorus_add_comment` ending in `VERDICT: PASS` / `PASS WITH NOTES` / `FAIL`. This proves the agent frontmatter (read-only `tools` whitelist + the system-prompt body) ported correctly.

### D4. session_shutdown cleanup

Exit Pi (Ctrl+C / Ctrl+D). On the Chorus backend, any sessions still tracked by the extension should be closed (the `session_shutdown` handler flushes `sessionMap` + `pendingSessions`).

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

## What is NOT yet covered

- **`session_start` checkin + OpenSpec detection** (the `mcpCall("chorus_checkin")` + `detectOpenSpec` path): Layer C1 covers it empirically (a successful checkin banner means it works end to end). A fetch-mock test for this specific path is a future improvement; the session-lifecycle event tests in Layer B′ already prove the `mcpCall`/`pi.on` plumbing works against a mocked fetch.
- **Reviewer nudge `pi.sendUserMessage` calls**: Layer D2/D3 covers these empirically.
