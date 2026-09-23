# kiro-plugin-templates

## MODIFIED Requirements

### Requirement: Reviewer agents are read-only subagents
Each of the three reviewer agents (`chorus-code-reviewer`, `chorus-proposal-reviewer`, `chorus-task-reviewer`) SHALL be scoped read-only. All three SHALL declare `tools` of exactly `read`, `shell`, and `@chorus`, and none SHALL declare `write`. Read-only-ness SHALL be constrained by each prompt's prohibited-command list rather than by omitting the `shell` tool, matching the posture on every other distribution surface — Kiro's `tools` field is a flat name list with no per-command allow-list, so a scoped shell is not available. Every reviewer SHALL carry a `description` that lets Kiro auto-select it for the matching review task, and SHALL preserve the VERDICT protocol (PASS / PASS WITH NOTES / FAIL) ported from the Claude Code reviewer agents.

#### Scenario: Every reviewer grants read-only shell but never write
- **WHEN** any `agents/chorus-*-reviewer.json` is read
- **THEN** its `tools` contain exactly `read`, `shell`, and `@chorus`, with no `write` entry

#### Scenario: Each reviewer's prompt bounds its shell use
- **WHEN** any `agents/chorus-*-reviewer.json` prompt is read
- **THEN** it states that shell use is read-only inspection only, naming the permitted commands and the forbidden mutating operations (file writes, git write operations, package installs)
- **AND** for `chorus-proposal-reviewer` the forbidden list also covers test and build runs, because proposal review precedes implementation

#### Scenario: Code and task reviewers can produce run evidence
- **WHEN** `agents/chorus-code-reviewer.json` or `agents/chorus-task-reviewer.json` is read
- **THEN** its prompt requires running the project's or the task's build/test commands and quoting the real output, rather than substituting the developer's reported output for its own verification
- **AND** no statement in the prompt claims the reviewer has no shell

#### Scenario: Reviewer description enables auto-selection
- **WHEN** any `agents/chorus-*-reviewer.json` is read
- **THEN** its `description` names the review task it handles, so Kiro can auto-select it for the matching review

#### Scenario: Reviewer carries the VERDICT protocol
- **WHEN** a reviewer agent's prompt (inline or `file://` sidecar) is read
- **THEN** it instructs the reviewer to post a comment ending in `VERDICT: PASS`, `VERDICT: PASS WITH NOTES`, or `VERDICT: FAIL`, matching the Claude Code reviewer contract
