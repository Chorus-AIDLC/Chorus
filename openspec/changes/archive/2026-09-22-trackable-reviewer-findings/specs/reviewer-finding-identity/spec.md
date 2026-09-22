# reviewer-finding-identity Specification (delta)

## ADDED Requirements

### Requirement: Relevance budget replaces total-output character caps

Every Chorus reviewer definition SHALL bound its output by relevance, not by a character budget.
No reviewer definition SHALL instruct the reviewer to keep its total output under a fixed number
of characters.

Each definition SHALL state that BLOCKER evidence is unbounded — the full evidence the output
format requires is always written — and that at most 5 **newly-raised** NOTEs are reported per
round, with the excess dropped by relevance rather than compressed.

Each definition SHALL state explicitly that the NOTE limit applies only to newly-raised NOTEs and
never to carried-forward acknowledgement lines for findings from earlier rounds.

Each definition SHALL preserve its existing round-2+ rule that no new NOTEs are introduced on
areas not flagged in previous rounds, and SHALL state how the two rules compose: in round 1 at
most 5 newly-raised NOTEs and no carried-forward lines exist; in round 2 and later no newly-raised
NOTEs are permitted at all and every carried-forward acknowledgement line is written regardless of
count. The two rules SHALL NOT be presented as applying simultaneously to the same NOTEs.

#### Scenario: Round 2 raises no new NOTEs at all
- **WHEN** a round-2 review notices a NOTE-level issue in an area no earlier round flagged
- **THEN** it does not report it, because the round-2+ rule forbids new NOTEs, and the limit of 5
  is irrelevant in that round

#### Scenario: A single BLOCKER needs more space than the old cap allowed

- **WHEN** a reviewer finds one BLOCKER whose command output, expected and actual behaviour
  together exceed what the removed cap permitted
- **THEN** it writes the complete evidence without truncation, and no instruction in its
  definition tells it to shorten the comment to a character budget

#### Scenario: More than five new NOTEs are found

- **WHEN** a reviewer identifies eight newly-raised NOTE-level issues in one round
- **THEN** it reports the five most relevant in full and drops the rest, rather than compressing
  all eight into fragments

#### Scenario: NOTE limit does not consume the carried-forward trail

- **WHEN** a round-3 review must acknowledge seven findings carried over from earlier rounds and
  also raises two new NOTEs
- **THEN** all seven acknowledgement lines are written plus both new NOTEs, because the limit of
  five applies only to newly-raised NOTEs

### Requirement: Per-reviewer DO and NOT-DO lists

Each of the three reviewer definitions SHALL carry its own DO list and its own NOT-DO list,
scoped to what that reviewer alone can observe. A single shared list SHALL NOT be substituted for
the per-reviewer lists.

Exactly one rule SHALL be shared by all three reviewers: a reviewer MUST NOT report something as
missing without first confirming its absence, using read-only Bash where a shell is available and
by reading the relevant files where it is not. The wording SHALL match the shell actually granted
to that specific reviewer definition, and SHALL NOT instruct a reviewer to run shell commands it
has no tool grant for.

#### Scenario: A reviewer definition has no shell grant
- **WHEN** a reviewer definition's tool grant contains no shell
- **THEN** its copy of the shared rule tells it to confirm absence by reading the relevant files
  and to say what it read, rather than to run a read-only shell command

The `proposal-reviewer` NOT-DO list SHALL exclude document wording and formatting, complaints
that implementation detail is insufficiently specific, alternative architecture proposals, and
future extensibility.

The `task-reviewer` NOT-DO list SHALL exclude re-litigating decisions in an already-approved
proposal, pre-existing problems the task did not touch, gaps belonging to another task, and
raising a BLOCKER for absent end-to-end integration tests.

The `code-reviewer` NOT-DO list SHALL exclude redoing the per-line review each task already
passed, style and naming, pre-existing issues outside the aggregate diff, speculative race
conditions with no demonstrable trigger path, and escalating a conclusion reached only by reading
code to BLOCKER severity.

#### Scenario: Task reviewer sees no end-to-end test

- **WHEN** the `task-reviewer` verifies a task whose AC are met but which ships no end-to-end
  integration test
- **THEN** it does not raise a BLOCKER for that absence, because feature-level coverage is the
  aggregate reviewer's dimension

