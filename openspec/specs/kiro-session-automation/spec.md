# kiro-session-automation Specification

## Purpose
TBD - created by archiving change add-kiro-cli-plugin. Update Purpose after archive.
## Requirements
### Requirement: Kiro main agent checks in and checks out via lifecycle hooks
The `chorus` main agent SHALL carry an `agentSpawn` hook that runs `chorus_checkin` (surfacing agent owner, permissions, and idea tracker into the agent's startup context) and a `stop` hook that performs a best-effort session heartbeat/checkout. These are the Kiro-native equivalent of the Claude Code plugin's SessionStart/SessionEnd session lifecycle, and SHALL degrade gracefully (never block the agent) when Chorus is unreachable.

#### Scenario: Checkin fires on agent spawn
- **WHEN** the `chorus` main agent is spawned and `CHORUS_URL` + `CHORUS_API_KEY` are configured
- **THEN** its `agentSpawn` hook calls `chorus_checkin` and adds the result to the agent's context

#### Scenario: Unconfigured environment does not break spawn
- **WHEN** the `chorus` main agent is spawned without Chorus env configured
- **THEN** the `agentSpawn` hook exits successfully with a "not configured" notice and does not abort the session

#### Scenario: Checkout on stop is best-effort
- **WHEN** the agent finishes its turn and the `stop` hook runs
- **THEN** it attempts a heartbeat/checkout and never fails the turn if Chorus is unreachable

### Requirement: Reviewer-nudge hooks fire on Chorus workflow MCP calls
The `chorus` main agent SHALL carry `postToolUse` hooks matched to the Chorus workflow MCP tools — `@chorus/chorus_pm_submit_proposal`, `@chorus/chorus_submit_for_verify`, and `@chorus/chorus_admin_verify_task` — that emit a nudge to spawn the corresponding reviewer subagent (`chorus-proposal-reviewer`, `chorus-task-reviewer`, and `chorus-code-reviewer` respectively). The matchers SHALL use the exact `@chorus/<tool>` form (Kiro hook matchers support MCP tool names but not regex/glob).

#### Scenario: Proposal submit nudges the proposal reviewer
- **WHEN** the agent calls `chorus_pm_submit_proposal` and the `postToolUse` hook fires
- **THEN** the hook emits guidance to spawn the `chorus-proposal-reviewer` subagent before approval

#### Scenario: Task submit nudges the task reviewer
- **WHEN** the agent calls `chorus_submit_for_verify`
- **THEN** the `postToolUse` hook emits guidance to spawn the `chorus-task-reviewer` subagent

#### Scenario: Task verify nudges the code reviewer at idea completion
- **WHEN** the agent calls `chorus_admin_verify_task`
- **THEN** the `postToolUse` hook emits guidance to spawn the `chorus-code-reviewer` subagent when it is the last task of the idea

### Requirement: Hook scripts are self-contained under the plugin bin
The `public/kiro-plugin/bin/` directory SHALL contain every script the hooks invoke, including a copy of `chorus-api.sh` (the runtime-agnostic MCP wrapper the hooks reuse), so that when the installer copies `bin/` into `<KIRO_DIR>/chorus-bin/` the hooks have no unresolved external dependency. Hook scripts SHALL reference `chorus-api.sh` by a path relative to their own location, not an absolute repo path.

#### Scenario: bin/ ships chorus-api.sh alongside the hook scripts
- **WHEN** `public/kiro-plugin/bin/` is listed
- **THEN** it contains the hook scripts and a `chorus-api.sh`, and no hook script references `chorus-api.sh` via a hard-coded repo path

### Requirement: Hook scripts are Bash 3.2 compatible and syntax-tested
All hook scripts under `public/kiro-plugin/bin/` SHALL be compatible with Bash 3.2 (macOS default) — no `${VAR,,}`/`${VAR^^}`, `declare -A`, `readarray`/`mapfile`, or other Bash 4+ constructs — and the change SHALL ship a `test-syntax.sh` that verifies the scripts parse under Bash 3.2, mirroring the existing plugin bin test harness.

#### Scenario: Scripts pass the Bash 3.2 syntax check
- **WHEN** `public/kiro-plugin/bin/test-syntax.sh` is run
- **THEN** every hook script parses successfully with no Bash 4+ construct flagged

#### Scenario: Nudge hooks do not hard-fail on missing payload
- **WHEN** a `postToolUse` hook receives an event with no parseable proposal/task UUID
- **THEN** the hook exits successfully without emitting a broken nudge

