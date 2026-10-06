## ADDED Requirements

### Requirement: The plugin SHALL check in and inject Chorus context at the start of every session

On the first turn of each Hermes session (CLI, TUI, or gateway), the plugin MUST call `chorus_checkin` and inject a bounded context block equivalent to the Codex plugin's SessionStart output: `## Checkin` (the check-in JSON), `## Spec Mode` (resolved with the same rules as `plugins/chorus/hooks/resolve-spec-mode.sh`: explicit `CHORUS_SPEC_MODE` wins; otherwise `openspec` when an `openspec/` directory and the `openspec` CLI are both present in the working directory; otherwise `lite`), and `## Quick Reference` (how to load Chorus skills in Hermes). Injection MUST use the `pre_llm_call` hook. It MUST fire on `is_first_turn`, and again on the first turn after an `on_session_reset` event or after context compression (detected when the session's compression count increases, or when `conversation_history` no longer contains the injected marker). This matches the Codex SessionStart matcher `startup|resume|clear|compact`. The injected block MUST be capped at 5000 characters. A check-in failure MUST NOT break the session; it MUST inject a one-line notice that Chorus is unreachable instead.

#### Scenario: Context is injected once per session

- **GIVEN** the plugin is enabled and Chorus is reachable
- **WHEN** a new Hermes session receives its first user message
- **THEN** the model-bound user message MUST include `## Checkin` and `## Spec Mode` sections
- **AND** subsequent turns in the same session MUST NOT re-inject them

#### Scenario: Re-injection after reset or compaction

- **GIVEN** a session whose context was compressed, or that received `/reset`
- **WHEN** the next user turn starts
- **THEN** the `## Checkin` and `## Spec Mode` block MUST be injected again, exactly once

#### Scenario: Chorus unreachable

- **GIVEN** `CHORUS_URL` points at an unreachable host
- **WHEN** a session starts
- **THEN** the session MUST continue
- **AND** the injected context MUST state that Chorus check-in failed

### Requirement: The plugin SHALL emit Codex-parity post-tool reminders

After a successful call to each of the following Chorus MCP tools, the plugin MUST append a reminder to the tool result returned to the model (via `transform_tool_result`), matching the content of the corresponding Codex hook in `plugins/chorus/hooks/` with Hermes-specific spawn instructions:

| Tool | Reminder |
|---|---|
| `chorus_pm_submit_proposal` | Run the proposal reviewer and act on its VERDICT |
| `chorus_submit_for_verify` | Run the task reviewer and act on its VERDICT |
| `chorus_admin_verify_task` | Branch A: OpenSpec archive when the last task of an OpenSpec proposal is done; Branch C: code-review gateway when all tasks of an idea-rooted proposal are done; Branch B: completion report when the proposal is finished and has no report |

Tool-name matching MUST accept any prefix and require the full operation name at the end (the same rule used by the Pi and dsh ports). Reminder computation MUST NOT raise into the agent loop; on error the original result MUST be returned unchanged.

#### Scenario: Proposal submission reminder

- **WHEN** the model calls `mcp__chorus__chorus_pm_submit_proposal` and it succeeds
- **THEN** the tool result seen by the model MUST contain the proposal UUID and an instruction to run the proposal reviewer via `delegate_task`

#### Scenario: Last task verified on an idea-rooted OpenSpec proposal

- **GIVEN** every task of an idea-rooted proposal whose description contains `OpenSpec change slug: <slug>` is done, and no report exists
- **WHEN** `chorus_admin_verify_task` succeeds for the last task
- **THEN** the result MUST contain the archive, code-review gateway, and completion-report reminders

#### Scenario: Unrelated tool is untouched

- **WHEN** any tool whose name does not end with one of the three operation names succeeds
- **THEN** its result MUST be returned byte-identical
