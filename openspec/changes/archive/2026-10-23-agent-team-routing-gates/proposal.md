## Why

Personal project Teams currently expose membership but cannot safely orchestrate product/development handoffs while keeping one Idea owner. Existing admin permissions alone do not enforce per-Idea human approval. This change implements Idea Agent Team ③, following the user's explicit-owner creation rule and the private Team boundaries delivered by ①/②.

## What Changes

- Leave unassigned Ideas unassigned. Explicit assignment to an eligible lead enrolls an Idea into that lead owner's personal project Team; do not silently migrate existing Ideas.
- Keep the lead as the single Idea assignee. Provide a permission-checked product delegation operation and role recommendations (online, load, reopen affinity, dependency-chain tie breaker), with actionable fallback reasons.
- Preserve enrollment when the Team disappears or lead becomes ineligible, so automation pauses rather than bypasses gates. Human management remains available.
- Enforce human approval for non-YOLO proposals and current eligible lead approval/verification for YOLO proposals/tasks at shared mutation boundaries, across REST and MCP. Human YOLO activity is the source of authority, not agent prose.
- Route relevant lifecycle notifications back to the enrolled lead, and expose safe gate state in UI and owner-private recommendations in MCP.
- Align daemon prompts and all maintained plugin/skill ports. Independent reviewer wake remains Idea ④.

## Capabilities

### New Capabilities
- `idea-team-orchestration`: Explicit enrollment, delegated product work, recommendations, lifecycle routing and authoritative per-Idea gates.

## Impact

Idea persistence/migration, assignment/handoff, proposal/task/elaboration services, notification routing, MCP tool contracts, one authenticated gate-context read API, Idea detail UI/i18n, CLI/OpenClaw prompt parity, plugin skills and tests. No public/shared Team, implicit permission grant, retroactive bulk assignment, independent review-agent wake, deployment, push or merge.

## Acceptance

Unassigned creation stays inert. After explicit lead assignment, product can elaborate and author proposals without taking ownership; non-YOLO waits for human approval; development recommendations respect load/affinity; the lead verifies. YOLO authority is isolated to each Idea. Empty roles, offline members, removal/unbinding, multiple proposal inputs, private ownership and API bypass attempts have deterministic tests.
