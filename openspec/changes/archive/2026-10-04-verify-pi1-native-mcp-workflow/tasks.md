# Tasks

Follow-up task: `cc7fb98b-a9c8-4de3-a912-37eecc123de6`. Keep every item unchecked until the parent independently verifies and completes it. The parent owns the host harness, evidence, and Chorus document mirroring; this documentation contribution does not implement or duplicate the harness.

## 1. Documentation and delta review

- [x] 1.1 Verify the README documents Pi 1.x native setup, default codemode child events, direct equivalence, bookkeeping env vars, and the retained legacy adapter/CLI route against installed Pi 1.0.2 MCP/SDK docs.
- [x] 1.2 Verify the extension edits only change relevant MCP/reviewer comments by comparing emitted runtime code with the original, and run `bash test/all.sh` in `packages/chorus-pi` as offline regression evidence.
- [x] 1.3 Verify the new delta contains exactly one full MODIFIED Pi outer-identifier requirement with all prior scenarios retained and one ADDED SDK host-verification requirement; run `openspec validate verify-pi1-native-mcp-workflow --strict`.

## 2. Parent-owned Pi 1.x host verification

- [x] 2.1 Prepare the authorized isolated Pi 1.x SDK environment and local MCP/bookkeeping fixture with dummy credentials; record the installed SDK version and verify that loaded resources and endpoints cannot reach real Chorus or model providers.
- [x] 2.2 Implement the single parent-owned harness with the actual Chorus extension, native MCP/codemode extensions, bound SDK session, and deterministic assistant/tool-call source; verify real MCP discovery and pipeline execution rather than direct handler invocation.
- [x] 2.3 Execute all three workflow operations through default native codemode and native direct calls; record real event names/IDs and codemode parent IDs, and assert exactly one existing corresponding steering reminder per eligible successful invocation.
- [x] 2.4 Exercise fixture errors including successful codemode parents with failed children, each disabled reviewer toggle, unconfigured Chorus, trailing-name near misses, and unrelated outer names with workflow-looking arguments; assert zero reminders for suppressed invocations and no duplicate from parent or execution-end events.
- [x] 2.5 Record reproducible commands, fixture isolation, SDK version, settings, event traces, observed messages/counts, and case results in the parent-owned evidence artifact; clearly distinguish actual SDK pipeline evidence from the offline suite and any unexecuted cases.
- [x] 2.6 Verify Pi 1.x peer/lockfile baseline and the three actual reviewer hard allowlists, including dispatcher expansion of native Chorus reads/comments and exclusion of business mutations; preserve worker/custom-agent selection.

## 3. Parent integration review

- [x] 3.1 Independently compare host evidence with every delta scenario and verify that arbitrary-prefix complete-ending matching, ignored `input.tool`, success/toggle gates, runtime code, and the pending native-MCP proposal's scope remain intact.
- [x] 3.2 Mirror the approved documents through the parent workflow and verify byte parity; complete the checklist only after the parent confirms documentation and host acceptance, preserving the separate ownership of cumulative-spec/archive and release work.

## 4. Aggregate-review correction

Follow-up task: `0e032890-dec2-4b6d-8d57-8822428d4a70`; blocker `B3-reviewer-list-reads-excluded`.

- [x] 4.1 Add only discovered `chorus_list_tasks` / `chorus_list_projects` reads, verify every shipped reviewer's prescribed Chorus operations, and preserve generic-list/mutation exclusions and worker/custom selection.
- [x] 4.2 Re-run Pi offline and actual native SDK profile verification with both list fixtures; record updated counts and hard-allowlist evidence.
- [x] 4.3 Mirror revised PRD/design/evidence from local files and verify byte parity.
- [x] 4.4 Independently review/verify the follow-up and obtain a new aggregate VERDICT that explicitly closes B3 before archive/commit.
