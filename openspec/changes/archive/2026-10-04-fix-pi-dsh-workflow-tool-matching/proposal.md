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
