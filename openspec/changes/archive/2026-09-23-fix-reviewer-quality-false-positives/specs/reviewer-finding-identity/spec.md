# reviewer-finding-identity

## MODIFIED Requirements

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
passed, style and naming, pre-existing issues outside the aggregate diff, and speculative race
conditions with no demonstrable trigger path.

The `code-reviewer` NOT-DO list SHALL NOT prohibit escalating a statically-derived conclusion to
BLOCKER severity. The evidence bar is matched to the kind of claim, not to whether a command was
run: a defect visible in the code as written is BLOCKER-eligible on file-and-line evidence, while
a claim about runtime behaviour requires a named trigger path or an observed failure. Requiring
run evidence for every BLOCKER demoted statically-visible defects — a missing authorization check,
absent tenant scoping — to NOTE, and left any reviewer without a shell structurally unable to
return FAIL.

#### Scenario: Task reviewer sees no end-to-end test

- **WHEN** the `task-reviewer` verifies a task whose AC are met but which ships no end-to-end
  integration test
- **THEN** it does not raise a BLOCKER for that absence, because feature-level coverage is the
  aggregate reviewer's dimension

#### Scenario: Code reviewer finds a defect visible in the code as written

- **WHEN** the `code-reviewer` identifies a missing authorization check by reading the diff and
  cannot execute anything that demonstrates exploitation
- **THEN** it raises a BLOCKER citing file and line, rather than demoting it to a NOTE

#### Scenario: Code reviewer has an undemonstrated runtime suspicion

- **WHEN** the `code-reviewer` suspects a race condition but can name neither the interleaving nor
  a code path that reaches it
- **THEN** it does not raise that suspicion at all

#### Scenario: A reviewer believes something is missing

- **WHEN** any reviewer is about to report that a file, test, or configuration is missing
- **THEN** it first confirms the absence with a read-only check and cites what it checked
