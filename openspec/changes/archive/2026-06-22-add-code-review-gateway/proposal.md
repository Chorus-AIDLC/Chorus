# Add Code-Review Gateway

## Why

The AI-DLC pipeline has two review gates today, both **local**:

- **proposal-reviewer** — after a proposal is submitted, audits document/task drafts (VERDICT comment on the proposal).
- **task-reviewer** — after a single task is `submit_for_verify`'d, checks that one task against its AC and runs build/test (VERDICT comment on the task).

When every task of an idea reaches `done`, the idea's derived status jumps straight to `done` (≈ code ships). No reviewer ever stands at the level of **the whole feature's aggregate code change**. Defects that only surface across tasks — cross-task integration drift, architectural inconsistency, regressions in untouched areas, feature-level test gaps — have no dedicated gate and ship unreviewed.

This change adds an independent **code-review subagent** as the final ship-time gateway, mirroring the existing proposal/task reviewers in form (read-only, structured `VERDICT: PASS / PASS WITH NOTES / FAIL`), but reviewing the idea's aggregate code change and posting its verdict on the **Idea** resource.

## What Changes

- **NEW capability `code-review-gateway`** — a read-only code-reviewer subagent definition across all four plugin surfaces (Claude Code plugin agent, standalone skill, Codex skill, OpenClaw skill). It reviews the aggregate code change behind an idea, focusing on whole-feature dimensions, and posts a single structured VERDICT comment on the Idea. Multi-round: each re-review is another comment.
- **Auto-trigger** — extend the existing `chorus_admin_verify_task` PostToolUse hook (`on-post-verify-task.sh`) with a new branch that, when the last task of an idea-rooted proposal is verified, reminds the agent to spawn the code-reviewer for that idea. Gated by a new `enableCodeReviewer` plugin config toggle.
- **Workflow wiring** — wire the gateway into the lifecycle skills (yolo end-step before ship, develop, review) and the canonical "Independent Review" section, including the FAIL → add fix tasks on the approved proposal → re-run loop. In YOLO this is a full-auto closed loop; outside YOLO it is advisory guidance the orchestrator (human/agent) acts on.
- **Config** — add `enableCodeReviewer` (default true) and `maxCodeReviewRounds` (default 3) to the Claude Code plugin `userConfig`, parallel to the existing reviewer toggles.

## Capabilities

- `code-review-gateway` (new)

## Impact

- **No schema migration.** Verdicts are plain Idea comments — no new DB field, no new `Document.type`, no new MCP tool.
- **No derived-status / kanban change in v1.** `computeDerivedStatus` is untouched; an idea still shows `done` when all tasks are done. The gate is **behavioral** (enforced by agent/YOLO honoring the skill protocol), exactly as strong as the existing proposal/task reviewers — both rely on protocol, not a state-machine wall.
- **Affected files:** new agent/skill definitions in `public/chorus-plugin/agents/`, `public/skill/`, `plugins/chorus/skills/`, `packages/openclaw-plugin/skills/`; edits to `public/chorus-plugin/bin/on-post-verify-task.sh`, `public/chorus-plugin/.claude-plugin/plugin.json`, the workflow skill docs across all surfaces, and maintenance docs.

## Out of Scope (Future Phase)

Recorded so intent is not lost; explicitly deferred until the gateway has been used and the multi-proposal-per-idea shape is clear:

- Structural hard gate (a derived-status / idea field that blocks `done` until a passing review exists).
- A new `code_review` derived status, `review_code` badge, or kanban column.
- Any UI surfacing of "code review pending" on the idea board.

Rationale: an idea can carry multiple proposals, so an idea-level "passed" flag would be stale/ambiguous (proposal A reviewed and shipped, then proposal B opens — whom does the flag represent?). Not building structural gating sidesteps that question entirely for v1.
