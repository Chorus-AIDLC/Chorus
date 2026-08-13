# Technical Design: Un-pinned @mention wakes respect the agent's pinned cwd

## Overview

This change flips one deliberately-specced invariant — "un-pinned `mentioned`
wake → raw online-first" — so that an un-pinned `@mention` walks the same
cwd-resolution ladder as `task_assigned`. The whole behavior lives in one
server-side chokepoint; there is no new transport, schema, or endpoint.

## Current-behavior audit (the research deliverable)

All wake-target resolution happens in `createTurnAndResolveTarget`
(`src/services/notification-turn.ts`). The resolution ladder, in priority order:

1. **`resolvePinnedTarget(ctx, trigger)`** returns a HARD pin if one applies:
   pre-resolved activity cwd snapshot → temporary host/cwd → **explicit mention
   pin** (host+cwd parsed from mention markup) → **task instance override** →
   **own-idea instance pin** → **root-idea inheritance** (same-agent guard).
2. **`selectOriginConnection(connections, pin)`** matches a hard pin to an
   ONLINE `DaemonConnection` by strict `(host, cwd)` equality, classifying the
   result as `directed` / `offline_pin` / `online_first` / `none`. An offline
   HARD pin is notify-only, never re-routed (the deliberate MR #354 reversal).
3. **Idea session-origin upgrade** (`resolveIdeaSessionOriginTarget`): only when
   the selection is still `online_first`, re-point the wake to the idea's
   existing `DaemonSession.originConnectionUuid` when that connection is online.
4. **Project-owner-pin fallback** (`resolveProjectOwnerCwdPin`): only when still
   `online_first`, read the agent OWNER's `ProjectAgentCwdPreference` for
   `(ownerUuid, projectUuid, agentUuid)` and re-select against it as a HARD pin.

Net precedence: **instance pin → online idea session-origin → project-owner pin
→ raw online-first.**

### Trigger classification

`NOTIFICATION_ACTION_TO_TURN_TRIGGER` collapses notification actions into a
small set of `TurnTrigger` values. Two behavior classes for cwd resolution:

| Class | Triggers | Steps 3 & 4 (upgrade + owner-pin) |
|---|---|---|
| **Upgrade-eligible** | `task_assigned` (collapse target of `proposal_approved`/`proposal_rejected`/`idea_claimed`/`task_verified`/`task_reopened`), `elaboration`, `elaboration_verified`, `start_development`, `yolo_requested` | **Applied** |
| **Excluded** | `mentioned`, `human_instruction`, `resource_resumed` | **Skipped** |

The `mentioned` exclusion is the audited defect. `human_instruction` is
correctly excluded (its exact target + `deliver_turn` are resolved by the
instruction send path — including it would double-deliver). `resource_resumed`
is a synthetic control-channel dispatch that is never persisted, so it never
reaches this chokepoint.

### Two-pin verification (Q3)

The two pins are distinct models at distinct tiers, confirmed to both be honored
for `task_assigned` and both skipped for un-pinned `mentioned`:

- **Instance pin** — `AgentInstance` (`(agent, host, cwd)`), reached via an
  `agent_instance` assignee. Highest priority (step 1). Already honored for a
  `mentioned` wake **when the mention carries an explicit pin** or inherits the
  root-idea instance pin (the `resolvePinnedTarget` mention branch) — so this
  tier is not the gap.
- **Project-owner pin** — `ProjectAgentCwdPreference`, reached via step 4. This
  is skipped for `mentioned` today — part of the gap.

### Return-wake finding (Q6 follow-up)

- The woken agent **does** know who woke it: the notification carries
  `actorType` / `actorUuid` / `actorName`, and the wake prompt (`cli/prompts.mjs`)
  injects `@[actorName](actorType:actorUuid)`; the `task_assigned` prompt
  instructs the agent to @mention the assigner back on completion.
- There is **no** dedicated return-wake: `submit_for_verify` / `report_work` are
  non-wake actions, and the assigner is not a recipient of the submit event. The
  only working return path is the manual @mention — which is exactly the path
  this change fixes. Hence no separate return-wake mechanism is built (owner
  decision Q7 = minimal).

## Architecture (the fix)

Anchor a `mentioned` wake on its **root Idea** and let it enter steps 3–4:

- **Root-idea anchor.** A mention targets any entity (comment/idea/proposal/
  task/document). Resolve its root Idea with the shared root-idea resolver (the
  same resolver the existing mention-pin inheritance already uses for the
  comment's root Idea). If there is no root Idea, steps 3–4 have no idea anchor
  and the wake falls through to step 4's project lookup (by the mention target's
  project) and then online-first.
- **Session-origin upgrade (step 3) for `mentioned`.** Applies only when the
  mentioned agent is the root Idea's assignee agent (its conversation lives on
  that idea) and that session origin is online — mirroring the existing
  mention-pin inheritance's "mentioned agent IS the root Idea's assignee agent"
  distinction. When the mentioned agent is a *different* agent (or no root Idea),
  the idea's session belongs to another agent and step 3 does not resolve a
  target for this agent → fall through to step 4.
