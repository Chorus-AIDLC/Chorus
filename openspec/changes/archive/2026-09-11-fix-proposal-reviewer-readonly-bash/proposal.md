# Grant the proposal-reviewer read-only shell on every surface

## Why

`chorus:proposal-reviewer` is the only one of the three reviewers whose tool set excludes shell access. Its prompt still asks it to check repo-declared project constraints and to flag LLM-fabricated specifics — checks that routinely involve paths — so it reasons about the filesystem without the means to inspect it.

On 2026-09-09 this produced a real false positive: the reviewer raised a BLOCKER that a spec folder "does not exist" when the folder was committed in git. The defect was the missing capability, not the proposal.

The two sibling reviewers (`task-reviewer`, `code-reviewer`) already ship read-only shell with an explicit prohibited-command list, and that posture has not caused incidents. Only Claude Code and Kiro can actually enforce a tool allowlist; on Codex, Pi, dsh, OpenClaw and the standalone skill the prompt is already the only contract. Withholding the capability therefore buys no safety — it only makes one reviewer blind and makes the three reviewers behave differently per harness.

## What Changes

- Grant the proposal-reviewer **read-only shell** on all seven distribution surfaces, paired with a single canonical rule naming the forbidden mutating commands.
- The canonical rule is identical in content on every surface (only the surrounding markup follows each surface's existing style) and is narrower than the task-reviewer's: inspection only, **no test/build runs** — proposal review happens before implementation exists.
- The same rule carries the obligation that closes the reported bug: confirm a file or directory exists before flagging it as missing.
- Remove the now-false statements that shell is disabled, from every surface's prohibition list.
- Extend the existing CI-wired `test-skill-harness-fidelity.sh` guard so no surface can regress to a shell-disabled proposal-reviewer, and so every surface must carry the canonical rule.

## Capabilities

- `skill-harness-fidelity` — ADDED: a reviewer's stated tool posture must match the tools it is actually granted, uniformly across surfaces, and a CI guard must hold that line.
- `public-skill-yolo-reviewers` — MODIFIED: the standalone proposal-reviewer's read-only posture no longer prohibits shell outright; it permits read-only inspection and prohibits mutation.

## Impact

- Prompt/definition text and one Kiro JSON `tools` array. No application code, no schema, no API surface.
- Behavioral: the proposal-reviewer may now run inspection commands, which slightly increases its turn usage but removes a class of false BLOCKERs that cost a full reject/revise/resubmit round.

## Out of scope

Kiro's `task-reviewer` and `code-reviewer` are also shell-less and compensate by demanding the developer's run evidence. Granting them shell would let them start executing tests — a materially larger behavior change than this fix, and not the reported bug. Tracked as a follow-up.
