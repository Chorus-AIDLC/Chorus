## ADDED Requirements

### Requirement: A reviewer's stated tool posture SHALL match the tools it is actually granted, identically across every distribution surface

Every shipped reviewer definition MUST describe the shell capability it actually has. A definition MUST NOT tell the reviewer that shell is unavailable while the surface grants it, and MUST NOT ask the reviewer to reach a conclusion about the filesystem it has no means to check.

Specifically, the `proposal-reviewer` on **all seven** distribution surfaces — Claude Code plugin (`public/chorus-plugin/agents/proposal-reviewer.md`), Codex plugin (`plugins/chorus/skills/chorus-proposal-reviewer/SKILL.md`), Kiro (`public/kiro-plugin/.kiro/agents/chorus-proposal-reviewer.json`), Pi (`packages/chorus-pi/agents/chorus-proposal-reviewer.md`), dsh (`packages/chorus-dsh/skills/proposal-reviewer-chorus/SKILL.md`), OpenClaw (`packages/openclaw-plugin/skills/proposal-reviewer/SKILL.md`), and the standalone skill (`public/skill/proposal-reviewer-chorus/SKILL.md`) — MUST be granted read-only shell and MUST state one canonical rule with the same content: the allowed inspection commands, the forbidden mutating commands, and the obligation to verify existence before reporting something as missing. Only markup may differ per surface.

Shipped orchestrator and steering prose that DESCRIBES the reviewers' tool grants to the agent spawning them — `public/kiro-plugin/.kiro/agents/chorus.md` and `public/kiro-plugin/.kiro/steering/chorus.md` — MUST NOT assert that shell is unavailable either, and MUST state the proposal-reviewer's grant separately from the task- and code-reviewer grant. Being descriptions rather than reviewer definitions, they are NOT required to carry the canonical rule verbatim.

The proposal-reviewer's rule MUST forbid test and build execution, because proposal review precedes implementation. Harness-level tool restriction MUST NOT be treated as the enforcement mechanism, since only some harnesses can restrict tools; the prohibited-command list in the definition is the contract on every surface.

#### Scenario: no proposal-reviewer surface claims shell is unavailable

- **WHEN** any of the seven proposal-reviewer definitions is read
- **THEN** it MUST NOT assert that Bash or shell is disabled, absent, or forbidden outright
- **AND** the Claude Code definition MUST NOT list `Bash` in `disallowedTools`
- **AND** the Kiro definition's `tools` array MUST include `shell`

#### Scenario: every proposal-reviewer surface carries the canonical read-only rule

- **WHEN** any of the seven proposal-reviewer definitions is read
- **THEN** it MUST state that shell use is read-only inspection only, naming the permitted commands
- **AND** it MUST name the forbidden mutating operations, including file writes, git write operations, package installs, and test/build runs
- **AND** it MUST require the reviewer to confirm that a file or directory exists before flagging it as missing

#### Scenario: a reviewer does not report absence it never checked

- **WHEN** a proposal draft references a repository path and the reviewer considers reporting that the path is missing
- **THEN** the definition obliges the reviewer to inspect the filesystem first
- **AND** a BLOCKER asserting a committed file or directory does not exist is a defect in the review, not in the proposal

#### Scenario: the guard covers the surfaces by name

- **WHEN** the skill-harness-fidelity guard checks reviewer tool posture
- **THEN** it MUST enumerate the seven proposal-reviewer paths explicitly rather than by glob
- **AND** a missing enumerated file MUST fail the guard rather than be skipped, so that adding or moving a surface cannot silently pass
- **AND** the shell-disabled-claim check MUST additionally cover the two Kiro orchestrator/steering documents, while the canonical-rule check MUST NOT be applied to them

#### Scenario: guard fails on a reintroduced shell-disabled claim

- **WHEN** a proposal-reviewer definition is edited to re-assert that shell is disabled, or the canonical rule is removed from any surface
- **THEN** `test-skill-harness-fidelity.sh` MUST exit non-zero and name the offending file
- **AND** the paired negative-fixture test MUST demonstrate that each of these checks fails on a violating file

## MODIFIED Requirements

### Requirement: A CI guard SHALL prevent regression of skill/harness fidelity

The repository MUST provide a Bash 3.2-compatible shell guard, executed by the existing plugin
shell-test step in CI, that fails when any shipped skill, agent manifest, or hook script reintroduces
a fidelity drift. The guard MUST cover the three original blacklist checks — a reintroduced
`TeamCreate` reference, a reintroduced inline-verdict/foreground reviewer promise, and a
`.chorus/specs/TEMPLATE/` path — plus the three reviewer-tool-posture checks this change adds, and MUST
NOT assert the presence of the inline `spec-lite` templates. It MUST exclude build output, vendored
directories, and the guard's own source file (which necessarily contains the forbidden literals as
search patterns). Every pattern of a blacklist check MUST be a literal offending phrase, chosen so that
the wording this change prescribes cannot match it; the reviewer-promise check MUST be scoped to the
surfaces this change rewrites and MUST NOT flag a surface whose blocking-return description is accurate.
A check MAY instead REQUIRE a marker substring or inspect a tool-grant manifest, in which case an
enumerated file that is missing or unreadable MUST fail the guard rather than be treated as compliant.
Documentation of the guard MUST NOT claim that it protects the review gate, which no check verifies.

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
- **AND** no blacklist-check pattern MUST be a substring of any prescribed replacement sentence

#### Scenario: guard fails on a dangling template path

- **WHEN** any shipped skill or user-facing doc references `.chorus/specs/TEMPLATE`
- **THEN** the guard MUST report it and exit non-zero
- **AND** the guard MUST NOT additionally require any inline-template marker to be present

#### Scenario: guard runs in CI

- **WHEN** the CI workflow executes its plugin shell-test step
- **THEN** the new guard MUST run alongside the existing syntax and resolver-drift guards
- **AND** a failure MUST fail the workflow
