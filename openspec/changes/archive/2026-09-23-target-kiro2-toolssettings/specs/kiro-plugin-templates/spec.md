# kiro-plugin-templates

## MODIFIED Requirements

### Requirement: Reviewer agents are read-only subagents
Each of the three reviewer agents (`chorus-code-reviewer`, `chorus-proposal-reviewer`, `chorus-task-reviewer`) SHALL be scoped read-only. All three SHALL declare `tools` of exactly `read`, `shell`, and `@chorus`, and none SHALL declare `write`.

**These templates target Kiro 2.x.** Read-only-ness SHALL therefore be machine-enforced through `toolsSettings.shell` in the agent profile — the 2.x mechanism — and SHALL NOT use the CLI 3.0 `permissions.rules` key, whose handling on a 2.x installation is undocumented. (Two earlier revisions were wrong here in opposite directions: the first asserted no per-command scoping existed at all; the second used the 3.0 `permissions` key. Kiro is the one surface whose grant is declarative, so it is the one surface where read-only-ness can be enforced by configuration rather than only instructed — but it must be enforced with the mechanism the targeted version actually has.)

`toolsSettings.shell` entries are **regular expressions anchored with `\A` and `\z`**. Every pattern that is meant to match a command with arguments SHALL therefore carry an explicit wildcard tail; a bare `git commit` matches only that exact command line and silently enforces nothing. Look-around is not supported.

All three reviewers SHALL set:

- `autoAllowReadonly: true`, so read-only inspection runs without prompting;
- `deniedCommands` covering mutating operations: file writes, git write operations, package installs, privilege escalation, and mutating HTTP verbs. Deny is evaluated before allow, so these hold regardless of any other setting.

`chorus-proposal-reviewer` SHALL additionally set `denyByDefault: true` together with an `allowedCommands` list of read-only inspection commands. Because proposal review precedes implementation, its contract forbids test and build runs entirely; `denyByDefault` with a read-only allow-list machine-enforces exactly that, and both lists stay project-independent. `chorus-code-reviewer` and `chorus-task-reviewer` SHALL NOT set `denyByDefault`, because they must run the project's own test and build commands, which these templates cannot know.

No command allow-list naming project-specific test, build, or lint commands SHALL be shipped for the code or task reviewers, since these templates install into arbitrary repositories.

The prompt's prohibited-command list SHALL remain the contract on every surface, because only some harnesses can restrict tools; the `toolsSettings` rules are defence in depth on the one surface that can, not a replacement for the stated contract.

Every reviewer SHALL carry a `description` that lets Kiro auto-select it for the matching review task, and SHALL preserve the VERDICT protocol (PASS / PASS WITH NOTES / FAIL) ported from the Claude Code reviewer agents.

#### Scenario: Every reviewer grants read-only shell but never write
- **WHEN** any `agents/chorus-*-reviewer.json` is read
- **THEN** its `tools` contain exactly `read`, `shell`, and `@chorus`, with no `write` entry

#### Scenario: Enforcement uses the Kiro 2.x mechanism
- **WHEN** any `agents/chorus-*-reviewer.json` is read
- **THEN** it carries `toolsSettings.shell` with `autoAllowReadonly` and a non-empty `deniedCommands`
- **AND** it carries no `permissions` key

#### Scenario: Deny patterns survive regex anchoring
- **WHEN** a `deniedCommands` or `allowedCommands` pattern is intended to match a command invoked with arguments
- **THEN** the pattern ends in a wildcard, so that anchoring with `\A` and `\z` does not reduce it to an exact-string match

#### Scenario: Mutating operations are denied
- **WHEN** the reviewer's `deniedCommands` are evaluated against `git commit -m "x"`, `pip install requests`, `rm -rf build`, `sudo apt install x`, or `curl -X POST https://host/path`
- **THEN** each is denied
- **AND** `git log --oneline` and `grep -rn foo src/` are not denied

#### Scenario: The proposal reviewer cannot run builds
- **WHEN** `agents/chorus-proposal-reviewer.json` is read
- **THEN** it sets `denyByDefault: true` and an `allowedCommands` list containing only read-only inspection commands
- **AND** a project build or test invocation is absent from that list and therefore denied

#### Scenario: The code and task reviewers can still run the project's tests
- **WHEN** `agents/chorus-code-reviewer.json` or `agents/chorus-task-reviewer.json` is read
- **THEN** it does not set `denyByDefault`, and ships no allow-list naming project-specific commands

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
