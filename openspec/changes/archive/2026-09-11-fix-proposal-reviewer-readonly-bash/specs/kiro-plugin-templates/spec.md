## MODIFIED Requirements

### Requirement: Reviewer agents are read-only subagents
Each of the three reviewer agents (`chorus-code-reviewer`, `chorus-proposal-reviewer`, `chorus-task-reviewer`) SHALL be scoped read-only: `chorus-code-reviewer` and `chorus-task-reviewer` SHALL declare `tools` of only `read` and `@chorus` (no `write`, no `shell`), and `chorus-proposal-reviewer` SHALL declare `tools` of `read`, `shell`, and `@chorus` (no `write`), with its shell access constrained to read-only inspection by its prompt rather than by tool omission. Every reviewer SHALL carry a `description` that lets Kiro auto-select it for the matching review task, and SHALL preserve the VERDICT protocol (PASS / PASS WITH NOTES / FAIL) ported from the Claude Code reviewer agents.

#### Scenario: Code and task reviewer tool scope excludes write and shell
- **WHEN** `agents/chorus-code-reviewer.json` or `agents/chorus-task-reviewer.json` is read
- **THEN** its `tools` contain `read` and `@chorus` only, with no `write` or `shell` entry

#### Scenario: Proposal reviewer grants shell but never write
- **WHEN** `agents/chorus-proposal-reviewer.json` is read
- **THEN** its `tools` contain exactly `read`, `shell`, and `@chorus`, with no `write` entry
- **AND** its prompt states that shell use is read-only inspection only, naming the permitted commands and the forbidden mutating operations (file writes, git write operations, package installs, test/build runs)

#### Scenario: Reviewer description enables auto-selection
- **WHEN** any `agents/chorus-*-reviewer.json` is read
- **THEN** its `description` names the review task it handles, so Kiro can auto-select it for the matching review

#### Scenario: Reviewer carries the VERDICT protocol
- **WHEN** a reviewer agent's prompt (inline or `file://` sidecar) is read
- **THEN** it instructs the reviewer to post a comment ending in `VERDICT: PASS`, `VERDICT: PASS WITH NOTES`, or `VERDICT: FAIL`, matching the Claude Code reviewer contract
