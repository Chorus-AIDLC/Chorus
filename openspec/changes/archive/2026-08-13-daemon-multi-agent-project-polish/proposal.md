# Polish multi-agent daemon project scope

## Why

The multi-agent daemon work (idea `c5e806bb`, PR #483) let one daemon serve N
independent agents, each with its own working directory (cwd). Three rough edges
surfaced once people ran multiple agents / multiple cwds in the same project:

1. **Overview cwd badges are indistinguishable.** On the project overview
   (dashboard) header, each configured agent's cwd shows as a badge that renders
   *only* the cwd path — the agent's name is hidden in a hover tooltip. Two
   agents' badges look identical (same icon, same styling), and cwds that share a
   long common prefix truncate to the same visible string. You cannot tell whose
   cwd is whose without hovering each one.

2. **Autonomous wake ignores the project cwd pin.** When an agent has a fixed
   project-level cwd pin but a wake is minted autonomously (a plain
   `task_assigned` / `idea_claimed` / `proposal_*` activity, with no idea/task
   instance pin and no UI-threaded target), the server never consults the project
   pin and falls straight to "first online connection". So the agent can wake in
   the wrong cwd even though the project explicitly pinned one.

3. **Presence count is per-cwd-instance, not per-agent.** The bottom-right
   floating presence pill is labeled "agents online" but counts daemon
   *connections* — one `(agent, host, cwd)` each. An agent online in three cwds is
   counted as three. The number should reflect distinct agents, regardless of how
   many cwds each exposes.

These are all follow-on polish to already-shipped multi-agent behavior — no new
data model, no new permission bit.

## What Changes

- **Overview cwd badge (`project-agent-cwd`):** each project-overview cwd badge
  becomes agent-identifiable — a colored agent identity dot plus the visible
  agent name — and the cwd path moves into the hover tooltip. Uses the agent
  name / host already returned by `GET /api/projects/[uuid]/agent-cwds`; no API,
  service, or schema change.

- **Autonomous wake resolves the agent-owner's project pin
  (`project-cwd-anchoring`):** on the server-side wake path, the project pin
  replaces exactly the raw first-online ("first cwd") fallback. It sits **below**
  the existing higher-priority steps — an instance pin and an existing *online*
  idea-session-origin (the b729713b live-conversation fix) both still win, so a
  live conversation is never rerouted. Only when the selection would otherwise be
  a raw first-online pick does Chorus consult the `ProjectAgentCwdPreference` of
  the **agent's owner** for the wake's `(project, agent)` and, if one exists, use
  its `(host, cwd)` as a **hard** anchor. Per existing fixed-anchor hard-pin
  behavior and the owner's strict-offline decision, if that pinned cwd is offline
  the wake stays notify-only / does not reroute. No preference → unchanged
  online-first. This closes the gap where autonomous wakes bypassed the "fixed
  project cwd is authoritative" contract.

- **Presence count by distinct agent (`agent-connection-observability`):** the
  bottom-right floating entry's online count reflects the number of distinct
  online agents (an agent online across multiple hosts/cwds counts once),
  matching its "agents online" label. Frontend-only; the connection-oriented
  "View all" modal keeps its connection list unchanged.

## Capabilities

- `project-agent-cwd` — ADDED: project-overview cwd summary identifies each Agent.
- `project-cwd-anchoring` — ADDED: autonomous wakes resolve the agent-owner's
  fixed project cwd as a hard anchor.
- `agent-connection-observability` — MODIFIED: the floating-entry online count
  counts distinct online agents rather than connections.

## Impact

- **Frontend:** `project-cwd-summary.tsx` (badge), `daemon-presence-entry.tsx`
  (count display), plus updated component tests that currently lock per-connection
  count semantics.
- **Backend:** `notification-turn.ts` `createTurnAndResolveTarget` gains a
  project-pin fallback step placed **after** the idea-session-origin upgrade and
  gated on `selection.kind === "online_first"` (reads `ProjectAgentCwdPreference`
  for the agent owner); no schema change, no migration, no new permission bit.
- **Behavior reversal (scoped):** intentionally reverses the prior "cwd is NEVER
  inferred from the project" decision (DEC-5) **only** for the autonomous wake
  path, bringing it in line with the `project-cwd-anchoring` contract that UI
  paths already honor.

## Out of Scope

- Changing the "View all" daemon connections modal's count/labeling (it remains a
  connection list).
- Per-user pin selection UI or any change to how project cwd pins are *set*.
- Any new "第三" scope item — the source idea skipped that number; owner confirmed
  there is no third item.
