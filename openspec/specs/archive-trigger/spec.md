# archive-trigger Specification

## Purpose
TBD - created by archiving change add-openspec-archive-trigger-hook. Update Purpose after archive.
## Requirements
### Requirement: A PostToolUse hook on chorus_admin_verify_task SHALL emit an archive reminder when an OpenSpec-mode idea's last task is verified

When `chorus_admin_verify_task` succeeds and the verified task is the final task of an OpenSpec-mode idea (as defined by §3.4 slug provenance), the plugin's PostToolUse hook MUST inject `additionalContext` instructing the main agent to run `openspec archive <slug>` and mirror the resulting `specs/<capability>/spec.md` back to the corresponding Chorus Document.

#### Scenario: Last task of an OpenSpec-mode idea is verified

- **GIVEN** a Chorus idea has 3 tasks, all approved by an admin via `chorus_admin_verify_task`
- **AND** the idea's proposal description contains a line `OpenSpec change slug: my-feature`
- **AND** `openspec --version` exits 0 in the developer's shell
- **WHEN** `chorus_admin_verify_task` is called for the third (last) task
- **THEN** the PostToolUse hook injects an `additionalContext` block whose body contains the literal substring `openspec archive my-feature`
- **AND** the injected block also instructs the agent to mirror updated `openspec/specs/<capability>/spec.md` files back to Chorus Documents via `chorus_pm_update_document`
- **AND** the hook exits 0

#### Scenario: Verified task is NOT the last task of the idea

- **GIVEN** a Chorus idea has 3 tasks, only 2 of which are in `done` status
- **AND** the idea's proposal description contains a line `OpenSpec change slug: my-feature`
- **WHEN** `chorus_admin_verify_task` is called for the second task (third still `to_verify` or `open`)
- **THEN** the hook MUST exit 0 silently with no `additionalContext` emitted
- **AND** no archive reminder is injected

#### Scenario: Idea has no OpenSpec slug (free-form proposal)

- **GIVEN** a Chorus idea whose proposal description does NOT contain a line matching `^OpenSpec change slug: ` (free-form authoring per canonical §4)
- **WHEN** the last task of that idea is verified via `chorus_admin_verify_task`
- **THEN** the hook MUST exit 0 silently with no `additionalContext` emitted
- **AND** no archive reminder is injected
- **AND** the agent's existing free-form behavior is preserved unchanged

#### Scenario: openspec CLI is not installed locally

- **GIVEN** the developer's machine returns non-zero exit from `openspec --version`
- **WHEN** any task is verified via `chorus_admin_verify_task`
- **THEN** the hook MUST exit 0 silently regardless of slug presence
- **AND** no archive reminder is injected

### Requirement: The hook SHALL be installed in BOTH the Claude Code plugin and the Codex plugin with identical detection semantics

The PostToolUse hook MUST be present and registered in both `public/chorus-plugin/hooks/hooks.json` and `plugins/chorus/hooks.json`, and both copies MUST honor the same triple-signal detection contract (slug present + all-tasks-done + openspec installed).

#### Scenario: Both plugin packages register the new matcher

- **GIVEN** a fresh checkout of the repo
- **WHEN** a reviewer inspects `public/chorus-plugin/hooks/hooks.json` and `plugins/chorus/hooks.json`
- **THEN** both files MUST declare a PostToolUse hooks entry with matcher `.*chorus_admin_verify_task`
- **AND** each entry MUST point at a per-package `on-post-verify-task.sh` script

#### Scenario: Detection logic is consistent across plugins

- **GIVEN** the same synthetic PostToolUse event JSON (verified task + slug + all-tasks-done)
- **WHEN** the event is piped to the Claude Code hook AND to the Codex hook
- **THEN** both hooks MUST emit `additionalContext` containing the same `openspec archive <slug>` substring
- **AND** both MUST exit 0

### Requirement: The hook SHALL be Bash 3.2 compatible

The new hook script MUST run on macOS's default `/bin/bash` (Bash 3.2). It MUST NOT use Bash 4+ syntax (`${VAR,,}`, `${VAR^^}`, `declare -A`, `mapfile`, `readarray`, `|&`, `&>>`).

#### Scenario: Hook passes the project's syntax check

- **GIVEN** the new `on-post-verify-task.sh` exists in both plugin packages
- **WHEN** `/bin/bash public/chorus-plugin/bin/test-syntax.sh` runs (per CLAUDE.md pitfall #10)
- **THEN** the script MUST report success for both copies
- **AND** the test MUST fail loudly if any Bash 4-only feature is introduced

### Requirement: The skill canonical SHALL document the archive trigger contract in §3.9

`scripts/openspec-skill/canonical/openspec-aware.md` MUST gain a new §3.9 "Archive after the last task is verified" section that explains the trigger semantics, the agent's archive + mirror-back responsibility, and the halt-on-error rule.

#### Scenario: Canonical §3.9 explains the agent's archive responsibility

- **WHEN** a reader inspects the canonical openspec-aware.md
- **THEN** §3.9 MUST exist and contain at minimum: (a) trigger description (PostToolUse hook on `chorus_admin_verify_task`), (b) the four-step agent action sequence (run archive → read each spec.md → call `chorus_pm_update_document` → halt on error), (c) reference to canonical §3.8 for mirror-back specifics, (d) reference to §6 for the no-silent-errors rule

#### Scenario: Canonical sync produces 3 consistent copies

- **GIVEN** §3.9 is added to the canonical
- **WHEN** `scripts/sync-openspec-skill.sh` runs
- **THEN** §3.9 MUST appear (with package-appropriate `${CHORUS_API_SH}` substitution) in `public/chorus-plugin/skills/chorus/openspec-aware.md`, `plugins/chorus/skills/chorus/openspec-aware.md`, and `public/skill/openspec-aware.md`
- **AND** all three synced copies MUST be byte-equal modulo the wrapper-path substitution

