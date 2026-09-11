## MODIFIED Requirements

### Requirement: Standalone surface SHALL provide two read-only reviewer skills

The `public/skill/` distribution MUST include `proposal-reviewer-chorus/SKILL.md` and `task-reviewer-chorus/SKILL.md`. Each MUST describe a read-only, adversarial review procedure that fetches its target via MCP, audits it, and posts exactly one grep-able `VERDICT:` comment. The reviewer bodies MUST be semantically equivalent to the existing Codex plugin reviewer skills (`plugins/chorus/skills/chorus-proposal-reviewer`, `chorus-task-reviewer`) in their review procedure, finding classification, and verdict contract.

"Read-only" means no mutation of the repository or of Chorus state beyond the single review comment. It does NOT mean the absence of shell: both reviewer skills MUST permit read-only shell inspection and MUST prohibit mutation by naming the forbidden commands.

#### Scenario: Both reviewer skills exist with the `-chorus` suffix

- **WHEN** a consumer fetches `<BASE_URL>/skill/proposal-reviewer-chorus/SKILL.md` and `<BASE_URL>/skill/task-reviewer-chorus/SKILL.md`
- **THEN** both files MUST exist with valid frontmatter and a `-chorus`-suffixed `name`
- **AND** their directory names MUST follow the existing `<stage>-chorus` convention used by every other `public/skill/` directory

#### Scenario: Reviewer skills enforce a read-only posture

- **WHEN** the proposal-reviewer-chorus skill describes its constraints
- **THEN** it MUST prohibit creating, modifying, or deleting files, and MUST prohibit git write operations and package installs
- **AND** it MUST permit read-only shell inspection, naming the allowed commands, while prohibiting test and build execution
- **AND** it MUST require the reviewer to confirm a file or directory exists before flagging it as missing
- **WHEN** the task-reviewer-chorus skill describes its constraints
- **THEN** it MUST permit only read-only and test/build Bash commands and MUST prohibit file mutation and git write operations

#### Scenario: Reviewer skills emit one of exactly three verdict literals

- **WHEN** either reviewer skill documents its output contract
- **THEN** it MUST require the review to end with exactly one of `VERDICT: PASS`, `VERDICT: PASS WITH NOTES`, or `VERDICT: FAIL`
- **AND** it MUST define the mapping: any BLOCKER → FAIL, only NOTEs → PASS WITH NOTES, nothing → PASS
- **AND** it MUST require the verdict to be posted as a comment via `chorus_add_comment` on the reviewed target

#### Scenario: Reviewer skills classify findings and respect round awareness

- **WHEN** either reviewer skill documents finding classification
- **THEN** it MUST distinguish BLOCKER (blocks correctness/implementation) from NOTE (non-blocking), and MUST classify pseudocode and cross-document wording mismatches as NOTE
- **AND** it MUST instruct that on Round 2+ the reviewer focuses only on whether previously raised BLOCKERs were fixed, introducing no new NOTEs
