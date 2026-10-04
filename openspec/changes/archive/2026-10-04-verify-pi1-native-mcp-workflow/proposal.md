# Proposal: verify Pi 1.x native MCP workflow reminders

## Why

Follow-up Chorus task `cc7fb98b-a9c8-4de3-a912-37eecc123de6` explicitly targets Pi 1.x and requires meaningful host evidence beyond the archived workflow-matching change's offline tests. The earlier claim that native codemode hides all MCP events was wrong: installed Pi 1.0.2 `docs/mcp.md:250` states that every MCP call passes through `tool_call` and `tool_result`, with `parentToolCallId` on codemode child calls.

## What Changes

- Clarify the existing Pi outer-event requirement: native default codemode child events and direct MCP events expose real `mcp__<server>__<tool>` names to the same complete-ending matcher.
- Preserve arbitrary prefixes, exact operation endings, ignored `input.tool`, successful-result and configuration gates, reviewer switches, and one steering reminder per eligible child result without parent duplication.
- Require host verification through the actual Pi 1.x SDK pipeline and Chorus extension, using a local MCP fixture and deterministic tool calls without real business writes or model-provider credentials.
- Document Pi 1.x native setup in the package README, retain the adapter route as legacy, and correct the extension's MCP and reviewer-event comments.
- Declare the supported Pi 1.x peer range and resolve the workspace peer to 1.0.2; other workspace importers retain their existing versions.
- Add `codemode` and `tool_search` to the three packaged reviewers' existing tool lists, retaining read-only policy and legacy adapter entries, and verify native MCP access with those actual lists.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `workflow-tool-name-matching`: Clarify Pi native child-event identification and add a meaningful Pi 1.x host-verification requirement.

## Impact

This bounded follow-up covers Pi documentation, comment-only extension edits, the new OpenSpec delta, and parent-owned host verification/evidence. The authorized host target is Pi 1.x; Pi 1.0.2 is already installed on Bob's host. Any remaining host upgrade or setup and test execution are authorized by the user's follow-up instruction.

Pending native-MCP Proposal `1e831855-b9c5-4307-85b1-2ded89f48e6e` retains the broader installation, CLI, generic normalization, and documentation migration. `chorus agents add` currently installs the legacy adapter route. This follow-up does not rewrite that proposal or modify installers, CLI, other skills/docs, the archived change, or runtime matching/delivery logic. Its Pi peer manifest and corresponding lockfile updates establish the newly authorized Pi 1.x baseline; cumulative specs are updated at final archive.

The parent owns the host harness, documentation mirroring, independent verification, and checklist completion. Tasks are checked as their evidence is verified. Changes are committed locally after verification, with no version bump, publishing, push, or merge.
