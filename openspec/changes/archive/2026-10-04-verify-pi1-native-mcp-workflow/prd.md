# Pi / dsh workflow matching: approved implementation and Pi 1.x follow-up

## Initial approved scope (completed)

# Pi / dsh workflow tool-name matching

## Why

Pi and dsh can miss reviewer reminders when an MCP host changes the prefix of a Chorus tool. Pi currently understands bare and adapter-prefixed names, while dsh requires `mcp__chorus__`; neither consistently handles other namespaces. The human selected arbitrary prefixes with an exact complete operation-name suffix in elaboration round 1 of Idea `1f2b9067-2806-48ed-be14-414715ba7693`.

## What Changes

- Recognize the three workflow operations `chorus_pm_submit_proposal`, `chorus_submit_for_verify`, and `chorus_admin_verify_task` regardless of preceding text, provided the complete operation name ends the identifier.
- Preserve existing normalizer behavior for other tools, and add targeted workflow recognition rather than changing unrelated MCP operations.
- Match Pi events uniformly using the outer `toolName`, without gateway-specific branches or extracting `input.tool`, following the human's October 4 clarification (Idea comment `24942d56-adca-424e-8cc5-abf93145e2ff`).
- Cover both hosts with parameterized positive/negative names and event-to-reminder tests. Retain error, feature-switch, lifecycle, and dsh daemon-origin gates.

## Capabilities

### New Capabilities

- `workflow-tool-name-matching`: Host-independent recognition and reminder delivery for the three Chorus workflow operations in Pi and dsh.

### Modified Capabilities

None.

## Impact

Runtime changes are confined to `packages/chorus-pi` and `packages/chorus-dsh`, with focused tests and this OpenSpec change. No API, dependency, installation, credential, other-host, or release changes are required.

The pending Pi native-MCP Proposal `1e831855-b9c5-4307-85b1-2ded89f48e6e` retains ownership of basic generic Pi name normalization and installation/documentation. This change layers workflow-specific recognition over existing behavior. Developers must recheck that proposal and the working tree before edits; reuse landed changes and preserve concurrent work. The baseline inspected for this change is `99aceb0b949bb6ddaea141d143085663e40a1104`, with a clean source working tree.

Offline helper and real handler-factory tests are required. When a usable host environment is available, verify actual reminder injection in an isolated host session; otherwise report the host test as unverified rather than presenting offline tests as an end-to-end pass.

## Latest authorized Pi 1.x scope

Human comment `54859c03-029d-4739-b06e-75e915d4ed4f` selects the Pi 1.x native route described by Leo. This supersedes the earlier unresolved A/B deployment choice and initial exclusions of host/peer documentation updates. No gateway parsing is restored.

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
- Include parent-discovered native `chorus_list_tasks` and `chorus_list_projects` among reviewer reads, so the aggregate reviewer can enumerate materialized tasks; do not grant a general list-name prefix or business mutation operations.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `workflow-tool-name-matching`: Clarify Pi native child-event identification and add a meaningful Pi 1.x host-verification requirement.

## Impact

This bounded follow-up covers Pi 1.x peer/lock and reviewer-tool compatibility, documentation, comment-only edits to the Chorus hook extension, the new OpenSpec delta, and parent-owned host verification/evidence. The authorized host target is Pi 1.x; Pi 1.0.2 is already installed on Bob's host. Any remaining host upgrade or setup and test execution are authorized by the user's follow-up instruction.

Pending native-MCP Proposal `1e831855-b9c5-4307-85b1-2ded89f48e6e` retains the broader installation, CLI, generic normalization, and documentation migration. `chorus agents add` currently installs the legacy adapter route. This follow-up does not rewrite that proposal or modify installers, CLI, other skills/docs, the archived change, or runtime matching/delivery logic. Its Pi peer manifest and corresponding lockfile updates establish the newly authorized Pi 1.x baseline; cumulative specs are updated at final archive.

The parent owns the host harness, documentation mirroring, independent verification, and checklist completion. Tasks are checked as their evidence is verified. Changes are committed locally after verification, with no version bump, publishing, push, or merge.
