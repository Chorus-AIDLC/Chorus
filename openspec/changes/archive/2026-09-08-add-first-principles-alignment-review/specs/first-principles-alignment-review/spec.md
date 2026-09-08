## ADDED Requirements

### Requirement: Idea resolution and human-authored intent baseline

Each reviewer SHALL resolve the directly-attached Idea from the entity under review using existing reads — proposal-reviewer from the proposal's `inputUuids[0]`, task-reviewer from `chorus_get_task` then that task's proposal's `inputUuids[0]`, code-reviewer from the `ideaUuid` it is given — and SHALL read that Idea via the existing `chorus_get_idea` (content), `chorus_get_elaboration` (resolved decisions, each carrying `answeredBy.type`), and `chorus_get_comments({ targetType: "idea" })` (each comment carrying `author.type`). No new MCP tool SHALL be introduced for this; the alignment check is a reviewer-prompt reminder that self-gathers through existing reads.

The reviewer SHALL build the original-intent **baseline** from HUMAN-authored input only: the Idea `content`, elaboration answers where `answeredBy.type == "user"`, and comments where `author.type == "user"`. Agent-answered elaboration and agent-authored comments SHALL be treated as audit context only and SHALL NOT expand, shrink, or override the baseline. The reviewer's human-vs-agent classification SHALL be fail-closed: an entry counts as human only for the exact actor type `"user"`; `"agent"`, `"agent_instance"`, an unknown type, or a missing type all count as non-human and are excluded from the baseline.