#### Scenario: Code reviewer suspects a problem it could not execute

- **WHEN** the `code-reviewer` suspects a defect purely from reading code and cannot demonstrate
  it by running anything
- **THEN** it does not classify that conclusion as a BLOCKER

#### Scenario: A reviewer believes something is missing

- **WHEN** any reviewer is about to report that a file, test, or configuration is missing
- **THEN** it first confirms the absence with a read-only check and cites what it checked

### Requirement: Stable finding identifiers

Every BLOCKER and every NOTE SHALL carry a stable identifier of the form `B<round>-<slug>` or
`N<round>-<slug>`, where `<round>` is the review round that first reported the finding and
`<slug>` is a short kebab-case label.

The identifier SHALL be assigned in the round that first reports the finding and SHALL NOT be
renamed or renumbered when the finding is carried into a later round.

#### Scenario: A finding survives two fix attempts

- **WHEN** a BLOCKER first reported in round 1 is still unresolved during round 3
- **THEN** it is still identified as `B1-<slug>` in the round-3 comment, not renumbered to `B3-`

#### Scenario: NOTEs are identified too

- **WHEN** a reviewer raises a non-blocking observation
- **THEN** that NOTE receives an `N<round>-<slug>` identifier on the same terms as a BLOCKER

### Requirement: Cross-round acknowledgement of every prior finding

On review round 2 and later, a reviewer SHALL list every prior BLOCKER and every prior NOTE by
identifier and assign each exactly one state from `fixed`, `still-open`, or `not-verifiable`,
together with the command it actually re-ran this round.

`fixed` SHALL require re-verification in the current round with the command and its result cited.
`not-verifiable` SHALL state why verification was impossible and SHALL NOT be treated as
equivalent to `fixed`.

A reviewer SHALL NOT treat a finding's absence from the current round's comment as evidence that
it was fixed.

A prior BLOCKER whose state is `still-open` or `not-verifiable` SHALL yield `VERDICT: FAIL`. A
BLOCKER SHALL be treated as resolved only when its state is `fixed`.

An open or not-verifiable NOTE SHALL yield `VERDICT: PASS WITH NOTES` and SHALL NEVER cause
`VERDICT: FAIL`.

The verdict set SHALL remain exactly `PASS`, `PASS WITH NOTES`, and `FAIL`, and the verdict SHALL
remain advisory — no reviewer definition change introduces a server-enforced gate.

#### Scenario: Prior blocker cannot be re-checked

- **WHEN** a round-2 review cannot re-run the test tied to `B1-migration-dml` because the
  environment is read-only
- **THEN** it records `B1-migration-dml: not-verifiable` with the reason and reports
  `VERDICT: FAIL`

#### Scenario: Prior blocker is silently omitted

- **WHEN** a round-2 comment does not mention a BLOCKER raised in round 1
- **THEN** that omission does not close the finding, and the definition's rules forbid deriving a
  PASS from it

#### Scenario: Only NOTEs remain open

- **WHEN** every prior BLOCKER is `fixed` and two prior NOTEs are `still-open`
- **THEN** the verdict is `PASS WITH NOTES`, never `FAIL`

### Requirement: Parity guard across all seven surfaces

The repository SHALL include an automated test asserting that all 21 reviewer definition files —
the three reviewers across the Claude Code plugin, standalone skill, Codex plugin, OpenClaw
plugin, Pi, dsh, and Kiro surfaces — each carry the finding-identifier convention, the three
acknowledgement states, the silence-is-not-a-fix rule, and that reviewer's own NOT-DO list, and
that none of them contains a total-output character cap.

The test SHALL fail when a character cap is reintroduced under different wording, and SHALL scope
itself to source paths, excluding generated or staged copies under `.next/`,
`packages/chorus-cdk/cdk.out/`, and `.claude/worktrees/`.

The test SHALL NOT introduce a new dependency and SHALL run under the existing test command.

#### Scenario: A surface is missed during a future edit

- **WHEN** a change updates the reviewer rules on six surfaces but forgets the seventh
- **THEN** the parity test fails and names the file that is missing the rule

#### Scenario: A character cap is reintroduced with new wording

- **WHEN** someone adds "keep the comment under 1200 characters" to a reviewer definition
- **THEN** the parity test fails, because it matches the general cap form rather than only the
  exact removed strings