- **Project-owner-pin fallback (step 4) for `mentioned`.** The mentioned agent's
  owner's `ProjectAgentCwdPreference` for `(project of the mention target, that
  agent)`, applied as a hard pin exactly as for `task_assigned`.

Implementation is confined to the trigger-classification sets and the mention
branch's idea-anchor resolution in `notification-turn.ts`. When step 3 or 4
resolves a target, the existing directed-delivery path (`deliver_turn` +
broadcast-suppression + cross-cwd session re-point) fires unchanged — the same
machinery `task_assigned` already uses.

## Module contracts

- **cwd precedence is unchanged** — this change does not reorder the ladder; it
  only removes `mentioned` from the two exclusion sets and supplies its idea
  anchor. `human_instruction` / `resource_resumed` stay excluded.
- **Explicit mention pin unchanged** — a mention markup pin is resolved at step 1
  and short-circuits steps 3–4 as today.
- **No-pin / no-session preservation** — an un-pinned mention of an agent with no
  live idea session and whose owner has no project pin resolves to raw
  online-first, byte-for-byte as before. This is the regression guard the tests
  must lock.

## Verification strategy

1. **Unit / integration** (hard gate): table-driven tests over every
   `NOTIFICATION_ACTION_TO_TURN_TRIGGER` value × {instance pin, online
   session-origin, project-owner pin, none}. New assertions for un-pinned
   `mentioned`: session-origin upgrade when the mentioned agent owns the root
   idea's live session; project-owner-pin fallback otherwise; raw online-first
   when neither applies. Regression assertions: `task_assigned` unchanged,
   explicit-pin mention unchanged, `human_instruction` still excluded.
2. **Live e2e with Codex** (empirical, owner-authorized). The daemon serving
   this session cannot be restarted to reconfigure multi-agent mode (it would
   kill the session), so the e2e uses a **separate test daemon** serving both
   Claude and Codex. Steps: pin Codex at the idea and project level to a chosen
   cwd; (a) assign a task to Codex and confirm the wake lands in the pinned cwd;
   (b) `@mention` Codex (un-pinned mention) and confirm the wake lands in the
   pinned cwd — the primary fix; (c) have Codex @mention the assigner back and
   confirm the return-wake lands in the assigner's pinned cwd. Evidence =
   daemon logs / session transcript showing the landed cwd per case. If the
   live wake cannot be fully closed headlessly, capture the evidence and hand
   final sign-off to the human.

## Risks & mitigations

- **Wrong-agent session-origin.** Routing a mention to the root idea's session
  when that session belongs to a *different* agent would target the wrong
  daemon. Mitigation: the step-3 guard requires the mentioned agent to be the
  root idea's assignee (its own session), matching the existing mention-pin
  inheritance rule; otherwise fall through to step 4.
- **Broadening the "autonomous wake" surface.** The project-owner-pin fallback
  spec says "autonomous server-minted wakes"; a human-triggered mention is
  arguably not "autonomous." Mitigation: the spec delta explicitly names the
  un-pinned `mentioned` wake as in-scope for the fallback, removing the
  ambiguity.
- **Offline pin semantics.** A resolved project-owner/instance pin that is
  offline stays notify-only (the MR #354 reversal), inherited unchanged — a
  mention to an offline pinned cwd is NOT re-routed. Tests assert this.

## Audit correction (post-approval, from task 1)

Implementing task 1's audit refined the premise this proposal opened with. Two
corrections, now reflected in the code comments and the shipped tests:

1. **An un-pinned `@mention` is NOT raw online-first today.** `mention.service`
   (`createMentions` → `resolveMentionTarget` → `resolveProjectAgentCwdTarget`)
   already resolves, at notification-creation time, both the direct idea's
   `agent_instance` pin (threaded as `pinnedHost/pinnedCwd`) and the
   **mentioner-owner's** `ProjectAgentCwdPreference` (threaded as
   `resolvedCwdSource="project_fixed"`). Both become HARD pins in
   `resolvePinnedTarget` (lines 347 / 371) → `directed` / `offline_pin`. So the
   fix's step-4 (idea session-origin) and step-4a (project-owner-pin) additions
   are purely **additive** — they fire ONLY in the residual `online_first` case
   (no explicit pin, not the direct-idea instance assignee, and the
   mentioner-owner had no project pref). The two genuine gaps closed are: the
   **idea session-origin upgrade** for `mentioned`, and a **target-agent-owner**
   project-pin fallback (step 4a) for the case where mention.service's
   mentioner-owner lookup found nothing.

2. **No new comment→root-idea resolver hop is needed** (the proposal-reviewer's
   NOTE turned out moot for the common case). `mention.service` rewrites a
   comment mention's `entityType`/`entityUuid` to the comment's TARGET
   (idea/task/proposal/document — all lineage-walkable), so `directIdeaUuid`
   already resolves via the existing step-3a lineage walk. Only the
   deleted-comment edge (target lookup missing) leaves `entityType: "comment"`,
   which degrades gracefully to online-first.
