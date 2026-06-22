# Code-Review Gateway Spec

## ADDED Requirements

### Requirement: Code-reviewer subagent definition

The system SHALL provide a read-only `code-reviewer` subagent that reviews the aggregate code change behind a single Idea and posts exactly one structured VERDICT comment per review round on that Idea.

The subagent SHALL be read-only: it MUST NOT edit, write, or create project files, and its Bash access MUST be limited to read-only and test/build commands (no git write operations, no package installs, no file mutations) — identical to the task-reviewer posture.

The subagent SHALL end every review with a verdict line that is exactly one of `VERDICT: PASS`, `VERDICT: PASS WITH NOTES`, or `VERDICT: FAIL`, derived from finding classification: any BLOCKER → FAIL; only NOTEs → PASS WITH NOTES; nothing → PASS.

The subagent SHALL post its review via `chorus_add_comment` with `targetType: "idea"` and the reviewed Idea's UUID.

#### Scenario: Aggregate review posts a verdict on the idea

- **WHEN** the code-reviewer is spawned with an `ideaUuid` and completes its review
- **THEN** it posts a single comment on that Idea (`targetType: "idea"`) containing its findings and a final `VERDICT:` line that is one of PASS, PASS WITH NOTES, or FAIL

#### Scenario: Read-only posture is enforced

- **WHEN** the code-reviewer runs
- **THEN** it performs no project-file writes and no git write operations, using only read-only and test/build commands to inspect the aggregate change

#### Scenario: Verdict reflects finding classification

- **WHEN** the reviewer finds at least one BLOCKER
- **THEN** the verdict is `VERDICT: FAIL`
- **WHEN** the reviewer finds only NOTE-level issues
- **THEN** the verdict is `VERDICT: PASS WITH NOTES`
- **WHEN** the reviewer finds nothing
- **THEN** the verdict is `VERDICT: PASS`

### Requirement: Whole-feature review dimensions

The code-reviewer SHALL focus on dimensions that are only observable at the aggregate level, distinct from the single-task focus of the task-reviewer: cross-task integration and contract consistency, architecture and convention consistency (no drift), security risk introduced by the aggregate change, regression risk and impact on untouched areas and performance, feature-level test coverage adequacy, and the soundness, simplicity, and correctness of the aggregate change.

The code-reviewer SHALL determine the aggregate change scope itself through read-only repository exploration (combining task work reports with repository state such as `git log` / `git diff`), without assuming a strict branch convention, and SHALL state the scope it settled on in its comment.

#### Scenario: Reviewer states its inferred scope

- **WHEN** the code-reviewer reviews an idea whose tasks did not follow a strict branch convention
- **THEN** it infers the aggregate change scope from task reports plus repository state and states that scope in its verdict comment

### Requirement: Auto-trigger on last task verification

The Claude Code plugin's `chorus_admin_verify_task` PostToolUse hook SHALL, when the verified task is the last terminal task of an idea-rooted proposal and the code-reviewer is enabled, inject an `additionalContext` reminder instructing the agent to spawn the code-reviewer for that idea.

This trigger branch SHALL be read-only (it injects a reminder only; it MUST NOT post comments or mutate any resource), SHALL be gated by the `enableCodeReviewer` plugin configuration option (default enabled), and SHALL only fire for proposals whose `inputType` is `idea`. When the toggle is off, or the proposal is not idea-rooted, or not every task of the proposal is terminal, the branch SHALL skip silently.

The injected reminder SHALL contain a stable literal substring identifying the spawn action, so it is machine-detectable by tests.

When the code-review reminder and the idea-completion-report reminder both fire on the same verification event, the combined reminder output SHALL place the code-review reminder before the completion-report reminder, and the workflow guidance SHALL direct the agent to run the code-review gateway before writing the idea-completion report.

#### Scenario: Last task verified fires the code-review reminder

