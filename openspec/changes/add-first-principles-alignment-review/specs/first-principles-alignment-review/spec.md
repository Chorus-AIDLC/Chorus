## ADDED Requirements

### Requirement: Consolidated alignment-anchor resolution

The system SHALL provide a single read tool `chorus_get_alignment_anchor` that, given a reviewable entity (`entityType` ∈ `idea` | `proposal` | `task` | `document`, plus `entityUuid`), resolves the directly-attached Idea(s) via the existing lineage resolution and returns the "original intent" anchor bundle in one payload; plus `directIdeaUuid`, `rootIdeaUuid`, ancestor `lineageTitles`, and an `anchorAvailable` flag.

For each attached Idea the bundle SHALL be **structurally split** into a human-authorized **baseline** and an audit-only **agent context**: the baseline is the Idea `content`, the elaboration decisions **answered by a human** (`baselineElaboration`, each with `answeredByType`), and the comments **authored by a human** (`humanComments`, each with `authorType`); the `agentContext` object carries the agent-answered elaboration decisions and agent-authored comments. The baseline is the sole representation of original intent; `agentContext` is provided for audit only. The classifier that assigns the human-vs-agent tag SHALL be **fail-closed**: it SHALL treat an entry as human (`"user"`) only for the exact stored actor type `"user"`, and SHALL treat every other value — including `"agent"`, `"agent_instance"`, an unknown type, or a missing type — as non-human (`"agent"`). Consequently a human-authored/-answered entry SHALL appear only in the baseline and an agent-originated entry SHALL appear only in `agentContext`.

