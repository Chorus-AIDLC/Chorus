# Pi / dsh workflow design with Pi 1.x follow-up

## Completed initial implementation

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

## Current Pi 1.x compatibility and verification

# Design: Pi 1.x native MCP workflow verification

## Context

See `proposal.md` for motivation and `specs/workflow-tool-name-matching/spec.md` for the delta contract. The cumulative capability and archived October 4 matching change already define arbitrary prefixes, exact complete endings, ignored `input.tool`, and existing success/lifecycle gates. This follow-up clarifies native Pi events and requires host evidence; neither existing artifact is edited here.

The installed `@earendil-works/pi-coding-agent` is 1.0.2. Its authoritative references are `docs/mcp.md:250` (MCP pipeline and codemode parent IDs), `docs/extensions.md` (nested tool events), and `docs/sdk.md` / `examples/sdk/14-codemode-mcp.ts` (explicit SDK extension loading). The earlier assertion that native codemode hides every MCP event is incorrect.

## Goals / Non-Goals

**Goals:** Explain native default codemode and direct workflow recognition, document usable native configuration, and specify reproducible host evidence with local fixtures and no external credentials.

**Non-Goals:** Change workflow recognition/delivery logic or generic normalization, rewrite workers, or complete the broader native-MCP installation/CLI proposal.

## Decisions

### Treat each emitted event's tool name uniformly

Native Pi registers an MCP operation as `mcp__<server>__<tool>`. A default codemode script invokes it through Pi's nested tool pipeline. Its child `tool_call` and `tool_result` events retain that real name and carry the enclosing codemode call ID in `parentToolCallId`. Here, "outer `toolName`" means the top-level name field of the event being handled, including a child event; it does not mean only the topmost model-issued tool call.

The existing matcher therefore applies to child and direct events without changes. `parentToolCallId` supplies evidence of nesting, not a reason to discard the event. Reviewer delivery remains in the successful child `tool_result`, subject to configured state and the relevant reviewer toggle. The enclosing `codemode` result does not end in a workflow operation, so it contributes no second reminder. `tool_execution_end` retains its worker-session fallback role. Parsing script text or `input.tool`, special-casing wrappers, and forcing `direct` exposure are unnecessary and would contradict the selected contract.

### Document native setup and keep adapter setup explicitly legacy

Pi 1.x uses `~/.pi/agent/mcp.json` or the trusted project's `.pi/mcp.json`, supports environment-referenced headers, and defaults to codemode exposure. The README documents installing the Chorus package and configuring the native server through `pi mcp add`; it also explains that `pi-mcp-adapter` replaces the built-in `/mcp` extension in sessions.

The Chorus extension's own HTTP bookkeeping still resolves environment variables or its existing `.mcp.json` / global-file fallback. It does not gain `.pi/mcp.json` discovery here. Native instructions therefore explicitly export `CHORUS_URL` and `CHORUS_API_KEY` so a project-native configuration also leaves Chorus bookkeeping configured.

`chorus agents add` / `chorus init` still installs the adapter. Pending Proposal `1e831855-b9c5-4307-85b1-2ded89f48e6e` owns that installer/CLI migration and broader native-MCP integration. The retained legacy setup and subagent measurements must not imply that Pi 1.x requires the adapter.

### Verify through the real SDK and a local MCP fixture

The parent owns one host harness, using the installed Pi 1.x SDK and actual `extensions/chorus.ts`. Following the SDK example, explicitly load the native MCP and codemode extensions into the resource loader and bind the session extensions to start MCP connections. Tool-search is needed only if the harness also covers deferred exposure.

Use an isolated agent directory, working directory, settings, and in-memory session. Point native MCP and the Chorus extension's HTTP bookkeeping at a local fixture with dummy credentials. The fixture can return deterministic checkin/bookkeeping responses and expose the three workflow operations plus negative-name tools; these names simulate transitions without changing real Chorus entities.

A deterministic local model/tool-call source may replace provider transport. It must drive the SDK's actual execution pipeline; manually emitting fabricated events, invoking registered Chorus handlers directly, or mocking native MCP would merely repeat offline tests. Capture the real child/direct events and the actual steering message queue or session messages. A passive observer may record `sendUserMessage` calls while delegating to the real method; a fake Pi API is insufficient.