- **WHEN** the last task of an idea-rooted proposal is admin-verified and `enableCodeReviewer` is enabled
- **THEN** the hook injects an `additionalContext` reminder instructing the agent to spawn the code-reviewer for that idea

#### Scenario: Toggle off skips silently

- **WHEN** the last task of an idea-rooted proposal is verified but `enableCodeReviewer` is disabled
- **THEN** the hook injects no code-review reminder

#### Scenario: Non-final task verification does not fire

- **WHEN** a task is verified but other tasks of the same proposal are not yet terminal
- **THEN** the hook injects no code-review reminder

#### Scenario: Non-idea proposal does not fire

- **WHEN** the verified task belongs to a proposal whose `inputType` is not `idea`
- **THEN** the hook injects no code-review reminder

#### Scenario: Code-review reminder precedes completion-report reminder

- **WHEN** both the code-review reminder and the idea-completion-report reminder fire on the same verification event
- **THEN** the combined injected output places the code-review reminder before the completion-report reminder, and the workflow guidance directs running the code-review gateway before writing the completion report

### Requirement: FAIL recovery via fix tasks

On a FAIL verdict, the workflow SHALL recover by creating new fix tasks on the existing approved proposal targeting the reviewer's BLOCKERs, rather than reopening previously completed tasks. After the fix tasks reach a terminal state, the code-reviewer SHALL be re-run as a subsequent review round.

Re-review rounds SHALL be bounded by the `maxCodeReviewRounds` configuration option (default 3; 0 means unlimited), after which the workflow escalates to a human.

#### Scenario: FAIL adds fix tasks and re-runs

- **WHEN** the code-reviewer returns FAIL with BLOCKERs
- **THEN** the workflow creates new fix tasks on the existing approved proposal for those BLOCKERs and, once they are done, re-runs the code-reviewer as the next round

#### Scenario: Round cap escalates to human

- **WHEN** the code-reviewer keeps returning FAIL and the number of rounds reaches `maxCodeReviewRounds` (when non-zero)
- **THEN** the workflow stops the automatic loop and escalates the persisting BLOCKERs to a human

### Requirement: Round-aware re-review

On review round 2 and later, the code-reviewer SHALL focus only on whether previously reported BLOCKERs were fixed, re-reading only the files and re-running only the tests tied to those BLOCKERs, and SHALL NOT introduce new NOTE-level findings or rescan unrelated code. The reviewer reads its prior verdict comments on the Idea to establish round context.

#### Scenario: Round 2 checks only prior blockers

- **WHEN** the code-reviewer runs on round 2 or later
- **THEN** it re-verifies only the previously reported BLOCKERs and does not introduce new NOTE-level findings on unrelated code

### Requirement: Four-surface parity and configuration

The code-reviewer SHALL be defined on all four plugin surfaces — the Claude Code plugin agent, the standalone skill library, the Codex plugin skill, and the OpenClaw plugin skill — each adapted to its host's spawn mechanism and tool-name prefix while preserving the same read-only posture and VERDICT contract.

The Claude Code plugin configuration SHALL expose an `enableCodeReviewer` boolean option (default true) and a `maxCodeReviewRounds` number option (default 3), parallel to the existing proposal- and task-reviewer options.

The lifecycle workflow skills (yolo, develop, review) and the canonical Independent Review guidance SHALL document spawning the code-reviewer as the final pre-ship gateway, including the FAIL → add fix tasks → re-run loop, in YOLO as a full-auto closed loop and elsewhere as advisory guidance for the orchestrator.

#### Scenario: Gateway present on every surface

- **WHEN** an agent operates on any of the four supported surfaces (Claude Code, standalone, Codex, OpenClaw)
- **THEN** a code-reviewer definition is available there with an equivalent read-only posture and VERDICT contract

#### Scenario: Configuration toggles are available

- **WHEN** a user configures the Claude Code plugin
- **THEN** `enableCodeReviewer` (default true) and `maxCodeReviewRounds` (default 3) are exposed alongside the existing reviewer options
