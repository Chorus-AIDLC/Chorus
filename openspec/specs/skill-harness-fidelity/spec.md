# skill-harness-fidelity Specification

## Purpose
TBD - created by archiving change fix-skill-doc-harness-drift. Update Purpose after archive.
## Requirements
### Requirement: Shipped skill text SHALL NOT instruct agents to call a non-existent harness primitive

Every stage skill shipped in any distribution surface MUST describe parallel task execution only in
terms of primitives its target harness actually exposes: one sub-agent per unblocked task, dispatched
through the target harness's own sub-agent primitive, issued as a single message for the whole wave.
The affected surfaces are `public/chorus-plugin/`, `plugins/chorus/`, `public/kiro-plugin/`,
`packages/openclaw-plugin/`, `packages/chorus-dsh/`, `packages/chorus-pi/`, and `public/skill/`.
No skill MUST reference a `TeamCreate` primitive, and no skill MUST frame sequential main-agent
execution as a fallback conditioned on `TeamCreate` failing. Surfaces that are required to stay
harness-neutral MUST express the instruction without naming any harness-specific tool.

#### Scenario: yolo wave dispatch carries no team-creation step

- **WHEN** an agent reads the wave-execution phase of the `yolo` skill on any surface
- **THEN** it is told to dispatch one sub-agent per unblocked task in a single message
- **AND** it encounters no instruction to create a team or group object first
- **AND** the sequential main-agent fallback is conditioned on sub-agent dispatch being unavailable or
  repeatedly failing, not on a team-creation call failing

#### Scenario: develop and quick-dev carry the same corrected instruction

- **WHEN** the `develop` or `quick-dev` skill of any surface describes parallel task execution
- **THEN** it MUST use the same harness-primitive-based dispatch wording as `yolo`
- **AND** it MUST NOT mention `TeamCreate`

#### Scenario: no surface names a foreign harness's tool

- **WHEN** the `public/skill/` or `packages/chorus-pi/` copy of a stage skill describes parallel
  dispatch
- **THEN** the wording MUST NOT name another harness's sub-agent tool
- **AND** `packages/chorus-pi/test/static.sh` MUST still pass
- **AND** a surface's references to its *own* primitives (for example Pi's `subagent`) MUST NOT be
  removed in the name of neutrality

### Requirement: Reviewer guidance SHALL state a wait-then-read-this-round's-verdict contract using only mechanisms the harness provides

Reviewer-spawn guidance MUST instruct the agent to wait for the reviewer to complete using a waiting
mechanism its own target harness actually provides, and then to read and act on **this review round's**
`VERDICT:` comment via `chorus_get_comments` before advancing. This applies to every place that
instructs an agent to spawn a `proposal-reviewer`, `task-reviewer`, or `code-reviewer` — skill bodies,
agent manifests, PostToolUse hook injection text, and daemon wake-prompt strings. "This round's verdict"
means a `VERDICT:` comment on the entity under review, posted after the current dispatch, by the
reviewer role that was dispatched; guidance MUST NOT direct the agent to accept merely the newest
`VERDICT:` comment on the entity, and MUST NOT treat the absence of such a comment as a pass.

Guidance MUST NOT assert a waiting mechanism that its target harness does not provide, and MUST NOT
present the spawn call's return value as a substitute for reading the comment. Where a harness's spawn
primitive genuinely blocks and returns the verdict, the guidance MAY say so — that statement is true on
that surface and MUST NOT be removed. Conversely, no guidance may assert that a spawn is asynchronous,
or that it does not return a verdict, on a surface where that has not been verified. On the Claude Code
surface, where these reviewer subagent types have been observed to launch asynchronously regardless of
the flag, the text MUST say so and MUST NOT instruct the agent to run the reviewer "in foreground",
"synchronously", or to avoid `run_in_background`.

The gate itself MUST be preserved on every surface: the agent MUST NOT advance the pipeline
(approve/reject, verify/reopen, ship) before it has read this round's verdict.

#### Scenario: Claude Code skill and hook text agree on the async contract

- **WHEN** an agent on the Claude Code surface submits a proposal or a task for verification
- **THEN** the injected PostToolUse text and the corresponding `SKILL.md` both instruct it to wait for
  the reviewer's completion notification and then read the `VERDICT:` comment
- **AND** neither instructs it to run the reviewer synchronously or to avoid `run_in_background`
- **AND** both still forbid advancing before the verdict has been read

#### Scenario: a harness whose spawn genuinely blocks keeps its native wait and its true description

- **WHEN** a surface documents a native waiting primitive (for example Codex `wait_agent`, Pi's bundled
  blocking `subagent`, OpenClaw `sessions_yield`, or dsh `run_in_background: false`)