| Case, repeated for each workflow operation | Required observation |
|---|---|
| Native default codemode success | Real MCP child name, child call ID, matching `parentToolCallId`, and one existing reviewer steering reminder |
| Native direct success | Real MCP name and one equivalent reminder without a codemode parent |
| MCP failure inside an otherwise successful script | Child reports an error and produces no reminder |
| Relevant reviewer toggle disabled or Chorus unconfigured | No reminder for the otherwise eligible operation |
| Extra trailing text, unrelated name, or wrapper arguments naming an operation | No reminder |
| Codemode parent result and execution-end events | No additional reminder beyond the eligible child result |

Record SDK version, command, fixture isolation, event IDs/names/error flags, reviewer settings, observed messages/counts, and pass/fail results. Existing helper and handler-factory checks remain offline evidence. Parent review must distinguish this SDK evidence from a production business transition or a model-provider-backed interactive session.

### Keep packaged reviewers able to reach native MCP

The packaged reviewer lists previously allowed only the old adapter's `mcp` and `mcpScript`. Add `codemode` and `tool_search` while retaining their read-only project policy and legacy entries. Pi 1.x's `--tools` is a hard allowlist for nested MCP tools as well, so these entry points alone do not grant access to native tools. The bundled dispatcher expands a named Chorus reviewer's declared list using the parent's actual available native Chorus query/checkin/comment names, never adding submission/admin/mutation operations or project write/edit tools. Workers and unrelated agents keep their prior selection.

The host probe parses each actual reviewer frontmatter and applies the same expansion using real tool names discovered by its earlier parent session. It then starts a native default-codemode SDK session with that exact hard allowlist and executes `chorus_get_task`, `chorus_list_tasks`, `chorus_list_projects` and `chorus_add_comment` against the local fixture. The SDK actually filters callable tools: only those four fixture operations remain reachable in each reviewer session. No production comments are posted. The probe also loads the bundled subagent extension through the real Pi loader to check its compatibility with Pi 1.

The package's optional Pi peer is now `>=1.0.0 <2.0.0`, with the workspace resolution updated to 1.0.2. Generate the lockfile in a clean temporary workspace to preserve the original checkout's dependencies, and confirm all non-Pi importer entries remain identical.

The regenerated shared snapshots also update semver for `make-dir@4.0.0` from 7.7.3 to 7.8.5, and for `@typescript-eslint/typescript-estree@8.54.0(typescript@5.9.3)` and `is-bun-module@2.0.0` from 7.8.0 to 7.8.5. This incidental transitive change is retained and explicitly recorded; unchanged non-Pi importers do not mean their entire dependency graphs are unchanged.

Aggregate review `2b4db326-c9af-4201-958b-c8952409a9d9` found `B3-reviewer-list-reads-excluded`: the code reviewer's prescribed `chorus_list_tasks` was missing from the native hard allowlist. Follow-up task `0e032890-dec2-4b6d-8d57-8822428d4a70` adds the two explicitly read-only public list names `chorus_list_tasks` and `chorus_list_projects`, only when discovered by the parent. It does not allow a general `chorus_list_*` prefix. A regression checks every bundled reviewer's documented tool bullets against its expanded tools; the actual SDK profile fixtures execute both list operations alongside query/comment and assert that no business mutations remain callable.

## Risks / Trade-offs

- An installed adapter can replace native MCP while shell `pi mcp list` still uses the built-in implementation. → Isolate loaded resources and record that the session uses native MCP.
- SDK sessions omit CLI built-in extensions by default. → Explicitly load and bind the required native extensions.
- A successful codemode parent can contain a failed MCP child. → Assert child error state and reminder count independently.
- Ambient settings, credentials, or resource discovery could reach real services. → Use isolated resource paths, local endpoints, and dummy credentials.
- Full adapter/direct reviewer migration and installation behavior remain outside this follow-up. → Add only native entry points to the reviewers, verify default native codemode, and retain the pending proposal's installer ownership.

## Completion and evidence

The user has authorized Pi 1.x host setup/upgrade and tests; 1.0.2 is installed. Host verification is recorded by `test/pi1-native-mcp.mjs`; its native MCP fixture and deterministic local model exercise actual session execution, events, and steering delivery. The parent owns independent review, Chorus document mirroring, and checklist completion. Archive updates the cumulative specification after acceptance; no publishing, push, or merge is authorized.
