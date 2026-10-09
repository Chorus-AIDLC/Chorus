## Context

Authoritative choices: native and adapter support; broad query family rather than a fixed 14-tool list; no strong isolation. Source evidence: https://github.com/Chorus-AIDLC/Chorus/issues/606 and pi-subagents 0.76.1 `src/runs/shared/child-tool-plan.js`, `mcp-direct-tool-allowlist.js`, and `src/agents/agents.js` (https://github.com/nicobailon/pi-subagents).

The issue's proposed role MCP servers work for native discovery but do not alone solve adapter handoff. The inspected pi-subagents version rejects selected adapter servers available only through runtime snapshots. Agent-relative `subagentOnlyExtensions` is supported and is an explicit provider-loading mechanism for stable extension tools. We therefore use the same packaged provider contract on both hosts instead of editing user MCP configuration or depending on three mutually incompatible gateway names.

## Decisions

### Stable, packaged role providers

Reviewer frontmatter declares common local tools plus `chorus_review`; worker declares common read/write tools plus `chorus_work` and optional supervisor support where portable. Each explicitly loads its role provider using an agent-relative `subagentOnlyExtensions` path. Providers live outside the auto-loaded extensions directory so installing the package does not expose worker capabilities to a reviewer by default. The bundled parser/launcher resolves these paths against the agent file, passes them via extension arguments, and preserves user agent override precedence.

Each provider registers one stable extension tool with a discover/call interface: discovery returns only allowed, actually available Chorus tools and their argument schemas; call accepts a canonical Chorus operation and arguments, checks the role predicate first, then forwards through MCP. No arbitrary JSON-RPC method or URL override is accepted. This is a restricted MCP entry point, not an unrestricted adapter gateway. Parent MCP configuration remains unchanged.

### One shared policy

Reviewer allows `chorus_get_*` and exactly `chorus_list_tasks`, `chorus_list_projects`, `chorus_search`, `chorus_checkin`, `chorus_add_comment`. Worker adds `chorus_claim_task`, `chorus_release_task`, `chorus_update_task`, `chorus_report_work`, `chorus_report_criteria_self_check`, `chorus_submit_for_verify`, `chorus_session_checkin_task`, `chorus_session_checkout_task`. No worker/reviewer admin, entity-creation or session-lifecycle operations. The orchestrator/extension owns session creation/closure and approval/verification. Calls using disallowed names fail before contacting Chorus. Discovery filters unknown operations and follows tools/list pagination; stale tools are not launch requirements.

### Shared transport and discovery

Extract/reuse the existing extension HTTP MCP transport rather than creating an unrelated client. Resolve URL/key via existing config helpers; keep auth out of prompts/logs. Handle initialization, session headers, JSON/SSE envelopes, transport/JSON-RPC/tool errors and abort/finite timeout. Any schema lookup or call failure is visible; never convert a failed remote call into success. Role tools return real MCP content and error state. Lifecycle hooks retain existing behavior and tests.

### Bundled dispatcher and prompts

The bundled dispatcher loads declared provider extensions and keeps explicit local-tool allowlists. The shared role policy also governs any legacy direct-tool expansion; it must not retain obsolete unrestricted gateways, expand a reviewer to worker/admin operations, or pass a provider path as a tool name. Worker providers remain available even when native MCP is absent in a child. Agent bodies direct discovery/calls through the stable role tool; `tool_search`, `mcp`, `mcpScript`, `codemode` are not unconditional child requirements. Read-only behavior permits test/build outputs, not deliberate source modification or git writes.

### Compatibility and user configuration

Native, adapter5 default script mode, and bundled dispatch must run without role server aliases or user agent overrides. Existing user agents still override package agents. Preserve the package's supported older-host range where the common extension API works; run available compatibility fixtures and report any untested cells accurately. Do not overwrite global Pi settings, model credentials or MCP files. E2E hosts use isolated agent dirs and a local development Chorus instance.

## Verification

Unit tests: broad query/new get matching, deny admin/mutation/unknown gateway calls, worker additions, filtered discovery/pagination, backend error and cancellation propagation, provider loading/path resolution, all four frontmatters free of conditional tool requirements, missing configuration, and legacy dispatcher behavior.

Runtime tests must use installed Pi and pi-subagents, start reviewer/worker children and inspect actual registry/call results/exit status. Matrix: Pi >=1.1.0 native + nicobailon 0.76.1; same Pi with adapter 5.1.0 defaults + nicobailon; bundled dispatcher regression. Use existing deterministic provider/fixture patterns for CI; configuration-only assertions are insufficient.

Additionally perform a real model-driven AI-DLC run against local Chorus using the local package. Capture sanitized entity IDs, child run IDs/verdicts/statuses and commands. Main Pi must create and elaborate an idea, submit a proposal, dispatch a proposal reviewer, approve it, dispatch a worker implementing a small independently testable change, dispatch a task reviewer, verify, dispatch aggregate reviewer and create the report. Run both native and adapter host journeys, or report a failing acceptance rather than claiming full completion. No production test entities.

## Risks

Explicit provider extensions must survive nicobailon async launching and bundled CLI tool filters; runtime tests are the release gate. MCP wrapper tools do not automatically trigger per-operation parent nudges; the orchestration skills and explicit reviewer dispatch remain authoritative, and lifecycle cleanup must still complete. Broad get matching intentionally admits future get tools and notification-read effects. Credentials plus bash remain outside the enforcement boundary.