- **THEN** that primitive MUST be retained as the mechanism for waiting
- **AND** where the primitive verifiably returns the verdict, the text MAY continue to say so
- **AND** the decision MUST still be based on this round's `VERDICT:` comment read via
  `chorus_get_comments`
- **AND** no statement about that harness's spawn semantics MAY be added without verification against
  that harness

#### Scenario: a stale verdict does not satisfy the gate

- **WHEN** a reviewer is dispatched for a second or later round on the same entity
- **THEN** the guidance MUST require a `VERDICT:` comment posted after that dispatch
- **AND** when no such comment is present, the guidance MUST route the agent to its existing
  respawn/manual-review/escalation path rather than to advancing

#### Scenario: the review gate survives every rewritten site

- **WHEN** any reviewer-spawn instruction is rewritten under this requirement
- **THEN** the rewritten text MUST still forbid advancing the pipeline before the verdict is read

### Requirement: spec-lite SHALL be self-sufficient with inline templates

The `spec-lite` skill MUST contain complete inline templates and MUST NOT direct the agent to copy
any file that the plugin does not ship. No skill or user-facing doc MUST reference a
`.chorus/specs/TEMPLATE/` path. The inline templates MUST cover both file roles: the durable
capability spec (`<slug>/spec.md`, local-only, carrying no Chorus ids) and the synced dated-folder
document (`<slug>/<YYYY-MM-DD>-<change-slug>/<type>.md`, whose frontmatter carries `proposalUuid` and
`documentUuid`, with the document type implied by the filename).

#### Scenario: agent authors a spec-lite change with no template on disk

- **WHEN** an agent follows `spec-lite` in a repository that has no `.chorus/specs/TEMPLATE/`
  directory
- **THEN** it finds a complete inline skeleton for the durable `spec.md`
- **AND** it finds an inline frontmatter template for dated-folder documents showing `proposalUuid`
  and `documentUuid`
- **AND** it needs to infer no frontmatter key

#### Scenario: proposal and yolo point at the inline templates

- **WHEN** the `proposal` or `yolo` skill reaches its spec-lite branch
- **THEN** it MUST refer the agent to the `spec-lite` skill's inline templates
- **AND** it MUST NOT name a `.chorus/specs/TEMPLATE/` path

### Requirement: A CI guard SHALL prevent regression of skill/harness fidelity

The repository MUST provide a Bash 3.2-compatible shell guard, executed by the existing plugin
shell-test step in CI, that fails when any shipped skill, agent manifest, or hook script reintroduces
a fidelity drift. The guard MUST cover exactly three checks — a reintroduced `TeamCreate` reference, a
reintroduced inline-verdict/foreground reviewer promise, and a `.chorus/specs/TEMPLATE/` path — and MUST
NOT assert the presence of the inline `spec-lite` templates. It MUST exclude build output, vendored
directories, and the guard's own source file (which necessarily contains the forbidden literals as
search patterns). Every guard pattern MUST be a literal offending phrase, chosen so that the wording
this change prescribes cannot match it; the reviewer-promise check MUST be scoped to the surfaces this
change rewrites and MUST NOT flag a surface whose blocking-return description is accurate. Documentation
of the guard MUST NOT claim that it protects the review gate, which no check verifies.

#### Scenario: guard fails on a reintroduced TeamCreate reference

- **WHEN** a shipped skill under `public/`, `plugins/`, or `packages/` contains `TeamCreate`
- **THEN** the guard MUST report the offending file and exit non-zero
- **AND** it MUST tolerate the `packages/chorus-pi/test/` files that name the primitive only in order
  to forbid it

#### Scenario: guard fails on a reintroduced inline-verdict promise

- **WHEN** reviewer-spawn guidance on a surface this change rewrites claims a synchronous or inline
  verdict
- **THEN** the guard MUST report the offending file and exit non-zero

#### Scenario: the guard does not flag correct wording

- **WHEN** the guard runs against the corrected tree, in which reviewer guidance retains each harness's
  own waiting primitive — including dsh's `run_in_background: false` and Pi's accurate description of a
  blocking `subagent` that returns the VERDICT
- **THEN** the guard MUST report PASS
- **AND** no guard pattern MUST be a substring of any prescribed replacement sentence

#### Scenario: guard fails on a dangling template path

- **WHEN** any shipped skill or user-facing doc references `.chorus/specs/TEMPLATE`
- **THEN** the guard MUST report it and exit non-zero
- **AND** the guard MUST NOT additionally require any inline-template marker to be present

#### Scenario: guard runs in CI

- **WHEN** the CI workflow executes its plugin shell-test step
- **THEN** the new guard MUST run alongside the existing syntax and resolver-drift guards
- **AND** a failure MUST fail the workflow

