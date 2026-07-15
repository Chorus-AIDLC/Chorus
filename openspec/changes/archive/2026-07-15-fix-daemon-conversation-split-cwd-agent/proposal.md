# Fix daemon conversation split on cwd / agent switch

## Why

On the daemon page, working one idea from a **different cwd** — or after the idea is
**reassigned to a different agent** — splits the conversation into two threads: the
user's typed instructions land in one, the AI's streamed replies in another. Because the
Interrupt button only matches the running execution belonging to the thread on screen, it
never renders on the thread the user is in, so a running turn **cannot be interrupted**
(无法打断). This is the user-reported defect for idea `2ddd1d11`.

There are two distinct split mechanisms, verified in the code:

1. **Cross-cwd fork (one agent).** For a *directed* idea-anchored wake whose resolved
   origin connection differs from the idea's existing session origin,
   `createTurnAndResolveTarget` mints a NEW per-instance session
   `sessionId = \`${directIdeaUuid}::${origin.uuid}\`` with `directIdeaUuid = null`
   (`src/services/notification-turn.ts:731-746`) and files the user's `human_instruction`
   / pending turn there. The daemon, however, re-derives the PLAIN idea uuid `X` from
   lineage (`cli/waker.mjs:380`, `cli/event-router.mjs:409-491`) and reports the AI
   transcript + turn lifecycle onto the OLD canonical session `X`. → user in `X::conn`,
   AI in `X`. This fork was a *deliberate* design (per-cwd transcripts), now reversed by
   the owner's decision.

2. **Agent-switch split (across agents).** `DaemonSession` is keyed
   `@@unique([agentUuid, sessionId])`. Reassigning idea `X` from agent A to agent B makes
   later wakes resolve `(B, X)` — a brand-new row — while agent A's previously-running
   turn lives on `(A, X)`. Per-agent threads are *intended*; the gap is only that the
   user cannot interrupt A's still-running turn from B's thread.

The correct model already exists for the offline case:
`repointSessionOriginAndSend` (`src/services/daemon-instruction.service.ts:930-1029`)
moves `originConnectionUuid` on the SAME session (same `sessionId`/`directIdeaUuid`) — no
fork. This change extends that "re-point, don't fork" model to the autonomous wake path
and hardens interrupt so it always reaches the idea's running turn regardless of which
thread is on screen.

## Decisions (from elaboration round 1, resolved)

- **conv-model = one thread per idea, follow the instance.** On a cwd switch, re-point the
  idea's canonical session to the new online instance (repoint-style); never mint an
  orphan `X::conn` session.
- **agent-switch = one thread per agent is expected.** Do NOT unify across agents; each
  agent keeps its own conversation for the idea.
- **interrupt = harden (defense-in-depth).** Interrupt must reach the idea's running turn
  from any thread being viewed, even a legacy residual/other-agent thread.
- **existing-residual = fix-forward only.** Prevent NEW splits and heal the interrupt
  affordance in the UI; do NOT run a DB migration to merge historical residual rows.
- **switch-ux = silently re-point and continue.** No new confirmation dialog for this
  idea; make the plumbing correct so nothing splits and interrupt works.

## What Changes

- **Reverse the cross-cwd fork.** In `createTurnAndResolveTarget`, a *directed*
  idea-anchored wake whose resolved online origin differs from the idea's existing
  canonical session origin SHALL re-point that canonical session's `originConnectionUuid`
  to the resolved origin and create the turn on the SAME session (keeping `sessionId ===
  directIdeaUuid`), instead of forking `X::<conn>`. This is the second — and only other —
  deliberate reversal of the write-once `originConnectionUuid` invariant, alongside
  `repointSessionOriginAndSend`.
- **Harden interrupt matching in the chat UI.** Derive the composer's controllable
  execution from the idea's running execution across ALL connection slices (not only the
  viewed session's origin-connection slice), and make the per-conversation match tolerant
  of the legacy `X::<connUuid>` residual key so a pre-existing residual (or another
  agent's) thread regains a working Interrupt button. No server or DB change for the heal
  — the interrupt POST already carries `exec.connectionUuid` + `exec.entityType` +
  `exec.entityUuid`.
- **BREAKING (spec-level, not user-facing):** the previously-specified
  `daemon-cwd-instance-addressing` behavior "a cross-cwd mention opens a per-instance
  session rather than re-pointing" is reversed to "re-point the canonical session".

## Capabilities

- `daemon-cwd-instance-addressing` — MODIFIED: cross-cwd directed idea wakes re-point the
  canonical session instead of forking a per-instance `X::conn` session.
- `daemon-interrupt-resume` — ADDED: interrupt reaches the idea's running turn from any
  thread; the per-conversation match tolerates the legacy residual `::` key.

## Impact

- **Code:** `src/services/notification-turn.ts` (fork → re-point);
  `src/components/agent-presence/chat/session-execution.ts` +
  `src/components/agent-presence/chat/daemon-chat.tsx` (interrupt matching);
  possibly `src/components/agent-presence/chat/transcript-view.tsx` for the composer
  execution source.
- **No schema migration.** `originConnectionUuid` re-point is an UPDATE on an existing row
  (the same operation `repointSessionOriginAndSend` already performs). No new column,
  endpoint, or permission bit.
- **Fix-forward:** existing residual `X::conn` rows remain in the DB as read-only history;
  the UI heal restores their Interrupt affordance without migrating them.
- **Tests:** unit tests for the re-point branch (server) and the widened interrupt match
  (UI helpers), plus an integration checkpoint driving cwd-switch and agent-switch
  end-to-end.
