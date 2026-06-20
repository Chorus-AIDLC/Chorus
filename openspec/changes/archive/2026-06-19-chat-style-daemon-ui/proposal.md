# Chat-style Daemon UI

## Why

The daemon-conversation backend is fully shipped (子1 #332: `DaemonSession` /
`DaemonSessionTurn` / `DaemonTranscriptMessage`, transcript ingest, the
`transcript:{sessionUuid}` SSE channel; 子2 #333: send-instruction + ad-hoc
session creation + `originOnline`; 6fab91cd 子3: interrupt/resume control). But
the **consumption surface** never landed. Today a user opening the "Agent
Connections" modal sees a master-detail *connection inspector*: a rail of
connections, per-connection host/uptime tiles, a running/queued execution list,
and a send-instruction dock. There is **no way to read what an agent actually
said or did** — the durable transcript is invisible.

The mental model the connection inspector encodes ("a connection is a row of
metadata") is also the wrong one. The shipped backend model is "a daemon session
is a persistent conversation, and every wake is one turn." The UI should make
that legible: **each conversation = one task-execution record you can read,
continue, and interrupt.**

Two concrete defects compound the gap:

1. **No transcript read path for the UI.** `getSessionTurns(auth, sessionUuid)`
   returns turns but **not** the per-turn `user`/`assistant` messages, and there
   is no `GET /api/daemon-sessions/[uuid]` detail route. The frontend also never
   subscribes to the already-published `transcript:{sessionUuid}` SSE channel, so
   even if it rendered turns they would not update live.

2. **Ad-hoc executions are silently dropped.** An ad-hoc (non-idea) wake reports
   its execution with `entityType: "daemon_session"`, but the server's
   `filterValidExecutionEntities` whitelist (`EXECUTION_ENTITY_TYPES`) only knows
   `task | idea | proposal | document` — so the row is dropped before a
   `DaemonExecution` is ever created, and the conversation never appears in the
   running/queued list. A user who sends an ad-hoc instruction sees *nothing*
   running.

## What Changes

- **Redesign the "View all" modal body into a chat-style two-pane layout.**
  Left = a small agent selector (dropdown) + that agent's conversation list,
  paginated, newest-first by `lastTurnAt`. Right = the selected conversation's
  transcript, rendered as **turn bands** (each band labeled by its wake trigger —
  task / @mention / elaboration / instruction / resume — with live status and a
  deep link to the related task/idea), with the human messages and agent replies
  flowing inside each band. Connection metadata (host, version, uptime, started)
  is **demoted** to a collapsible header disclosure, not the headline.
- **Inline conversation controls.** The right pane footer carries the
  send-instruction composer (reusing 子2's send / ad-hoc paths) and an
  **Interrupt** affordance for the running turn (reusing 6fab91cd's control
  channel) — gated on origin-online exactly as the existing send dock is.
- **A read route for the transcript.** Add `GET /api/daemon-sessions/[uuid]`
  returning the session's turns **with** each turn's rolling-window
  `user`/`assistant` messages, owner-scoped (404 non-disclosure on a session the
  caller can't see). The frontend subscribes to `transcript:{sessionUuid}` and
  patches turns/messages incrementally — no polling.
- **Fix ad-hoc execution visibility.** Add `daemon_session` to the execution
  entity-type space, validate it against the `DaemonSession` table (not
  task/idea/proposal/document), accept it at the ingest route's zod boundary, and
  label it as a "Conversation" in the execution rows. No DB migration — the
  `DaemonExecution.entityType` column is already a free string.
- **Keep the glanceable surfaces.** The sidebar presence pill + popover and their
  running/queued execution rows stay as the at-a-glance "what's running"; the
  ad-hoc fix makes ad-hoc conversations show up there too. The chat list marks a
  conversation as running independently, off live turn status.

## Capabilities

- **`daemon-session-transcript-read`** (new): the read-API contract for a single
  session's turns-with-messages, its owner-scoped non-disclosure, and the
  frontend's live incremental rendering off `transcript:{sessionUuid}`.
- **`daemon-execution-state`** (modified): extend the running/queued execution
  model to recognize the `daemon_session` (ad-hoc conversation) entity kind so an
  ad-hoc wake is no longer silently dropped, and is labeled as a conversation.

## Impact

- **Affected specs:** `daemon-session-transcript-read` (added),
  `daemon-execution-state` (modified — one added requirement; existing behavior
  preserved).
- **Affected code (backend, small):**
  `src/services/daemon-session.service.ts` (new messages-projection read; append
  publish carries the message tail),
  `src/app/api/daemon-sessions/[sessionUuid]/route.ts` (new),
  `src/app/api/events/route.ts` (subscribe `transcript:{sessionUuid}` for the
  open session, visibility-gated), `src/services/daemon-execution.service.ts` +
  `src/app/api/daemon/execution-state/route.ts` (ad-hoc entity type).
- **Affected code (frontend, primary):** the `src/components/agent-presence/`
  module — `connections-modal.tsx` reshaped around a new chat view, new
  conversation-list / transcript / turn-band / message components, reuse of
  `SendInstructionBox` and the interrupt control; `hooks.ts` (`daemon_session`
  label); **`src/contexts/agent-presence-context.tsx`** extended to route
  `type: "transcript"` events on its existing shell-level `/api/events` stream and
  expose `setOpenSession` + `subscribeTranscript` (the modal lives under THIS
  provider, not `RealtimeProvider`); `messages/en.json` + `messages/zh.json` (new
  i18n keys).
- **No schema migration.** `DaemonExecution.entityType` is a free-string column;
  `DaemonTranscriptMessage` already exists.
- **No change** to 子1's transcript ingest, 子2's send backend, or the
  interrupt/resume backend — this is consumption + redesign + one visibility fix.
- **Design system:** inherits the existing Chorus "warm deck" tokens (cream
  `#FAF8F4`, terracotta `#C67A52`, `#E5E0D8` borders, Geist Sans/Mono). The new
  visual idea is confined to how a turn/transcript is rendered. `docs/design.pen`
  is updated to reflect the redesigned modal.
