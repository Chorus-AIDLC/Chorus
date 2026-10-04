# Design: exact workflow suffixes across Pi and dsh

## Context and scope

The three workflow operations are already enumerated in Pi's `NUDGE_TOOL_NAMES` and dsh's `ACTIONS`. Human answers selected arbitrary prefixes, including directly concatenated names such as `xchorus_submit_for_verify`, with an exact complete operation name at the end. Prefix recognition must not imply substring matching or accept extra trailing characters. The later human clarification in Idea comment `24942d56-adca-424e-8cc5-abf93145e2ff` explicitly removes Pi gateway-specific parsing: both hosts use their outer event identifiers uniformly.

Pi's existing generic normalizer is also part of pending Proposal `1e831855-b9c5-4307-85b1-2ded89f48e6e`. Keep that generic behavior available and add workflow-specific suffix recognition first. This allows both efforts to coexist: the other proposal can extend generic native MCP handling without removing this workflow contract. The original main checkout is clean; implementation takes place in an isolated worktree on `fix/pi-dsh-workflow-tool-matching`.

## Decisions and module contracts

### Operation identification

At each host's workflow recognition boundary, require a primitive string before examining it. Match only `name.endsWith(operation)` for the existing three-operation allowlist. Return the native operation string on a match; do not trim, coerce objects, fold case, strip trailing text, or impose a prefix/delimiter whitelist. Unknown or malformed values must never throw or cause a workflow reminder.

Positive names for each operation: bare, `chorus_` prefix, `mcp__chorus__`, `mcp__chorus.`, `chorus__`, a custom dotted namespace, and directly glued `x`. Negative names: empty/null/undefined/non-string values, another Chorus operation, uppercase or incomplete operation names, and each valid operation followed by `_extra`, whitespace, or a newline. Plain `mcp` and `mcp__chorus` outer names do not end in a target operation and are not eligible, regardless of their arguments. JavaScript `endsWith` avoids the newline behavior of a regex `$` anchor.

The existing generic normalizers may still return names for unrelated Chorus tools; the downstream workflow allowlist must continue rejecting those. Pi retains `null` and dsh retains `undefined` for unrecognized inputs. A workflow-specific helper may be introduced if it keeps generic normalization separate; identical behavior across hosts is required, not a shared cross-package runtime dependency.

### Pi event identification and reminder delivery

`resolveChorusToolName` normalizes only `event.toolName`. It does not inspect `input`, recognize gateway wrappers, or maintain a wrapper-name list. Every event uses the same exact workflow suffix rule, even when its prefix contains `mcp` or `gateway`. The human's later explicit instruction supersedes the original preservation of legacy `mcp` inner-name extraction; this is a deliberate scope correction, not an unnoticed regression.

The existing `tool_result` handler remains the reminder owner. Preserve its configured-state and `isError` gates, the three reviewer toggles, and `sendUserMessage(..., { deliverAs: "steer" })`. Do not add reviewer injection to `tool_execution_end`, which serves the worker-session close fallback. Session creation, closure, retry, and duplicate-event behavior remain unchanged.

### dsh action delivery

Resolve workflow suffixes before the existing generic `mcp__chorus__` fallback or in a dedicated workflow helper. Keep the `tools/post-execute` conditions: existing agent state, non-synthetic calls, successful result, and downstream `accept`. Existing `ACTIONS` maps native operations to UUID argument fields and reminder text; preserve it.

Keep action deduplication, pending-action limits, `agent/turn-stopping` delivery, session cleanup, and the daemon-origin early return. The change does not alter checkin's tool name or dsh's synthetic checkin path. dsh has no Pi-style gateway event contract in this scope.

## Execution plan

Two independent module tasks may run in parallel:

1. Pi workflow suffix resolution, helper tests, and real extension-factory event tests.
2. dsh workflow suffix resolution, helper matrix, and real plugin handler tests.

Each task includes its own regression checks. Chorus task drafts are authoritative; `tasks.md` is a local checklist only. A third follow-up Pi task records and independently verifies the human's later instruction to remove gateway parsing without reopening the already verified original tasks. After that task passes, compare the hosts against the same positive/negative contract and repeat aggregate code review.

## Validation and limitations

- Pi: `bash test/all.sh` from `packages/chorus-pi`, including real factory event tests with mocked Pi/fetch; run package validation for packaging changes.
- dsh: `pnpm run typecheck`, `pnpm run lint`, `pnpm test`, and `pnpm run check:package` from `packages/chorus-dsh`, preparing the existing bundle if needed.
- Inspect installed Pi/dsh versions and availability before any host smoke. Use isolated sessions and avoid production state transitions solely to test hooks. Report unavailable or incompatible host prerequisites explicitly.
- Validate OpenSpec and byte-check local document mirrors, then archive only after tasks and aggregate review pass.

## Risks and compatibility

An arbitrary namespace can end with a target operation; recognizing it is the human-approved compatibility rule, not proof of server ownership. Existing success and lifecycle gates still apply. Exact end matching prevents trailing suffixes and partial substrings from firing.

There may be concurrent Pi edits from the native-MCP proposal. Preserve those edits and reconcile at the workflow boundary; do not rewrite its draft or installer work. No skill wording changes, per-package version bumps, publishing, pushing, or merging are part of this implementation; coordinated release handling remains separate.
