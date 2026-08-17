# Technical Design: `chorus_pm_assign_idea` + assigner provenance + `chorus:orchestrate`

## Overview

The idea-assignment mechanism already exists end-to-end for the human UI; this change adds an
MCP surface over the same primitive, plus one prose addition to the wake, plus documentation
and a new skill. There is **no schema change** and **no new wake plumbing** — the tool reuses
`ideaService.assignIdea()` and the existing `assigned`-Activity → `idea_claimed` wake path.

## Architecture

Current human path (the model to mirror), verified:

- `claimIdeaToAgentAction` (`src/app/(dashboard)/projects/[uuid]/ideas/[ideaUuid]/actions.ts:67-137`)
  calls `assignIdea({ assigneeType, assigneeUuid, assignedByType, assignedByUuid, instanceUuid?, cwd* })`
  then writes `createActivity({ action: "assigned", targetType: "idea", actorType: "user", actorUuid, value })`.
- `assignIdea()` (`src/services/idea.service.ts:843-889`) is reassign-safe:
  `newStatus = existing.status === "open" ? "elaborating" : existing.status`; instance pin via the
  shared `resolveAssigneeFields` (`agent_instance`). **It emits only an `updated` change event —
  NOT the `assigned` Activity.** The actor-bearing `assigned` Activity is the caller's job.
- The `assigned` Activity flows through `notification-listener.ts` (`idea:assigned → idea_claimed`,
  line 25), which resolves the recipient to the assignee **agent** (instance → owning agent,
  lines 299-318) and the assigner name via `resolveActorName` (line 589), then
  `notification.service` → `notification-turn` maps `idea_claimed → task_assigned` turn trigger
  and wakes the assigned agent's daemon.

New MCP tool does exactly what the server action does, with `actorType: "agent"`.

```
chorus_pm_assign_idea (pm.ts)
  ├─ gate: idea:admin (permission-map.ts)
  ├─ validate target: agent holds idea:write (reuse existing eligibility) | user same-company
  │                    instanceUuid (if any) belongs to company + that agent
  ├─ ideaService.assignIdea({ assigneeType, assigneeUuid, assignedByType:"agent",
  │                           assignedByUuid: auth.actorUuid, instanceUuid? })
  └─ createActivity({ action:"assigned", targetType:"idea", actorType:"agent",
                      actorUuid: auth.actorUuid, value:{ assigneeType, assigneeUuid, instanceUuid? } })
        → idea_claimed wake (existing) → assigned agent
```

## Data Model

None. Reuses the polymorphic `Idea.assigneeType`/`assigneeUuid` pair (`user` | `agent` |
`agent_instance`) and existing provenance columns (`assignedByType`, `assignedByUuid`,
`assignedAt`, `cwd*`). No migration.

## API Design (MCP tool contract)

`chorus_pm_assign_idea`:

| Param | Type | Notes |
|-------|------|-------|
| `ideaUuid` | string (required) | Idea to assign |
| `assigneeType` | `"agent"` \| `"user"` (required) | Discriminator |
| `assigneeUuid` | string (required) | Agent uuid or User uuid per `assigneeType` |
| `instanceUuid` | string (nullish) | Only valid with `assigneeType:"agent"`; pins to an `AgentInstance` (`assigneeType` persists as `agent_instance`) |

- Gate: `idea:admin`. Only admin-preset agents see/call it.
- Behavior: silent takeover; `open → elaborating`, else status preserved; no new status logic.
- Errors: ineligible target agent (lacks `idea:write`) → reject; user not in company → reject;
  `instanceUuid` not found / not this agent → reject; idea not found → notFound. Offline pinned
  instance → assignment persists, wake notify-only (HARD pin policy, `instance-addressed-assignment`).
- Returns the updated assignment (assigneeType/uuid, status).

## Module Contracts

1. **Assign Activity is the wake trigger.** The tool MUST emit `createActivity({ action:"assigned",
   targetType:"idea", actorType:"agent", actorUuid: auth.actorUuid, value })` after `assignIdea`
   — mirroring `actions.ts:107-127`. Without it there is no wake. `value` carries `assigneeType`,
   `assigneeUuid`, and `instanceUuid?` for attribution parity with the UI path.
2. **Target eligibility reuse.** Agent-target check reuses the existing effective-permission check
   for `idea:write` (as in `route.ts:80-88` / `getAssignableAgents(companyUuid, "idea:write")`,
   `actions.ts:261`). Do not hand-roll a new permission check.
3. **Rework the wake body — provenance AND stage-correct guidance.** `cli/prompts.mjs`
   `idea_claimed` case (lines 322-327) MUST be reworded on two axes:
   - **Provenance:** interpolate the assigner — `n.actorName` / `n.actorType` / `n.actorUuid` are
     already available at build time (typedef lines 26-28; threaded per `event-router.mjs:402-403`;
     server-supplied via `notification.service.ts:212-214`; name resolved at
     `notification-listener.ts:589`). Add "assigned to you by `<actorName>` (`<actorType>`)".
   - **Stage-correct guidance (blocker fix):** the current prose tells the agent to
     `chorus_claim_idea` "to begin elaboration". But the assignment has already set the assignee,
     so `chorus_claim_idea` throws `AlreadyClaimedError` (`idea.service.ts:807-808`) and hard-fails
     with "Cannot claim an elaborated Idea" (`idea.service.ts:811-813`) for the in-scope
     elaborated-backfill case. Replace the claim instruction with: *you are now the assignee —
     `chorus_get_idea` to review, then advance from the current stage (continue elaboration while
     `elaborating`; author the proposal once `elaborated`), stopping at the proposal / verify
     gates; never merge automatically.* This matches the elaboration q5 mandate and removes the
     erroring instruction on both the agent- and human-initiated paths.
   - Keep the existing `mentionGuidance` tail (lines 37-42). Mirror BOTH changes in the OpenClaw
     twin `packages/openclaw-plugin/src/event-router.ts:339`. No server-side change is required —
     the actor data already flows.

