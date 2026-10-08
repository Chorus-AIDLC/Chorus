## Why

Issue #606 reports that chorus-pi reviewers request mutually unavailable native/adapter tool names under pi-subagents 0.76.1, producing failed runs even after publishing a verdict. Workers inherit no native Chorus MCP without explicit selection. The user confirmed native and adapter coverage, the existing broad query policy, and tool-level rather than sandbox isolation; then authorized YOLO delivery and local Pi/Chorus end-to-end verification.

## What Changes

- Replace host-dependent child tool names with stable role-scoped Chorus tools loaded explicitly through packaged child extensions.
- Reviewers retain `chorus_get_*`, `chorus_list_tasks`, `chorus_list_projects`, `chorus_search`, `chorus_checkin`, and `chorus_add_comment`. Workers add the task claim/release/update/report/self-check/submit and task session checkin/checkout operations.
- Reuse one role policy and MCP transport across the child providers and bundled dispatcher. Discover actual remote schemas, reject forbidden operations before network dispatch, and propagate backend failures.
- Preserve local reviewer reading/testing, without source-edit tools; workers keep implementation tools. Ensure nicobailon and bundled children explicitly load the required provider, independent of native MCP, adapter script mode, or deferred discovery.
- Document the role tool invocation and the intentional security boundary; add regression tests and run a complete local AI-DLC workflow with real Pi agents.

## Capabilities

### New Capabilities
- `pi-child-role-tools`: portable child tools and role enforcement across native/adapter hosts and both dispatchers.

### Modified Capabilities

None; existing package-discovery and workflow behavior is preserved.

## Impact

Touches `packages/chorus-pi` runtime, agent definitions, tests, README and `docs/CONNECT_PI.md`. No backend schema/API changes, plugin version bump, release, commit, push or merge. The primary parent session can continue using native MCP or its configured adapter. Child tools reuse the existing resolved Chorus connection without writing user MCP configuration.

## Acceptance

All three reviewers and the worker launch with resolvable tools on Pi 1.1.x + pi-subagents 0.76.1, in native mode and with pi-mcp-adapter 5.1.0 defaults. Reviewer tools reject state-changing operations; workers can complete their task workflow. The bundled dispatcher remains functional. Real local Chorus evidence covers idea, elaboration, proposal, proposal review, approval, worker implementation, task review, verification, code review and report, with no false-negative child exit or missing Chorus tools.

## Non-goals

No credential, OS, network or per-UUID isolation. Bash/test subprocesses and inherited credentials mean this is a tool-surface and behavioral boundary, not a security sandbox. Query/checkin notification-read side effects are retained. No changes to unrelated plugin ports.
