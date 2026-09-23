# Grant the Kiro code and task reviewers read-only shell

## Why

On six of the seven distribution surfaces, all three reviewers get read-only shell access, bounded by a prohibited-command list in the prompt. On Kiro, `chorus-proposal-reviewer` has `tools: ["read","shell","@chorus"]`, but `chorus-code-reviewer` and `chorus-task-reviewer` have `tools: ["read","@chorus"]` — no shell at all. That asymmetry is currently specified (`kiro-plugin-templates`, "Reviewer agents are read-only subagents"), so this is a deliberate change to that requirement rather than a defect fix.

It should change for two reasons.

**The aggregate code reviewer cannot do its job without a shell.** Its review procedure is built around running the project's full build/test/lint and quoting the real output; a broken build is defined as an automatic `VERDICT: FAIL`. A reviewer that cannot execute anything can never observe that. The task reviewer is in the same position: its first DO item is running this task's tests and quoting exact command, exit code, and output.

**The posture was self-contradictory.** `skill-harness-fidelity` already requires that "a reviewer's stated tool posture SHALL match the tools it is actually granted, identically across every distribution surface". Kiro's code and task reviewers were the exception. The prompt-level adaptation this forced ("you have no shell, so reading is your only confirmation") is the same adaptation that made those two reviewers structurally unable to raise a BLOCKER when the bar was run evidence — a hole this repo just fixed in prose. Granting the shell removes the cause rather than working around it.

`#554` already established the precedent and the accepted trade: the proposal reviewer got read-only shell on all seven surfaces, with read-only-ness enforced by the prompt's prohibited-command list rather than by tool omission.

## What Changes

- `chorus-code-reviewer.json` and `chorus-task-reviewer.json` get `shell` added to `tools`, giving all three Kiro reviewers `["read","shell","@chorus"]`. No reviewer gets `write`.
- Both prompts are rewritten where they assert or work around having no shell: the tool-posture preamble, the "demand the developer's run evidence because you cannot run tests" step, the shared missing-evidence rule (reading-based → read-only-shell wording), the evidence-bar clause, and the `not-verifiable` reason list.
- Both prompts gain the explicit read-only bash policy the other six surfaces carry: the permitted commands, and the forbidden mutating operations (file writes, git write operations, package installs).
- The parity test's per-file shell-wording expectations move these two files from the reading-based branch to the shell branch.

## Capabilities

- `kiro-plugin-templates` — MODIFIED: the reviewer tool-scope requirement.

## Impact

- **Changed:** `public/kiro-plugin/.kiro/agents/chorus-code-reviewer.json`, `public/kiro-plugin/.kiro/agents/chorus-task-reviewer.json`, `src/__tests__/reviewer-rule-parity.test.ts`.
- **Unchanged:** every non-Kiro surface; `chorus-proposal-reviewer.json`; the `write` prohibition on all three reviewers; the verdict set; the VERDICT protocol.

## Trade-off being accepted

Today those two reviewers cannot run a command because the harness will not let them — a boundary enforced by tool omission. Afterwards they can, and read-only-ness rests on the prompt's prohibited-command list, which an LLM can violate. That is strictly weaker than tool omission.

It is the posture every other reviewer on every other surface already has, including Kiro's own proposal reviewer since `#554`, and `skill-harness-fidelity` already states that harness-level tool restriction "MUST NOT be treated as the enforcement mechanism, since only some harnesses can restrict tools". The alternative — keeping tool omission — means keeping two reviewers that cannot verify the thing they are responsible for verifying. Kiro's `tools` is a flat name list with no per-command allow-list, so a scoped shell is not available as a middle option.