## Implementation Plan

1. **MCP tool** — register `chorus_pm_assign_idea` in `src/mcp/tools/pm.ts` (near
   `chorus_pm_assign_task`, 733-881); add `chorus_pm_assign_idea: "idea:admin"` to
   `src/mcp/tools/permission-map.ts`. Wire `assignIdea` + `createActivity` per the contract.
   Unit tests (service mocked): agent target, user target, instance pin, silent takeover,
   ineligible agent rejected, status open→elaborating vs preserved, activity emitted with
   `actorType:"agent"`.
2. **Rework the wake body** — edit `cli/prompts.mjs` `idea_claimed` body + the OpenClaw twin
   `event-router.ts:339` to (a) name the assigner and (b) replace the `chorus_claim_idea`
   instruction with "review + advance from current stage, stop at the gate" (blocker fix). Add a
   prompt-builder unit test asserting the assigner appears for an agent actor and a user actor,
   and that the prose does not instruct `chorus_claim_idea`.
3. **Docs** — add `chorus_pm_assign_idea` to `docs/MCP_TOOLS.md` and to the idea-skill Tools
   table across the six skill surfaces.
4. **`chorus:orchestrate` skill** — author `SKILL.md` in all six surfaces (paths below) and add a
   `## Skill Routing` row to each entry skill + the Kiro steering overview. Content: assign-idea /
   assign-task / independent review, collaboration-mode selection by scenario, single-owner &
   concurrency discipline, Reversed-Conversation gates. **No version bump in this change** —
   release handles version bumps for the unreleased 0.16.3.
5. **Integration & verification** — integration test of the tool path (assignee/status/Activity,
   incl. the user-target notification) + provenance/guidance prompt test; verify the assignment
   wake reaches the assignee and is not suppressed by the assignee's `idea_claimed` notification
   preference (or document if pref-gated); document the live daemon-wake check for human
   verification.

### Skill surfaces (parity — six)

| # | Surface | New skill path | Entry routing |
|---|---------|----------------|---------------|
| 1 | Claude Code | `public/chorus-plugin/skills/orchestrate/SKILL.md` | `public/chorus-plugin/skills/chorus/SKILL.md` `## Skill Routing` (409-422) |
| 2 | Codex | `plugins/chorus/skills/orchestrate/SKILL.md` | `plugins/chorus/skills/chorus/SKILL.md` |
| 3 | OpenClaw | `packages/openclaw-plugin/skills/orchestrate/SKILL.md` | `packages/openclaw-plugin/skills/chorus/SKILL.md` |
| 4 | Kiro | `public/kiro-plugin/.kiro/skills/chorus-orchestrate/SKILL.md` (`chorus-` prefix) | `public/kiro-plugin/.kiro/steering/chorus.md` |
| 5 | Pi | `packages/chorus-pi/skills/orchestrate/SKILL.md` | `packages/chorus-pi/skills/chorus/SKILL.md` |
| 6 | Standalone | `public/skill/orchestrate-chorus/SKILL.md` (`-chorus` suffix) | `public/skill/chorus/SKILL.md` |

Invocation differs per surface (Claude Code `/chorus:orchestrate`, Codex `$orchestrate`, OpenClaw
`/orchestrate`, Pi `/skill:orchestrate`, standalone plain text). No manifest enumerates skills —
they are auto-discovered from `skills/`; the only manifest edits (version bumps) are deferred to
release.

## Risks & Mitigations

- **Missing the `assigned` Activity** → no wake. Mitigation: the contract + a test asserting the
  Activity is emitted.
- **Wake tells the agent to claim an already-assigned idea** → `chorus_claim_idea` throws
  (`AlreadyClaimedError`; hard-fail on `elaborated`). Mitigation: the wake reword (Contract 3)
  replaces the claim instruction with review + advance; a prompt test asserts `chorus_claim_idea`
  is not instructed.
- **Assignment wake suppressed by the assignee's notification preferences.** Mitigation: task 5
  verifies delivery (or documents pref-gating) so a directed assignment is not silently dropped.
- **Provenance data assumed present but isn't for agent actors.** Mitigation: the test covers an
  agent actor; `resolveActorName` already handles agent actors.
- **Six-surface drift** (skill added to some surfaces, not all). Mitigation: parity AC enumerates
  all six paths; follow the `plugin-maintenance` skill.
- **Accidental version bump on an unreleased version.** Mitigation: explicit "no version bump"
  in the skill task AC; release skill owns bumps.
- **Live daemon-wake e2e is not headless-automatable.** Mitigation: integration test covers the
  server path; the daemon-wake + provenance display is a documented human verification step.

## Out of Scope

- No bulk "assign all children of a theme" API (orchestrate skill loops the primitive per child).
- No change to `chorus_claim_idea` (self-claim) or `chorus_release_idea`.
- No plugin version bumps (release-time concern).
