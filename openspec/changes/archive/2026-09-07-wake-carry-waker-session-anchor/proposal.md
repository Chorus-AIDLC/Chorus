## Why

When one agent wakes another (an orchestrator dispatching a worker, or any agent
`@mention`-ing a peer), the wake payload carries the waker's **identity**
(`actorType/actorUuid/actorName`, plus the derived assignment `orchestrator`) but
**no pointer to the waker's live session**. Nothing tells the woken agent that
replying *here* — on this idea/task/resource — lands back in the waker's existing
conversation. So a woken peer's reply tends to scatter or open a brand-new
session, and agent-to-agent collaboration loses its anchor. The substrate to land
a reply back already exists (idea-anchored `DaemonSession` +
`resolveIdeaSessionOriginTarget` + the `RESIDUAL_CWD_UPGRADE_TRIGGERS` return
ladder); what is missing is that the woken agent is never *told* the anchor is
there.

This is the owner's #1 slice of the "multi-agent orchestration reliability" theme
(`f10eeb04`), deliberately scoped down: **surface the anchor, do not build new
routing.**

## What Changes

- For **agent-originated** wakes on an **idea/theme-anchored** resource, the wake
  payload gains a derived, **non-persisted** `wakerSession` anchor: the waker
  agent's current live session for that idea (its `DaemonSession` + whether its
  origin connection is online). It is resolved at wake-serialize time from the
  existing session/connection state — **no schema column, no new DB writes** —
  reusing the same derivation + serialization + prompt-append machinery that
  already carries the `orchestrator` attribution.
- The daemon **wake prompt** gains one advisory line whenever a live
  `wakerSession` anchor is present: it names the waker (`@[Name](agent:uuid)`) and
  states that replying on *this* resource reaches the waker's live session rather
  than opening a new one. This is **advisory only** — it changes no server
  routing; the return reply still lands via the existing return ladder.
- When the waker's origin is **offline** at wake time, no live anchor is
  emitted (notify-only; the prompt makes no stale "live session" claim). This is
  the accepted V1 boundary.
- The `chorus:orchestrate` skill documents the "reply-here-reaches-the-waker"
  semantics so workers know the anchor exists and how it behaves.

Scope is bounded to wakes that share an idea/theme key. **Out of scope (left to
sibling theme children):** ad-hoc peer anchoring with no shared idea; a durable
theme-level orchestrator-handle subsystem; enforced return-routing; offline
queue/replay; single-active-per-theme; the DAG auto-advancer.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities

- `agent-orchestrator-handoff`: extend wake attribution and the daemon prompt so
  that, in addition to the assignment-derived `orchestrator`, an **agent-originated,
  idea/theme-anchored** wake also carries the **waker's live session anchor** and
  the prompt restates the advisory "reply here reaches the waker's live session"
  guidance. (The anchor is **actor-scoped** — emitted for any agent waker, not
  only an assignment orchestrator — so it is a sibling of `orchestrator`, not a
  sub-field, and it inherits the same "read only the addressed resource, never
  traverse lineage" discipline.)
- `multi-agent-orchestration`: the `chorus:orchestrate` skill documents that a
  worker woken by an agent can reply on the shared resource to reach the waker's
  live session, and the offline (notify-only) boundary.

## Impact

- **Server** (`src/services/`): the orchestrator/attribution resolver and the
  wake-serialization path in the notification-turn flow — compute and attach the
  derived `wakerSession` anchor; the `NotificationResponse` payload type gains an
  optional `wakerSession` field.
- **Daemon prompt** (`cli/prompts.mjs`): append the advisory anchor line when a
  live `wakerSession` is present.
- **Skill docs**: `chorus:orchestrate` skill body across every plugin surface
  that carries it.
- **No** schema/migration, **no** new endpoint, **no** change to return-wake
  routing precedence.
- **Verification**: unit + integration coverage of the attribution/prompt path,
  plus a live Claude + Codex daemon e2e (peer wake → reply lands in the original
  waker session) as the human acceptance gate.