The anchor SHALL be the **directly-attached** Idea — `directIdeaUuid`, the first Idea node on the lineage (e.g. a proposal's `inputUuids[0]`) — and SHALL NOT be the ancestor `rootIdeaUuid`. For an Idea nested under a parent theme or parent Idea, the anchor is that child Idea itself, never its ancestor. `rootIdeaUuid` and `lineageTitles` are returned only as secondary context.

The tool SHALL require the `idea:read` permission, SHALL be tenant-scoped by `companyUuid`, and SHALL NOT expose any field not already independently readable via `chorus_get_idea`, `chorus_get_elaboration`, and `chorus_get_comments` — it only consolidates those reads.

When the entity has no attached Idea (e.g. a proposal whose `inputType` is not `idea`), the tool SHALL return `anchorAvailable: false` with an empty `ideas` list rather than an error.

#### Scenario: Anchor resolved from a proposal

- **WHEN** `chorus_get_alignment_anchor` is called with `entityType: "proposal"` for a proposal whose `inputType` is `idea`
- **THEN** it returns `anchorAvailable: true` and, for each input Idea, that Idea's content, its resolved elaboration decisions, and its comments

#### Scenario: Anchor separates the human-authorized baseline from agent context

- **WHEN** an attached Idea has both a human-answered elaboration decision and a human-authored comment, AND an agent-self-answered (YOLO) elaboration decision and an agent-authored comment
- **THEN** the human-answered decision appears in `baselineElaboration` and the human-authored comment in `humanComments`, while the agent-answered decision and agent-authored comment appear only under `agentContext` — no agent-originated entry appears in the baseline

#### Scenario: Fail-closed author classification

- **WHEN** an elaboration answer or comment carries a stored actor type other than the exact value `"user"` (e.g. `"agent"`, `"agent_instance"`, an unknown type, or a missing type)
- **THEN** it is classified as non-human and placed in `agentContext`, and only entries with the exact stored type `"user"` are placed in the baseline

#### Scenario: Anchor resolved from a task through its proposal

- **WHEN** `chorus_get_alignment_anchor` is called with `entityType: "task"` for a task belonging to an idea-rooted proposal
- **THEN** it walks task → proposal → Idea and returns that Idea's anchor bundle with `resolvedVia` describing the path

#### Scenario: Theme-nested idea anchors on the direct idea, not the parent theme

- **WHEN** the anchor is resolved for a proposal whose input Idea is nested under a parent theme (or parent Idea)
- **THEN** the returned anchor is that child Idea (`directIdeaUuid`), and its title/content/elaboration/comments — not the parent theme's

#### Scenario: Entity with no attached idea

- **WHEN** the tool is called for a proposal whose `inputType` is `document` (no attached Idea)
- **THEN** it returns `anchorAvailable: false` and an empty `ideas` list, and does not error

#### Scenario: Permission gate

- **WHEN** an agent without the `idea:read` permission calls `chorus_get_alignment_anchor`
- **THEN** the call is rejected on the missing permission

### Requirement: Alignment dimension on every reviewer

Each of the three reviewers — proposal-reviewer, task-reviewer, and code-reviewer — SHALL fetch the alignment anchor for the entity it is reviewing (via `chorus_get_alignment_anchor`) and evaluate the work under review against that anchor for three drift types: scope creep (work beyond the original intent), requirement loss or shrink (intent explicitly stated in the anchor that is dropped or reduced), and semantic drift (the work satisfies its acceptance criteria but misses the anchor's intent).

The reviewer SHALL report the alignment result as a clearly labeled part of its existing VERDICT comment, and SHALL skip the alignment dimension when `anchorAvailable` is false. The reviewer's existing read-only posture, output cap, and `VERDICT: PASS` / `VERDICT: PASS WITH NOTES` / `VERDICT: FAIL` derivation SHALL be preserved.

#### Scenario: Reviewer fetches the anchor and checks drift

- **WHEN** any of the three reviewers runs on an entity with an attached Idea
- **THEN** it calls `chorus_get_alignment_anchor`, evaluates the work against the returned intent for scope creep, requirement loss, and semantic drift, and includes a labeled alignment result in its VERDICT comment

#### Scenario: Task-reviewer gains upward intent visibility

- **WHEN** the task-reviewer reviews a task of an idea-rooted proposal
- **THEN** it obtains the root Idea's content, resolved elaboration, and Idea comments through the anchor tool and evaluates the task's output against that original intent

#### Scenario: No anchor available

- **WHEN** a reviewer runs on an entity where `anchorAvailable` is false
- **THEN** it skips the alignment dimension and its verdict is unaffected by it

### Requirement: Hard-block-with-escape-hatch verdict semantics

The reviewer SHALL build the original intent from the anchor's **baseline** (Idea `content` + `baselineElaboration` + `humanComments`) alone; the `agentContext` (agent-answered elaboration + agent-authored comments) SHALL be treated as audit-only and SHALL NOT expand, shrink, or override that baseline.

Detected intent drift SHALL be classified as a `BLOCKER` (driving `VERDICT: FAIL` / proposal rejection) by default, EXCEPT when the deviation is authorized. A deviation SHALL be treated as authorized — downgraded to a `NOTE` or omitted, never a `BLOCKER` — only when it is traceable to a **baseline** authorization: a `humanComments` entry recording the scope change, a `baselineElaboration` decision, OR an explicit human override at the review gate. An `agentContext` entry (an agent-authored comment or an agent-self-answered elaboration decision) SHALL NOT count as authorization, so a drifting agent cannot self-authorize by posting its own comment or self-answering a YOLO elaboration.

When a reviewer downgrades a deviation on the authorized-change escape hatch, it SHALL cite the specific human-originated anchor entry it relied on, so the decision is human-auditable.

This semantics SHALL reuse the existing advisory verdict → behavioral FAIL loops (proposal reject/revise/resubmit, task reopen, code fix-task re-run) and SHALL NOT introduce new server-side status-gating plumbing.

#### Scenario: Undocumented scope creep blocks

- **WHEN** the work adds functionality not present in the anchor and no anchor comment or elaboration authorizes it and no human override is present
- **THEN** the reviewer raises a `BLOCKER` and the verdict is `VERDICT: FAIL`

#### Scenario: Human-authored documented scope change does not block

- **WHEN** the same deviation is traceable to a human-authored Idea comment or a human-answered elaboration entry in the anchor
- **THEN** the reviewer does not raise it as a `BLOCKER`, downgrades it to a `NOTE` (or omits it), and cites the specific human-originated anchor entry it relied on

#### Scenario: Agent self-authored comment still blocks

- **WHEN** the only anchor entry that would authorize the deviation is a comment authored by an agent (not a human)
- **THEN** the entry appears under `agentContext`, not in the baseline; the reviewer does not treat it as authorization and still raises the deviation as a `BLOCKER`

#### Scenario: Agent self-answered elaboration claiming scope still blocks

- **WHEN** an agent self-answers a YOLO elaboration decision (or posts an Idea comment) that would newly bring some scope into the work, and no human-originated baseline entry authorizes it
- **THEN** that agent-originated entry appears only under `agentContext` and never in the baseline, so the added scope is evaluated as unauthorized drift and raised as a `BLOCKER`

#### Scenario: Human override does not block

- **WHEN** an explicit human override for the deviation is present at the review gate
- **THEN** the reviewer does not raise a `BLOCKER` for that deviation

### Requirement: Compact shared alignment contract without prompt bloat

The alignment instruction added to each reviewer SHALL be a single bounded block that delegates all intent data-gathering to `chorus_get_alignment_anchor` rather than embedding a multi-step fetch recipe or the intent text itself, keeping per-reviewer prompt growth small. The block's rule (anchor source, three drift types, hard-block-with-escape-hatch) SHALL be identical across all reviewer definitions, differing only in host-specific tool-name prefix and spawn/format wording.

#### Scenario: Instruction delegates data-gathering to the tool

- **WHEN** a reviewer definition carries the alignment block
- **THEN** the block references `chorus_get_alignment_anchor` as the single anchor source and does not embed a separate multi-call fetch recipe or copies of the Idea intent

#### Scenario: Bounded growth

- **WHEN** the alignment block is added to a reviewer definition
- **THEN** the net addition is a compact bounded block (not a large expansion of the prompt)

### Requirement: Seven-surface parity

The alignment dimension SHALL be present in all three reviewers on every plugin surface — Claude Code, Codex, OpenClaw, Kiro, Pi, dsh, and the standalone skill library — each adapted to its host's tool-name prefix and spawn mechanism while preserving the same anchor source, drift taxonomy, escape-hatch rule, read-only posture, and VERDICT contract.

#### Scenario: Alignment present on every surface

- **WHEN** any of the three reviewers is invoked on any of the seven supported surfaces
- **THEN** its definition carries the alignment block referencing the anchor tool by that host's correct tool name, with the identical drift/escape-hatch rule