The anchor SHALL be the directly-attached Idea (the first Idea node on the lineage, e.g. a proposal's `inputUuids[0]`) and SHALL NOT be an ancestor theme / root Idea. When the entity has no attached Idea (e.g. a proposal whose `inputType` is not `idea`, or a quick task), the reviewer SHALL skip the alignment dimension rather than error.

#### Scenario: Baseline resolved from a proposal via existing reads

- **WHEN** a reviewer runs on a proposal whose `inputType` is `idea`
- **THEN** it resolves the input Idea from `inputUuids[0]` and reads that Idea's content, resolved elaboration, and Idea comments via the existing `chorus_get_idea` / `chorus_get_elaboration` / `chorus_get_comments`, with no new alignment tool

#### Scenario: Baseline includes only human-authored / human-answered entries

- **WHEN** an attached Idea has both a human-answered elaboration decision and a human-authored comment, AND an agent-self-answered (YOLO) elaboration decision and an agent-authored comment
- **THEN** only the Idea content, the human-answered decision, and the human-authored comment form the baseline, while the agent-answered decision and agent-authored comment are treated as audit context and excluded from the baseline

#### Scenario: Fail-closed author classification

- **WHEN** an elaboration answer or comment carries a stored actor type other than the exact value `"user"` (e.g. `"agent"`, `"agent_instance"`, an unknown type, or a missing type)
- **THEN** it is classified as non-human and excluded from the baseline; only entries with the exact stored type `"user"` enter the baseline

#### Scenario: Task-reviewer resolves upward through its proposal

- **WHEN** the task-reviewer reviews a task of an idea-rooted proposal
- **THEN** it resolves task → its proposal → `inputUuids[0]` and reads that Idea's content, resolved elaboration, and comments, gaining the upward intent visibility it previously lacked

#### Scenario: Theme-nested idea anchors on the direct idea, not the parent theme

- **WHEN** the reviewed entity's input Idea is nested under a parent theme (or parent Idea)
- **THEN** the baseline is built from that child Idea's content / elaboration / comments, not the parent theme's

#### Scenario: Entity with no attached idea

- **WHEN** a reviewer runs on a proposal whose `inputType` is `document` (no attached Idea)
- **THEN** it skips the alignment dimension and does not error

### Requirement: Alignment dimension on every reviewer

Each of the three reviewers — proposal-reviewer, task-reviewer, and code-reviewer — SHALL evaluate the work under review against the human-authored baseline for three drift types: scope creep (work beyond the original intent), requirement loss or shrink (intent stated in the baseline that is dropped or reduced), and semantic drift (the work satisfies its acceptance criteria but misses the baseline's intent).

The reviewer SHALL report the alignment result as a clearly labeled part of its existing VERDICT comment, and SHALL skip the alignment dimension when there is no attached Idea. The reviewer's existing read-only posture, output cap, and `VERDICT: PASS` / `VERDICT: PASS WITH NOTES` / `VERDICT: FAIL` derivation SHALL be preserved.

#### Scenario: Reviewer checks drift against the baseline

- **WHEN** any of the three reviewers runs on an entity with an attached Idea
- **THEN** it evaluates the work against the human-authored baseline for scope creep, requirement loss, and semantic drift, and includes a labeled alignment result in its VERDICT comment

#### Scenario: No baseline available

- **WHEN** a reviewer runs on an entity with no attached Idea
- **THEN** it skips the alignment dimension and its verdict is unaffected by it

### Requirement: Hard-block-with-escape-hatch verdict semantics

Detected intent drift SHALL be classified as a `BLOCKER` (driving `VERDICT: FAIL` / proposal rejection) by default, EXCEPT when the deviation is authorized. A deviation SHALL be treated as authorized — downgraded to a `NOTE` or omitted, never a `BLOCKER` — only when it is traceable to a **human** authorization: a human-authored Idea comment (`author.type == "user"`) recording the scope change, a human-answered elaboration decision (`answeredBy.type == "user"`), OR an explicit human override at the review gate. An agent-authored comment or an agent-self-answered elaboration decision SHALL NOT count as authorization, so a drifting agent cannot self-authorize by posting its own comment or self-answering a YOLO elaboration.

When a reviewer downgrades a deviation on the authorized-change escape hatch, it SHALL cite the specific human entry it relied on, so the decision is human-auditable. This semantics SHALL reuse the existing advisory verdict → behavioral FAIL loops (proposal reject/revise/resubmit, task reopen, code fix-task re-run) and SHALL NOT introduce new server-side status-gating plumbing.

#### Scenario: Undocumented scope creep blocks

- **WHEN** the work adds functionality not present in the baseline and no human-authored comment or human-answered elaboration authorizes it and no human override is present
- **THEN** the reviewer raises a `BLOCKER` and the verdict is `VERDICT: FAIL`

#### Scenario: Human-authored documented scope change does not block

- **WHEN** the same deviation is traceable to a human-authored Idea comment (`author.type == "user"`) or a human-answered elaboration entry (`answeredBy.type == "user"`)
- **THEN** the reviewer does not raise it as a `BLOCKER`, downgrades it to a `NOTE` (or omits it), and cites the specific human entry it relied on

#### Scenario: Agent self-authored comment still blocks

- **WHEN** the only entry that would authorize the deviation is a comment authored by an agent (not a human)
- **THEN** the reviewer treats that comment as audit-only, does not treat it as authorization, and still raises the deviation as a `BLOCKER`

#### Scenario: Agent self-answered elaboration claiming scope still blocks

- **WHEN** an agent self-answers a YOLO elaboration decision (or posts an Idea comment) that would newly bring some scope into the work, and no human entry authorizes it
- **THEN** that agent-originated entry is excluded from the baseline, so the added scope is evaluated as unauthorized drift and raised as a `BLOCKER`

#### Scenario: Human override does not block

- **WHEN** an explicit human override for the deviation is present at the review gate
- **THEN** the reviewer does not raise a `BLOCKER` for that deviation

### Requirement: Compact shared alignment block without prompt bloat

The alignment instruction added to each reviewer SHALL be a single bounded block that carries the resolve-then-read recipe (how to resolve the Idea per reviewer type, and which existing reads to call) plus the baseline / drift / escape-hatch rule, kept compact so per-reviewer prompt growth stays small. The block's rule SHALL be identical across all reviewer definitions, differing only in host-specific tool-name prefix and section framing.

#### Scenario: Block self-gathers via existing reads

- **WHEN** a reviewer definition carries the alignment block
- **THEN** the block references the existing `chorus_get_idea` / `chorus_get_elaboration` / `chorus_get_comments` reads (no new alignment tool) and states the human-baseline / agent-audit rule

#### Scenario: Bounded growth

- **WHEN** the alignment block is added to a reviewer definition
- **THEN** the net addition is a compact bounded block (not a large expansion of the prompt)

### Requirement: Seven-surface parity

The alignment dimension SHALL be present in all three reviewers on every plugin surface — Claude Code, Codex, OpenClaw, Kiro, Pi, dsh, and the standalone skill library — each adapted to its host's tool-name prefix and spawn mechanism while preserving the same resolve-and-read recipe, baseline rule, drift taxonomy, escape-hatch rule, read-only posture, and VERDICT contract. The block body SHALL be byte-consistent across surfaces modulo the tool-name prefix and host section framing.

#### Scenario: Alignment present on every surface

- **WHEN** any of the three reviewers is invoked on any of the seven supported surfaces
- **THEN** its definition carries the alignment block referencing the existing reads by that host's correct tool names (e.g. `chorus__get_idea` on OpenClaw), with the identical baseline / drift / escape-hatch rule
