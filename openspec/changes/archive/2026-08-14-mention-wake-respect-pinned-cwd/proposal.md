# Un-pinned @mention wakes respect the agent's pinned cwd

## Why

In multi-agent mode (one daemon serving N independent agents), an agent can be
pinned to a working directory at two levels: an **idea/task instance pin**
(`assigneeType = "agent_instance"`, a durable `(agent, host, cwd)`) and a
**project-owner pin** (`ProjectAgentCwdPreference`, a per-user/project/agent
fixed cwd). When one agent wakes another — by assigning a task, or by
`@mention`ing it in a comment — the woken session must land in the cwd the pin
names, not an arbitrary online instance.

An audit of the server-side wake chokepoint (`createTurnAndResolveTarget` in
`src/services/notification-turn.ts`) found the two wake families are **not**
symmetric:

- A **`task_assigned`** wake (also the collapse target of `proposal_approved`,
  `proposal_rejected`, `idea_claimed`, `task_verified`, `task_reopened`) walks
  the full cwd-resolution ladder: **instance pin → online idea session-origin →
  project-owner pin → raw online-first**. It respects both pins.
- An **un-pinned `@mention`** wake is a broadcast that resolves to **raw
  online-first**. It is *deliberately excluded* from both the idea
  session-origin upgrade and the project-owner-pin fallback
  (`daemon-cwd-instance-addressing` and `project-cwd-anchoring` both encode this
  exclusion). So an `@mention` of an agent that is pinned only at the
  project/idea level (not via an explicit in-mention pin) wakes an **arbitrary
  online cwd** — the same class of "random cwd" defect that the proposal-wake
  session-origin fix (`fix-proposal-wake-session-origin`, MR #381) and the
  project-owner-pin fallback (`daemon-multi-agent-project-polish`, MR #484)
  closed for the `task_assigned` family.

This asymmetry has a second, higher-stakes consequence. There is **no dedicated
return-wake** mechanism: when a woken developer agent B finishes and wants to
notify the agent A that delegated the task, the only path is B **manually
@mentioning A** (the `task_assigned` wake prompt explicitly instructs this).
That return-@mention rides the exact un-pinned-`@mention` path above — so today
it wakes A at a random online cwd instead of A's pinned working directory.
**Fixing the `@mention` gap is therefore also what makes agent→agent
return-wakes land in the correct cwd.**

## What Changes

Bring the un-pinned `mentioned` wake onto the **same** cwd-resolution ladder as
`task_assigned`:

1. An un-pinned `mentioned` wake, anchored on the **mention's root Idea**
   (resolved via the shared root-idea resolver), SHALL receive the **idea
   session-origin upgrade** when that root Idea has an existing online session
   origin for the mentioned agent.
2. When no higher-priority step resolves a target, an un-pinned `mentioned` wake
   SHALL receive the **project-owner-pin fallback** — the mentioned agent's
   owner's `ProjectAgentCwdPreference` for the `(project, agent)` pair.
3. When neither applies, the wake falls back to raw online-first **exactly as
   today** — no regression for agents/ideas with no pin and no live session.

Explicitly **unchanged**: a `@mention` that carries an explicit `(host, cwd)`
pin in its markup still resolves as a hard pin (highest priority); a
`human_instruction` wake is still excluded (its target is resolved by the
instruction send path); `resource_resumed` is a synthetic control dispatch that
never reaches this chokepoint. No dedicated task-completion return-wake is added
(the fixed `@mention` path is sufficient — see design §Return-wake).

## Capabilities

- **daemon-cwd-instance-addressing** (MODIFIED) — the idea session-origin
  upgrade family now includes the un-pinned `mentioned` wake; the pinned/online-
  first base requirement's mention scenario is narrowed to the no-upgrade case.
- **project-cwd-anchoring** (MODIFIED) — the autonomous project-owner-pin
  fallback explicitly includes the un-pinned `mentioned` wake.

## Impact

- **Code:** `src/services/notification-turn.ts` — the trigger-classification
  sets that exclude `mentioned` from the session-origin upgrade and the
  project-owner-pin fallback, plus the root-idea anchor resolution for a
  mention. No other transport is added — the change reuses the existing
  directed-delivery (`deliver_turn` / broadcast-suppression) machinery.
- **No** database schema change, migration, new permission bit, new endpoint,
  or new picker.
- **Verification:** unit/integration tests for the new mention resolution plus
  regression tests pinning the unchanged behavior, and a real multi-agent
  live e2e using a separate daemon serving Claude + Codex (owner-authorized).
- **Behavioral risk:** an un-pinned `@mention` that previously woke an arbitrary
  online cwd will now be directed. This is the intended fix; the no-pin /
  no-session case is preserved so agents without any pin see no change.
