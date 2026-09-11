# Design

## The canonical rule (single source of truth for this change)

Every surface states the proposal-reviewer's shell posture with this content, verbatim:

```
Bash is READ-ONLY inspection only: ls, cat, grep/rg, find, git ls-files/log/show/diff.
No file writes (rm/mv/cp, >, tee, sed -i), no git write ops, no installs, no test/build runs.
Use it to confirm a file or directory exists before flagging it as missing.
```

It is one logical rule in three sentences: **what is allowed**, **what is forbidden**, **what it is for**. The third sentence is not decoration — without it the capability grant alone does not prevent the reported false positive, because nothing obliges the reviewer to actually check before asserting absence.

Deliberate differences from the task-reviewer's rule:

| | task-reviewer / code-reviewer | proposal-reviewer (this change) |
|---|---|---|
| test/build execution | allowed | **forbidden** — no implementation exists yet at proposal time |
| existence-check obligation | absent | **present** |
| forbidden list | git writes, `rm`/`mv`/`cp`, file writes | same, plus installs and redirection/`sed -i` spelled out |

Word-for-word reuse across surfaces is the point: the bug being fixed is drift between what a reviewer is told and what it can do, and the seven surfaces have already drifted once. Only the markup adapts (frontmatter line, prose sentence, markdown bullet, or JSON prompt string), never the content.

## Per-surface edits

| Surface | File | Grant | Text sites |
|---|---|---|---|
| Claude Code plugin | `public/chorus-plugin/agents/proposal-reviewer.md` | remove `- Bash` from `disallowedTools` | `criticalSystemReminder_EXPERIMENTAL` first line; the "You must NEVER" bullet that says Bash is disabled |
| Codex plugin | `plugins/chorus/skills/chorus-proposal-reviewer/SKILL.md` | none needed (no enforcement) | `CRITICAL: READ-ONLY` line (drop the "sandbox enforces this" claim about shell); the "Running any shell commands" bullet |
| Kiro | `public/kiro-plugin/.kiro/agents/chorus-proposal-reviewer.json` | add `"shell"` to `tools` | the `=== CRITICAL: READ-ONLY ===` block inside `prompt`, which currently asserts "no `shell`" and tells the agent it cannot run shell commands |
| Pi | `packages/chorus-pi/agents/chorus-proposal-reviewer.md` | already declares `bash` | the `CRITICAL: READ-ONLY` line and the never-do bullet, both of which say "beyond read-only inspection" without saying what that means |
| dsh | `packages/chorus-dsh/skills/proposal-reviewer-chorus/SKILL.md` | none needed | the `**You are READ-ONLY.**` bullet containing "Do NOT run Bash." |
| OpenClaw | `packages/openclaw-plugin/skills/proposal-reviewer/SKILL.md` | none needed | same bullet as dsh |
| Standalone skill | `public/skill/proposal-reviewer-chorus/SKILL.md` | none needed | the `## READ-ONLY Posture (Hard Constraints)` prohibition list |

Each surface states the rule once, with one deliberate exception: the Claude Code agent states it twice — in the `criticalSystemReminder_EXPERIMENTAL` frontmatter and again, verbatim, in the body. That field is experimental (`_EXPERIMENTAL`, `.optional()` in the agent-definition schema) and Claude-Code-only, so if the rule lived only there an upstream rename or removal would strip it silently while the guard's canonical-rule check still greps the file and passes. The two copies must be kept byte-identical; a comment in the body says so.

Pi is the surface that proves the current state is drift and not design: it already grants `bash` while the Claude Code definition forbids it, and neither states a command-level rule. After this change all seven state the same rule.

The file-mutation and single-comment-side-effect prohibitions stay exactly as they are on every surface. Only the shell clause changes.

## Regression guard

`public/chorus-plugin/bin/tests/test-skill-harness-fidelity.sh` already runs in CI (`.github/workflows/test.yml`) and already sweeps text across distribution surfaces, so it is the right home — no new test harness.

Two checks over the seven proposal-reviewer definitions:

1. **No surface claims shell is unavailable.** Fail on a proposal-reviewer file matching a shell-disabled assertion (`Bash is disabled`, `no \`shell\``, `cannot run shell`, `Do NOT run Bash`, `or run Bash commands`, `Running any shell commands`). This is the check that would have caught the pre-change state.
2. **Every surface carries the canonical rule.** Fail if a proposal-reviewer file lacks the read-only-inspection marker and the existence-check obligation.

Check 1 also covers two files that are not reviewer definitions: `public/kiro-plugin/.kiro/agents/chorus.md` (the Kiro orchestrator's own prompt) and `public/kiro-plugin/.kiro/steering/chorus.md`. Both describe the reviewers' tool grants to the agent that spawns them, so a false "no shell" claim there misleads the orchestrator exactly as a false claim in the reviewer's own file misleads the reviewer. They are deliberately kept out of check 2's scope: the canonical rule is a reviewer-definition obligation, and these two only need to state each grant accurately — proposal-reviewer `read` + `shell` + `@chorus`, task/code-reviewer `read` + `@chorus`, `write` for none.

Both checks enumerate the seven paths explicitly rather than globbing, so adding an eighth surface without updating the guard is a visible omission rather than a silent pass.

The paired `test-skill-harness-fidelity-negative.sh` gets fixture cases proving each new check actually fails on a violating file — otherwise a guard that never fires reads as passing.

Bash 3.2 compatibility applies (macOS runs these hooks): no `${VAR,,}`, no `declare -A`, no `readarray`. Follow the existing script's idioms, and remember the known trap that a `$(...)` subshell cannot set a scan-error flag in the parent — use a file or a direct assignment.

## Risks

- **A reviewer that ignores the "no test/build runs" clause** could start running the project's test suite during proposal review, wasting turns. Accepted: the clause is explicit, and no surface can enforce it anyway except Claude Code (where `Bash` is all-or-nothing) and Kiro (same). The turn-budget rule already caps the damage.
- **A misbehaving reviewer could mutate the tree.** Same exposure the task-reviewer and code-reviewer have carried since they shipped, on the same prompt-level contract. No incident to date. Rejecting this risk would mean removing shell from the other two reviewers, which nobody is asking for.

## Alternatives rejected

- **Prompt-only prohibition (idea's direction 2)** — "you cannot see the filesystem, never conclude a file is missing" keeps the reviewer blind to a check its own prompt asks it to perform (repo-declared project constraints). It suppresses the symptom and keeps the capability gap.
- **Caller-injected file manifest (idea's direction 3)** — pushes filesystem knowledge into every spawn site across seven surfaces, and the caller cannot know in advance which paths the reviewer will want to check.
- **Grant shell only where the harness enforces it** — leaves five of seven surfaces with a different reviewer, which is exactly the cross-plugin inconsistency this change is meant to remove.
