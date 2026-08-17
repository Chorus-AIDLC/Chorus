# Gateway resolve/skip of an assigned idea's elaboration (MCP parity with UI Verify-Elaborate)

## Why

In the `chorus_pm_assign_idea` orchestration model (parent idea `7c7409e4`, shipped in PR #494), an orchestrator such as Admin Claude owns a theme and acts as the human gateway, while an assigned agent (e.g. Codex) advances each child idea. A live orchestration E2E surfaced a gateway gap (finding #6):

- `chorus_pm_validate_elaboration` (service `resolveElaboration`) is **assignee-only** — a non-assignee caller is rejected with `Only the assigned agent can resolve elaboration`.
- `chorus_pm_skip_elaboration` (service `skipElaboration`) is likewise **assignee-only**.
- So an `idea:admin` gateway **cannot resolve or skip elaboration over MCP** for an idea assigned to *another* agent. Only the human UI's **Verify-Elaborate** button can — it resolves as a non-assignee (via `verifyElaboration`, emitting `elaboration_verified`) and wakes the assignee to write the proposal.
- In the live test only the assignee (Codex) could self-resolve because it happened to hold `idea:admin`. If the assigned agent lacks `idea:admin`, neither the non-assignee gateway nor the admin-but-non-assignee can resolve over MCP — a **deadlock**.

The capability already exists for humans; this change gives the `idea:admin` gateway the **agent-side equivalent** of the UI Verify-Elaborate handoff, without breaking Reversed-Conversation (the gateway only gatekeeps; it never writes the proposal on the agent's behalf).

## What Changes

- **Relax the actor gate** on both `resolveElaboration` and `skipElaboration` from "assignee only" to "**assignee OR a non-assignee holding `idea:admin`**". The admin signal is threaded from the MCP handler into the service (`actorIsIdeaAdmin`), so the service is self-protecting: a non-assignee without `idea:admin` is still rejected.
- **Branch the emitted activity on whether the caller is the assignee** (not on actor type):
  - **Caller is the assignee** → unchanged behavior: `resolveElaboration` logs `elaboration_resolved`, `skipElaboration` logs `elaboration_skipped`; **no cross-wake** (the assignee is already live in-session).
  - **Caller is a non-assignee `idea:admin` gateway** → log `elaboration_verified` (reusing the existing wake pipeline) so the **Idea's assigned agent is woken to write the proposal** — exactly the UI Verify-Elaborate handoff. The gateway skip carries its `reason` in the activity value for the audit trail.
- **Reuse the existing `elaboration_verified` recipient resolution.** That path already resolves recipients to the Idea's assignee agent (excluding humans) and applies actor-exclusion, so a gateway (a *different* actor) wakes the assignee, not itself. **No changes to the notification / turn / daemon-prompt layers are required.**
- **Offline policy = queue** (per elaboration parity). The gateway path emits the activity without an online check, so resolution/skip always succeeds and the wake is queued for an offline assignee and recovered on reconnect — matching the UI's "verified, queued" behavior.
- **Permission bits are unchanged**: `chorus_pm_validate_elaboration` stays `idea:admin`; `chorus_pm_skip_elaboration` stays `idea:write` (assignees keep skipping their own ideas with `idea:write`; the non-assignee branch requires `idea:admin`). This deliberately avoids the regression of moving skip to `idea:admin`.
- **Tool descriptions + skill/reference docs** updated to document the gateway resolve/skip path (idea skill N1/N2 notes, `chorus:orchestrate`, `docs/MCP_TOOLS.md`, and the standalone + plugin skill surfaces), while keeping the existing human-confirmation clause on the validate description.

## Impact

- **Affected specs:** `elaboration-resolution` (MODIFIED: the admin-gated resolution requirement gains the gateway path + wake branch; ADDED: a gateway-skip requirement).
- **Affected code:** `src/services/elaboration.service.ts` (`resolveElaboration`, `skipElaboration`), `src/mcp/tools/pm.ts` (both handlers thread `actorIsIdeaAdmin`; tool descriptions), tests in `src/services/__tests__/elaboration.service.test.ts`. No change to `stage-advance.service.ts` (its human-only invariant is preserved — the gateway path does NOT route through `executeStageAdvance`), the notification layers, or the permission map.
- **Docs:** `docs/MCP_TOOLS.md`, idea + orchestrate skills, standalone + plugin skill surfaces.
- **Out of scope / follow-up:** a live cross-agent wake E2E (gateway agent resolves → *different* assignee agent's daemon wakes to write the proposal) is recommended as a human-driven verification; the automated coverage here is unit-level.
