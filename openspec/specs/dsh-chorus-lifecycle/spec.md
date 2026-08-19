# dsh-chorus-lifecycle Specification

## Purpose
TBD - created by archiving change add-dsh-cordis-lifecycle-plugin. Update Purpose after archive.
## Requirements
### Requirement: Interactive-only lifecycle activation

The installed Chorus Cordis plugin SHALL activate lifecycle automation only for non-daemon dsh sessions. `daemonOriginEnv` SHALL default to `CHORUS_DAEMON_HEADLESS`, SHALL accept one valid environment variable name, and SHALL suppress lifecycle automation when the selected variable equals `1`. In suppressed mode the plugin MUST NOT call Chorus lifecycle tools, inject check-in context, enqueue reviewer work, steer the agent, report turns, or report token usage.

#### Scenario: Interactive session activates the plugin
- **WHEN** dsh creates an agent session without a daemon-origin signal
- **THEN** the plugin registers its check-in, Chorus-tool observation, subagent observation, and turn-stopping behavior

#### Scenario: Daemon session yields to the daemon pipeline
- **WHEN** dsh creates an agent session with `CHORUS_DAEMON_HEADLESS=1`
- **THEN** the plugin performs no Chorus lifecycle calls or steering and the daemon remains the sole turn and token reporter

### Requirement: Bounded first-step check-in

For each interactive agent session, the plugin SHALL invoke `mcp__chorus__chorus_checkin` through `ctx.tools` once and SHALL attempt to inject the result into the first downstream agent step. `checkinTimeoutMs` SHALL default to 1500 and SHALL accept integer values from 100 through 30000. The first-step wait MUST use this bound and MUST fail open.

#### Scenario: Check-in completes within the bound
- **WHEN** the session-start check-in succeeds before the first-step timeout
- **THEN** the first downstream enter decision contains exactly one plugin-sourced check-in context message

#### Scenario: Check-in is slow or fails
- **WHEN** the check-in tool is absent, errors, returns malformed content, or exceeds the timeout
- **THEN** the first agent step proceeds without injected check-in context and the plugin records a warning without blocking later work

#### Scenario: Check-in context is not duplicated
- **WHEN** the agent enters additional steps after the first-step gate has settled
- **THEN** the plugin does not inject the same check-in result again

### Requirement: Chorus lifecycle tool observation

The plugin SHALL observe only successful `mcp__chorus__*` post-execution events, MUST ignore plugin-owned synthetic calls, and MUST leave non-Chorus tools and downstream tool decisions unchanged.

#### Scenario: Successful proposal submission is observed
- **WHEN** `mcp__chorus__chorus_pm_submit_proposal` completes successfully in an interactive session
- **THEN** the plugin records one pending proposal-review action for the owning agent

#### Scenario: Failed lifecycle call is ignored
- **WHEN** a watched Chorus lifecycle tool returns an error or is blocked
- **THEN** the plugin does not enqueue a reviewer or continuation action

#### Scenario: Ordinary tool remains untouched
- **WHEN** any tool outside the `mcp__chorus__*` namespace executes
- **THEN** the plugin neither blocks nor rewrites that tool call or result

### Requirement: Parent-agent reviewer steering

The plugin SHALL map successful proposal submission, task submission for verification, and task verification calls to deduplicated parent-agent instructions. At the turn-stopping boundary it SHALL drain pending instructions into at most one steering message so the parent can run the appropriate blocking reviewer workflow.

#### Scenario: Proposal and task review actions are delivered
- **WHEN** one or more watched submission tools succeed before a turn stops
- **THEN** the plugin steers the parent once with deterministic instructions for each distinct pending proposal or task reviewer action

#### Scenario: Aggregate review remains conditional
- **WHEN** `chorus_admin_verify_task` succeeds
- **THEN** the steering instruction tells the parent to verify that this was the final task of an idea-rooted proposal before spawning aggregate code review

#### Scenario: Duplicate events collapse
- **WHEN** the same reviewer action is observed multiple times before turn stopping
- **THEN** the emitted steering message contains that action once

#### Scenario: No pending workflow action
- **WHEN** a turn stops without a successful watched Chorus lifecycle call
- **THEN** the plugin does not steer the agent

### Requirement: Fail-open bounded lifecycle ownership

The plugin SHALL bound pending actions and asynchronous work, SHALL register cleanup through the Cordis effect lifecycle, and MUST NOT prevent dsh work or shutdown when Chorus is unavailable. `maxPendingActions` SHALL default to 8 and SHALL accept integer values from 1 through 64.

#### Scenario: Pending action capacity is reached
- **WHEN** distinct lifecycle actions exceed the configured pending-action bound
- **THEN** the plugin retains no more than the configured bound, records a warning, and continues the agent turn

#### Scenario: Plugin unload aborts active work
- **WHEN** the Cordis plugin is disposed while check-in or tracked continuations are active
- **THEN** cleanup aborts plugin-owned work, clears pending state, waits for tracked promises to settle, and releases event handlers

#### Scenario: Chorus outage does not stop dsh
- **WHEN** Chorus remains unavailable across lifecycle events
- **THEN** dsh sessions, tool execution, and shutdown continue while failures remain visible in local diagnostics

### Requirement: Installer-managed plugin delivery

The dsh installer SHALL install one built lifecycle artifact under `$DSH_HOME/chorus`, SHALL load it through one installer-owned home-patch row, and SHALL update the artifact and patch idempotently with rollback on validation failure. Contract and real-composition verification SHALL target deepseek-harness tag `dsh-v0.1.0-rc.7` at commit `99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`.

#### Scenario: First installation
- **WHEN** a user runs the installer with a valid dsh runtime and Chorus configuration
- **THEN** the lifecycle artifact is owner-readable only, the managed patch contains one lifecycle row, and effective dsh composition validation succeeds

#### Scenario: Repeated installation
- **WHEN** the installer is rerun over an existing managed lifecycle installation
- **THEN** it replaces the managed artifact and leaves exactly one lifecycle row without changing unrelated home configuration

#### Scenario: Composition validation fails
- **WHEN** dsh rejects the generated lifecycle composition or the expected plugin row is absent
- **THEN** the installer exits non-zero and restores the prior environment, patch, readiness helper, and lifecycle artifact

#### Scenario: Reference runtime revision differs
- **WHEN** the real-composition suite runs against a deepseek-harness checkout other than commit `99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`
- **THEN** the suite fails with the expected tag and commit instead of silently accepting an unverified event or CLI contract

