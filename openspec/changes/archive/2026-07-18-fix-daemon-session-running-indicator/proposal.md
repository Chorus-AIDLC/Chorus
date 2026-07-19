# Fix: online daemon session sometimes shows no "running" indicator / no Interrupt

## Why

An owner reported that a live daemon conversation they were actively talking to
could not be interrupted — the chat UI showed neither a "running" indicator nor
an Interrupt button, even though the agent was demonstrably working. A read-only
trace found **four** contributing causes; the owner scoped this change to the two
that are genuine, fixable defects (the other two are by-design and were explicitly
accepted as-is):

**P0 — the conversation-list running dot disagrees with the composer's Interrupt
(confirmed UI bug).** Both the list-row status dot and the composer's Interrupt
control are meant to reflect the same thing: is there a live `running`
`DaemonExecution` for this conversation? But they resolve it from different data:

- The composer (`daemon-chat.tsx` → `sessionExecutionsForComposer`) searches the
  conversation's origin-connection slice **and falls back to every other
  connection slice** when the origin has no match — so after a `cwd`/agent switch
  or a session re-point, it still finds the running turn on whatever connection
  now owns it (introduced in PR #429).
- The list row (`daemon-chat.tsx:332-335` → `sessionExecStatus`) reads **only**
  `executionsByConnection[session.originConnectionUuid]` — the origin slice, no
  cross-connection fallback.

So in exactly the re-pointed / agent-switched case, the dot reads idle while the
Interrupt button still works — the two disagree, and the user sees "no running
indicator" for a conversation that is in fact interruptible. This is the reported
symptom.

**P1 — a null `directIdeaUuid` for an idea-attributable entity is silent
(robustness / observability).** Autonomous child wakes (a `task_assigned` /
`proposal_*` wake on a child of an idea) only anchor to the idea conversation via
`directIdeaUuid` (PR #428 threaded this end-to-end). The daemon's lineage
resolver (`cli/lineage.mjs`) resolves each entity against
`GET /api/entities/{type}/{uuid}/root-idea`, which returns both `rootIdeaUuid`
and `directIdeaUuid`. When the resolver gets a **non-null** `rootIdeaUuid` but a
**null/absent** `directIdeaUuid`, that is the fingerprint of a lineage gap — most
often a *server older than the `directIdeaUuid` field*. The wake then anchors the
execution on the task/proposal instead of the idea, so it never matches the idea
conversation → no dot, no Interrupt, permanently, for that class of wake. Today
this anomalous case is folded into a generic `info` log line, indistinguishable
from the normal "this entity legitimately has no idea ancestor" outcome
(`rootIdeaUuid` also null). Operators have no visible signal.

The other two causes are **out of scope** by the owner's explicit decision:

- **Cause #1 (dominant, by design):** an ephemeral `claude -p` wake IS the whole
  lifetime of its execution row; between turns there is no running row to
  interrupt even while the connection is "online". Owner chose **accept as-is** —
  no tooltip, no distinct idle/running UI.
- **Cause #2 (~15s SSE catch-up):** a turn started after the viewer's SSE stream
  opened surfaces only via the 15s poll. Owner chose **no code** — the poll
  remains the safety net; dynamic channel subscription is not worth the
  complexity here.

## What Changes

- **P0.** The daemon conversation-list row's running/interrupted status is
  resolved with the **same cross-connection match** the composer's Interrupt
  control already uses, so the dot and the Interrupt button can never disagree.
  The origin-connection slice is still preferred (the common, scoped case); the
  fallback to other connection slices only engages when the origin slice has no
  matching execution — matching strictly by this conversation's own idea /
  session id, so a cross-connection match still belongs to this conversation
  only (it cannot borrow another conversation's run). A new pure helper composes
  the existing `sessionExecutionsForComposer` + `sessionExecStatus` and is unit
  tested.
- **P1.** The lineage resolver emits a **visible `warn`** — not a buried `info` —
  precisely when it resolves a **non-null** `rootIdeaUuid` together with a
  **null/absent** `directIdeaUuid` for an idea-attributable entity, naming the
  entity and stating the consequence (child/task wakes will anchor on the entity,
  not the idea conversation) and the most likely cause (a server predating the
  `directIdeaUuid` field). The normal "no idea ancestor at all" case
  (`rootIdeaUuid` null) stays a non-alarming `info`. This is **guard + visible
  log only** — no client-side root-idea fallback is added (owner's explicit
  choice).

## Capabilities

- `daemon-session-transcript-read` — ADDED requirement: the conversation-list
  running indicator SHALL be resolved by the same cross-connection match as the
  composer's Interrupt control, so the two never disagree.
- `root-idea-resolution` — ADDED requirement: the daemon lineage resolver SHALL
  emit a visible warning when it resolves a non-null root idea with a null direct
  idea for an idea-attributable entity.

## Impact

- **Affected code:**
  - P0: `src/components/agent-presence/chat/session-execution.ts` (new pure
    helper), `src/components/agent-presence/chat/daemon-chat.tsx` (list-row status
    call site, line ~332), plus unit tests for the new helper.
  - P1: `cli/lineage.mjs` (`#resolveViaServer` diagnostic log), plus
    `cli/__tests__/lineage.test.mjs`.
- **No** server, service, API, data-model, schema, or migration change.
- **No** i18n change (P0 changes only which executions feed an existing status
  glyph; no new user-facing string). No `design.pen` screen change (the dot and
  Interrupt already exist — this only makes them agree).
- **Out of scope (accepted as-is):** the between-turns idle state (cause #1) and
  the ~15s SSE catch-up window (cause #2).
