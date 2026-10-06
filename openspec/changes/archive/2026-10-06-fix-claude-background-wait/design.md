# Claude background-agent lifetime and failure reporting

## Decisions

The human selected A (60 minutes with override), B (prompt plus Claude and public skill documentation), C (warning, abnormal wake and entity comment), and Claude-only scope. The subsequent YOLO instruction authorizes execution and verification, with Clay review before local packaging, global installation and daemon restart. No merge or npm publication is authorized.

## Runtime contracts

1. `ClaudeSpawner` builds its child environment from the existing merged runtime configuration. Preserve an explicitly present native `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` byte-for-byte, including `0`. Otherwise accept a trimmed, non-negative decimal safe integer from `CHORUS_CLAUDE_BG_WAIT_CEILING_MS` (zero is an explicit opt-in to unlimited waiting). Missing, blank, negative, fractional or unsafe values fall back to `3600000`; invalid nonblank overrides warn without echoing their values. Do not mutate the parent environment or other spawners. Windows key lookup must respect existing case-insensitive environment conventions.
2. Match the complete diagnostic `Background tasks still running after <duration>s; terminating` in a bounded rolling stderr window; partial chunks must work and unrelated stderr/quoted stdout must not count. Latch the first detection so later noise cannot clear it. Feed a fixed explanatory reason to the existing execution-error collector and return `backgroundTasksTerminated: true`. A raw exit zero becomes effective failure code 1; preserve the raw zero inside `wakeError.exitCode`. Nonzero/signal outcomes and session-conflict behavior remain intact.
3. Waker uses its existing abnormal completion path (`interrupted/crash` when not explicitly stopped) and accepts an injected `postComment` callback wired to the daemon's shared authenticated MCP client. On the new flag, post at most once per wake on the triggering Idea/Task (not a guessed child task or root Idea). Include a fixed bounded description and session identifier, not raw stderr, credentials, or @mentions. Other entity kinds get diagnostic/log visibility only. A failed comment is warned and does not replace the recorded wake failure or prevent cleanup. No automatic retry or task-state mutation. Explicit user-stop and shutdown reasons keep their current precedence.
4. Completion logs must not display a success checkmark for this failed wake. Preserve normal success output and session anchoring.

## Guidance

Add Claude-specific `run_in_background` ownership wording in the prompt and Claude develop/yolo/orchestrate skills plus standalone mirrors. Normal completion requires workers/reviewers to finish and their results to be collected, not merely launched. Before an asynchronous human handoff, finish independent children or explicitly cancel and record unfinished work; then end the turn without polling the human. Respect user cancellation/shutdown. This is not a whole-wake timeout or a mandate to wait forever. General workflow guidance can apply to interactive Claude without introducing conditional interactive-question rewrites. Other backend protocols are unchanged. Follow the plugin-maintenance version contract for the changed Claude package.

## Verification and rollout

- Mock-child tests cover default/native/Chorus precedence, zero, invalid input and Windows environment behavior; split and repeated stderr, near misses, raw-zero failure, nonzero failure, signal and normal completion.
- Waker tests cover original Idea/Task attribution, single comment, unsupported entity, comment rejection, stop/shutdown precedence, failure lifecycle and log output. Exercise actual spawner plus Waker where practical.
- Prompt/skill tests guard background ownership and human handoff wording. Run targeted tests then the CLI suite.
- Two independent implementation modules: runtime/reporting and prompt/skills. Review both tasks, then aggregate review by Clay before installing. Build a local CLI-only npm artifact using the published entrypoint/module layout and existing runtime dependencies; avoid accidentally shipping stale server output. Verify artifact contents and installed CLI. Restart through the existing daemon lifecycle command only after review; account for the current session being daemon-owned and persist the handoff first if restart must occur asynchronously.

## Risks

Claude's diagnostic and variable are CLI-version-sensitive; tests lock the observed diagnostic, not a promise of detection for future wording. A 60-minute post-turn ceiling cannot bound a main agent that never ends its turn. Comment transport can fail independently and must remain observable. Comments carry no mentions to avoid creating a self-wake loop. Explicit zero is supported but is not the recommended default.
