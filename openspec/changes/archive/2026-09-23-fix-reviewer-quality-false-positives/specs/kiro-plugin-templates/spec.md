# kiro-plugin-templates

## MODIFIED Requirements

### Requirement: Reviewer agents are read-only subagents
Each of the three reviewer agents (`chorus-code-reviewer`, `chorus-proposal-reviewer`, `chorus-task-reviewer`) SHALL be scoped read-only. All three SHALL declare `tools` of exactly `read`, `shell`, and `@chorus`, and none SHALL declare `write`.

Kiro is the one surface whose tool grant is declarative, and it **does** support command-level scoping — `permissions.rules` entries carrying `capability`, `match`, `effect` (`allow` / `ask` / `deny`) and an optional `exclude`, valid inline in the agent profile. (An earlier revision of this requirement asserted no per-command allow-list existed and used that to justify prompt-only enforcement; that premise was wrong. The older `toolsSettings.shell.allowedCommands` form is deprecated as of CLI 3.0 and retained only for MCP tool settings, so `permissions` is the form to use.)

Each reviewer SHALL therefore carry machine-enforced `permissions.rules` in addition to its prompt's prohibited-command list, so that read-only-ness does not rest on the prompt alone:

- a `deny` rule on `fs_write`, reinforcing the absent `write` tool at capability level;
- `deny` rules on `shell` covering mutating operations: file writes, git write operations, package installs, privilege escalation, and mutating HTTP verbs.

Rules SHALL be expressed as `deny` only. An allow-list of permitted commands SHALL NOT be shipped, because the commands a reviewer legitimately needs — the project's own test, build, and lint invocations — are project-specific, and these templates are installed into arbitrary repositories. Denying the mutating operations is project-independent and is the security-relevant half.

The prompt's prohibited-command list SHALL remain the contract on every surface, because only some harnesses can restrict tools; the `permissions` rules are defence in depth on the one surface that can, not a replacement for the stated contract.

Every reviewer SHALL carry a `description` that lets Kiro auto-select it for the matching review task, and SHALL preserve the VERDICT protocol (PASS / PASS WITH NOTES / FAIL) ported from the Claude Code reviewer agents.

#### Scenario: Every reviewer grants read-only shell but never write
- **WHEN** any `agents/chorus-*-reviewer.json` is read
- **THEN** its `tools` contain exactly `read`, `shell`, and `@chorus`, with no `write` entry

#### Scenario: Mutating operations are denied by configuration, not only by prompt
- **WHEN** any `agents/chorus-*-reviewer.json` is read
- **THEN** it carries a `permissions.rules` array containing a `deny` rule for `fs_write`
- **AND** a `deny` rule for `shell` whose `match` patterns cover file writes, git write operations, and package installs

#### Scenario: No command allow-list is shipped
- **WHEN** any reviewer's `permissions.rules` entries are read
- **THEN** every rule's `effect` is `deny`, so no project-specific command is presumed

#### Scenario: The proposal reviewer additionally may not run builds
- **WHEN** `agents/chorus-proposal-reviewer.json` is read
- **THEN** its `shell` deny patterns also cover common test and build runners, because proposal review precedes implementation

#### Scenario: Each reviewer's prompt still bounds its shell use
- **WHEN** any `agents/chorus-*-reviewer.json` prompt is read
- **THEN** it states that shell use is read-only inspection only, naming the permitted commands and the forbidden mutating operations
- **AND** the prompt remains the stated contract rather than deferring enforcement to the harness

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
