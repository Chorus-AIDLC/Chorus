# Scope amendment: environment-first Claude background protection

## Authority and preserved behavior

Human Idea comment `7c3eb0e4-1338-4552-ab7e-1059583e3b18` supersedes the B choice recorded in the initial elaboration. Quick Task `e927d24e-9c33-40f1-a24a-8e3b262dad7d` tracks the correction under the existing approved proposal. Do not reopen completed tasks or overwrite the original approved design snapshot.

Only changes introduced by B are reverted to PR base `44a08669`: `cli/prompts.mjs`, the added ownership regression suite, Claude plugin skills/manifests/registry, and the three standalone public skill files. This leaves no plugin/public-skill diff or unnecessary version bump. Existing workflow-specific requirements to obtain a reviewer verdict before advancing a gate remain unchanged; removing a blanket waiting rule does not allow declaring unfinished work verified.

The Claude runtime still receives the configured ceiling. A main turn may end after launching a background Agent; Claude's own bounded post-turn waiting handles its lifetime. This is not a promise of indefinite execution: unfinished agents can still be terminated at the chosen ceiling, and C makes that abnormal outcome visible. Native values, including zero and empty strings, retain the approved precedence contract.

No spawner, Waker or daemon reporting logic changes in this amendment. No modification to the already-installed local package or running daemon is performed: that older package still includes the earlier prompt wording until a separately requested rollout.

## Empirical evidence

Clay's Idea comment `2f85a702-7560-4f51-976c-39a466e00d7c` reports a real Claude Code 2.1.289 / haiku expiry test inheriting `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=3600000`. The parent launched a background Agent and ended its turn; the Agent attempted eight approximately 540-second steps. Local artifacts `/tmp/bg60/{start.ts,end.ts,exit.code,err.txt,progress.log}` were read back by Leo: elapsed time is 3608 seconds, raw exit is zero, six progress timestamps exist at 551/1093/1635/2178/2722/3265 seconds, and stderr says `Background tasks still running after 3600s; terminating.` The first progress point is before 600 seconds; the remaining five are after it. The first abandoned attempt under `try1/` is excluded.

These artifacts confirm the finite ceiling and preserve the need for raw-zero stderr detection. The test was manually launched `claude -p`, not a daemon-spawned forced failure; the full daemon wake → real expiry → automatic Chorus comment path remains untested end-to-end. It is covered by mock-child spawner/Waker integration tests, not claimed as live E2E. Leo inspected artifacts rather than repeating the hour-long experiment.

## Verification

- Check the combined PR diff has no Claude plugin, standalone skill, metadata or daemon prompt change against its base.
- Add a prompt regression preventing the removed blanket wait mandate while preserving asynchronous human handoff.
- Re-run CLI regressions, focused lint, and OpenSpec validation. Retain the unchanged runtime tests, including raw-zero termination and entity-comment integration coverage.
- Independently review the amendment, archive its delta, mirror the cumulative spec from file bytes, then push the amendment commit to the same PR without merging or redeploying.
