# public-skill-yolo-reviewers Spec Delta

## ADDED Requirements

### Requirement: Standalone surface SHALL provide a yolo lifecycle skill

The `public/skill/` distribution MUST include a `yolo-chorus/SKILL.md` skill that documents the full-auto AI-DLC pipeline (Idea → Elaboration → Proposal → Review → Execute → Verify → Report) as a self-contained guide for any agent that consumes the standalone surface. The skill MUST cover, in order: a prerequisites permission preflight, project resolution, idea creation, self-elaboration, proposal creation with document and task drafts, a proposal review loop, wave-based task execution, a task verification loop, a completion report, and a mandatory idea-completion report.

#### Scenario: yolo-chorus skill exists and is self-contained

- **WHEN** a consumer fetches `<BASE_URL>/skill/yolo-chorus/SKILL.md`
- **THEN** the file MUST exist with valid frontmatter (`name`, `description`, `license`, `metadata`)
- **AND** the body MUST document each pipeline phase from Planning through the Idea Completion Report without requiring the reader to already have any plugin installed

#### Scenario: yolo prerequisites preflight is documented

- **WHEN** the yolo-chorus skill describes prerequisites
- **THEN** it MUST instruct the agent to verify, before starting, that its API key carries `idea:write`, `proposal:write`, `proposal:admin`, `task:write`, `task:admin`, and `project:write`
- **AND** it MUST instruct the agent to abort with a clear message listing any missing resource/action pairs

#### Scenario: yolo mandates the idea completion report

- **WHEN** the yolo-chorus skill documents pipeline completion
- **THEN** it MUST state that a successful run finishes the Idea by calling `chorus_create_report` once with the last verified proposal
- **AND** MUST surface the returned report document identifier in the run summary

### Requirement: Standalone surface SHALL provide two read-only reviewer skills

The `public/skill/` distribution MUST include `proposal-reviewer-chorus/SKILL.md` and `task-reviewer-chorus/SKILL.md`. Each MUST describe a read-only, adversarial review procedure that fetches its target via MCP, audits it, and posts exactly one grep-able `VERDICT:` comment. The reviewer bodies MUST be semantically equivalent to the existing Codex plugin reviewer skills (`plugins/chorus/skills/chorus-proposal-reviewer`, `chorus-task-reviewer`) in their review procedure, finding classification, and verdict contract.

#### Scenario: Both reviewer skills exist with the `-chorus` suffix

- **WHEN** a consumer fetches `<BASE_URL>/skill/proposal-reviewer-chorus/SKILL.md` and `<BASE_URL>/skill/task-reviewer-chorus/SKILL.md`
- **THEN** both files MUST exist with valid frontmatter and a `-chorus`-suffixed `name`
- **AND** their directory names MUST follow the existing `<stage>-chorus` convention used by every other `public/skill/` directory

#### Scenario: Reviewer skills enforce a read-only posture

- **WHEN** the proposal-reviewer-chorus skill describes its constraints
- **THEN** it MUST prohibit creating, modifying, or deleting files and prohibit running shell commands
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

### Requirement: Reviewer invocation in the standalone surface SHALL be framework-neutral

The `public/skill/` skills MUST NOT instruct consumers to invoke reviewers via a harness-specific agent type (such as `chorus:proposal-reviewer` or `chorus:task-reviewer`). Instead, the surface MUST document a single framework-neutral invocation pattern: spawn a read-only sub-agent that loads the matching reviewer skill, then read its `VERDICT:` comment. The canonical description of this pattern MUST live in `chorus/SKILL.md`, and every other reviewer reference in the surface MUST point to it.

#### Scenario: Canonical pattern documented once in the core skill

- **WHEN** a consumer reads `public/skill/chorus/SKILL.md`
- **THEN** it MUST contain an "Independent Review" section that names both reviewer skills and describes the spawn-sub-agent-then-read-VERDICT pattern
- **AND** that section MUST state that the exact spawn mechanism is harness-specific (giving at least one concrete example) and MUST provide an inline self-review fallback for harnesses that cannot spawn sub-agents

#### Scenario: No plugin-specific agent type references remain in the standalone surface

