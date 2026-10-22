## Why

PR #630 corrected Pi's completion-report sequence, while seven host copies still risk moving tasks to `to_verify` before submission. PR #634 documented draft kinds and dependency validation in proposal skills, but alternate authoring paths and reviewers remain incomplete. Agents must receive the same workflow semantics regardless of host.

## What Changes

- Align develop and quick-dev guidance across standalone, Claude Code, Codex/TRAE, Kiro, OpenClaw, dsh, Hermes and Pi. Completion reports omit status; submission owns the transition. Explain safe recovery and restoration of acceptance evidence.
- Align yolo, openspec-aware, spec-lite and proposal-reviewer guidance: explicit task-draft kind examples, update preservation, actionable dependency errors and contextual implementation-coverage review.
- Add static regression coverage for all eight surfaces, including negative cases, and run applicable existing host checks.
- Track version selection, coordinated bumps and publication as a separate release follow-up. The human chose to fix first and decide the version at release time; no version is selected or published in this change.

## Capabilities

### New Capabilities
- `host-skill-workflow-parity`: consistent task submission and draft validation guidance across host packages.

## Impact

Only skill/reviewer Markdown and static tests change. No runtime, server API, schema or permission changes. No #631 submit-gate port or #633 actor changes. Preserve native host tools, naming, paths and invocation syntax. No commit, push, merge or publication is authorized by this run.

## Acceptance

All eight surfaces satisfy the normative specification. Static tests distinguish forbidden completion-report calls from valid list filters and explanatory warnings. Existing host checks pass or unrelated/environment failures are reported explicitly. Release follow-up is persisted separately before completing this implementation.

## Evidence

- https://github.com/Chorus-AIDLC/Chorus/pull/630
- https://github.com/Chorus-AIDLC/Chorus/pull/634
- https://github.com/Chorus-AIDLC/Chorus/issues/629