- **WHEN** the change diff for `public/skill/` is reviewed
- **THEN** no `SKILL.md` under `public/skill/` may instruct the consumer to use the `chorus:proposal-reviewer` or `chorus:task-reviewer` agent type as the means of invoking a reviewer
- **AND** the existing `A3.5: Independent Review` subsection in `review-chorus/SKILL.md` Workflow A (which today references `chorus:proposal-reviewer`) MUST be rewritten to the canonical pattern + `proposal-reviewer-chorus`
- **AND** because `review-chorus/SKILL.md` Workflow B (task verification) has **no** Independent Review subsection today, a new one MUST be **added** pointing at the canonical pattern + `task-reviewer-chorus`
- **AND** the Step 8 reviewer note in `develop-chorus/SKILL.md` (which today references `chorus:task-reviewer`) MUST be rewritten to the canonical pattern + `task-reviewer-chorus`

#### Scenario: yolo review loops use the neutral pattern

- **WHEN** the yolo-chorus skill documents its proposal review loop and its task verification loop
- **THEN** each MUST invoke the reviewer via the framework-neutral pattern (not a hardcoded agent type)
- **AND** each MUST handle the three verdict outcomes and include a max-rounds escalation and a no-VERDICT respawn-once rule

### Requirement: Manifest and routing SHALL register every skill and align the version

The `public/skill/` manifest and core skill MUST be updated so that every shipped skill — the three new ones AND the two previously-unregistered ones (`quick-dev-chorus`, `brainstorm-chorus`) — is discoverable and installable, and the surface version MUST be aligned to `0.9.3`. Baseline: `package.json` currently registers only 5 skills (`chorus`, `idea-chorus`, `proposal-chorus`, `develop-chorus`, `review-chorus`); after the change it MUST register 10.

#### Scenario: package.json registers all ten skills

- **WHEN** `public/skill/package.json` is inspected after the change
- **THEN** both the `chorus.files` and `moltbot.files` maps MUST include entries for all of: `chorus/SKILL.md`, `idea-chorus/SKILL.md`, `proposal-chorus/SKILL.md`, `develop-chorus/SKILL.md`, `review-chorus/SKILL.md`, `quick-dev-chorus/SKILL.md`, `brainstorm-chorus/SKILL.md`, `proposal-reviewer-chorus/SKILL.md`, `task-reviewer-chorus/SKILL.md`, and `yolo-chorus/SKILL.md`
- **AND** the top-level `version` MUST be `0.9.3`
- **AND** the `triggers` lists MUST include entries enabling discovery of the yolo and reviewer skills

#### Scenario: chorus/SKILL.md install and routing cover every skill

- **WHEN** `public/skill/chorus/SKILL.md` is inspected after the change
- **THEN** the Skill Files table, both install scripts (Claude Code and Moltbot), and the Skill Routing table MUST each list all ten skills consistently (closing the pre-existing gaps where `quick-dev-chorus` appeared only in routing and `brainstorm-chorus` was absent)
- **AND** the install scripts MUST create each skill directory and curl each `SKILL.md`

#### Scenario: All standalone SKILL.md frontmatter versions are aligned and well-formed

- **WHEN** the frontmatter version of every `public/skill/*/SKILL.md` is inspected after the change
- **THEN** each MUST report version `0.9.3`
- **AND** `quick-dev-chorus/SKILL.md`, which currently uses a non-standard top-level `version` field with no `license`/`metadata` block, MUST be normalized to the standard frontmatter shape (`license` + `metadata.{author,version,category,mcp_server}`) used by the other skills, with `metadata.version: "0.9.3"`

### Requirement: Change SHALL be limited to the standalone skill surface

This change MUST modify only files under `public/skill/`. It MUST NOT modify the Claude Code plugin, the Codex plugin, the OpenClaw plugin, backend code, the Prisma schema, or UI.

#### Scenario: Diff is confined to public/skill

- **WHEN** the change diff is reviewed
- **THEN** every added or modified file MUST be under `public/skill/` (plus the OpenSpec change folder itself)
- **AND** no file under `src/`, `prisma/`, `messages/`, `public/chorus-plugin/`, `plugins/chorus/`, `packages/`, or any other distribution surface may be modified by this change
