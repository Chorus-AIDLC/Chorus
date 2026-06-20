# Design — Chat-style Daemon UI

## Context

The daemon-conversation backend (子1/子2/6fab91cd) is in place. This change is the
**consumption surface + a UI redesign + one visibility fix**. Three confirmed
product decisions from elaboration (idea `25fe9cb7`) anchor the design:

- **Q1 = redesign the existing "View all" modal** (not a new route). The sidebar
  pill + popover remain the lightweight glance.
- **Q2 = agent-first.** A small agent dropdown is the primary axis; the left list
  shows the selected agent's conversations (not a cross-agent inbox).
- **Q3 = full history, paginated.** All of that agent's sessions (active + ended),
  newest-first by `lastTurnAt`.
- **Q4 = keep execution rows + do the ad-hoc fix.** The pill/popover execution
  glance stays; the ad-hoc `daemon_session` visibility fix ships.

## Goals / Non-Goals

**Goals**

- Make a daemon conversation readable: turns + their `user`/`assistant`
  transcript, live.
- Let a user continue (send) and interrupt a conversation inline.
- Make ad-hoc conversations appear in the running/queued execution surfaces.
- Reuse, not re-build: the send backend, interrupt control, transcript SSE,
  session list are all shipped.

**Non-Goals**

- No full stream-json (thinking / tool blocks) — `user`/`assistant` text only
  (总纲 Q4=a). No full transcript persistence / replay — rolling window only
  (总纲 Q7=b). No multi-driver (codex/opencode) transcript normalization — Claude
  Code only. No new permission bit. No deep-linkable per-conversation URL (the
  modal is the surface).

## Architecture

```
                 ┌─────────────────────────── "View all" modal (redesigned) ───────────────────────────┐
                 │  ┌─ left pane ──────────────┐   ┌─ right pane ───────────────────────────────────┐  │
 agent selector ─┼─▶│ [▼ Agent: Admin Claude]  │   │  header: conversation title · trigger · status │  │
 (small dropdown)│  │  ──────────────────────  │   │          ▸ details (host/version/uptime)        │  │
                 │  │  ▸ conversation row       │──▶│  ── turn band: ⚡ task_assigned · running ──     │  │
 conversation    │  │  ▸ conversation row  ●run │   │       user: …    assistant: …                   │  │
 list (paged,    │  │  ▸ conversation row       │   │  ── turn band: ✎ human_instruction · ended ──   │  │
 lastTurnAt desc)│  │  … load more …            │   │       user: …    assistant: …                   │  │
                 │  └──────────────────────────┘   │  ── footer: [ compose … ] [Send] [Interrupt] ─── │  │
                 │                                  └─────────────────────────────────────────────────┘  │
                 └──────────────────────────────────────────────────────────────────────────────────────┘
```

### Data flow

1. **Agent selector + conversation list.** The chat view fetches
   `GET /api/daemon-sessions` (already returns every visible session with
   `originOnline`). Client-side: group by `agentUuid` to populate the agent
   dropdown; filter to the selected agent; sort by `lastTurnAt` desc; paginate
   client-side (the payload is small — a page-size slice with a "load more"). The
   default selected agent is the one with the most recent `lastTurnAt` (so the
   modal never opens empty when any conversation exists).
2. **Transcript read.** On selecting a conversation, fetch
   `GET /api/daemon-sessions/[sessionUuid]` → `{ session, turns: [{...turn,
   messages: [{role, text, seq}]}] }`. Render turn bands in `seq` order; messages
   in `seq` order within each band.
3. **Live updates.** While a conversation is open, the SSE stream forwards
   `transcript:{sessionUuid}` events (route change below). `turn_created` appends
   a new band; `turn_status_changed` patches the band's status (pending →
   running → ended); `transcript_appended` patches the affected turn's message
   tail. No polling.
4. **Send / interrupt.** The footer reuses `SendInstructionBox` (子2: direct-send
   to the open session, or ad-hoc new session) and the interrupt control (POST
   `/api/daemon/control { command: "interrupt", ... }` via the shared
   `InterruptButton`), both gated on origin-online.

### Backend contracts

**New read route — `GET /api/daemon-sessions/[sessionUuid]`**

Returns the session plus its turns each with their rolling-window messages.
Owner-scoped via the existing `ownerScope` fence; a session the caller cannot see
→ 404 (non-disclosure), identical to `getSessionTurns`.

```ts
// Response data
{
  session: SessionView,            // existing shape
  turns: Array<TurnView & {        // existing TurnView +
    messages: Array<{
      uuid: string;
      role: "user" | "assistant";
      text: string;
      seq: number;
      createdAt: string;           // ISO-8601
    }>;
  }>;
}
```

New service function `getSessionDetail(auth, sessionUuid): Promise<SessionDetailView | null>`
in `daemon-session.service.ts`. It resolves the session under `ownerScope`
(returning `null` for non-visible → route maps to 404), then loads turns ordered
by `seq` and their messages ordered by `(turnUuid, seq)` in **one** additional
query (`daemonTranscriptMessage.findMany({ where: { turnUuid: { in: [...] } } })`)
and folds messages into their turns in memory — no N+1. The per-message projection
**reuses the existing `TranscriptMessageView` shape and `toTranscriptMessageView`
mapper** (already defined in the ingest path) — no new message type. This composes
with the existing `getSessionTurns` (it does not replace it; the list-targeting
path still uses the lighter projection). A READ that does NOT swallow.

**SSE route — subscribe the open session's transcript channel.**

`src/app/api/events/route.ts` already subscribes `change`, `presence`, and
`execution:{connectionUuid}` (per visible connection). Add a transcript
subscription, per-session via a query param: when a conversation opens, the chat
surface reconnects its EventSource with `?sessionUuid=<uuid>`; the route
subscribes `transcript:{sessionUuid}` ONLY after verifying the session is visible
to the caller (a lightweight owner-scope visibility check — drop the subscription
silently if not visible, never confirm). It forwards `transcript:{sessionUuid}`
events tagged `type: "transcript"`, dropping events whose `companyUuid` != the
caller's (same multi-tenancy drop the change / presence / execution handlers do).
Rejected alternative: subscribing ALL visible sessions' channels at stream start —
a user with many sessions would fan out a large channel set for data only one open
pane needs.

The `TranscriptEvent` payload already carries `companyUuid` (multi-tenancy drop)
and the full affected `turn`; the route tags it `type: "transcript"` like the
execution handler tags `type: "execution"`. The transcript-append trigger also
needs the appended messages on the wire — extend the publish on
`transcript_appended` to include the appended message tail, reusing the existing
`TranscriptMessageView` shape (already produced by `toTranscriptMessageView` in
the ingest path) rather than inventing a new message shape. (Fallback: the client
re-fetches the open session on append; we prefer carrying the tail to avoid a
round-trip — see Risks.)

**⚠ Which provider carries the transcript stream — the decisive wiring fact.**
The "View all" modal is mounted at the **shell level, inside
`AgentPresenceProvider` but OUTSIDE every `RealtimeProvider`** (`RealtimeProvider`
only wraps per-`<main>` route children; `agent-presence-context.tsx` documents this
explicitly). `AgentPresenceProvider` runs its **own** company-wide
`EventSource("/api/events")` and deliberately does not depend on `RealtimeContext`
— the execution-row live updates the chat reuses already flow through that
provider's `mergeExecutionEvent`, NOT through `realtime-context`. Therefore the
transcript live wiring MUST live in `AgentPresenceProvider`, not in a new
`realtime-context` hook (a `useTranscriptSubscription` in `realtime-context` would
silently no-op inside the modal):

- `AgentPresenceProvider` gains an "open session" input (the chat sets the
  currently-open `sessionUuid`); the provider reconnects its `/api/events`
  EventSource with `?sessionUuid=<uuid>` when it changes, and routes incoming
  `type: "transcript"` events to subscribers.
- `useAgentPresence()` exposes a way to (a) set the open session and (b) subscribe
  to that session's transcript events (e.g. `setOpenSession(sessionUuid)` +
  `subscribeTranscript(cb)` on the context value, mirroring how the provider
  already owns the execution merge). The chat container calls these; no
  `realtime-context` change is required.
- Reconnecting the shell stream with a new `?sessionUuid=` is a deliberate,
  low-frequency action (the user switching conversations), and the existing
  execution/visibility re-sync on reconnect (already implemented in the provider's
  `handleVisibility` + poll) keeps the execution map fresh across the reconnect.

**Ad-hoc execution visibility fix — `daemon-execution.service.ts` + ingest route.**

Root cause: `EXECUTION_ENTITY_TYPES = [task, idea, proposal, document]`;
`filterValidExecutionEntities` drops any entry whose type is outside this set
(`continue` on unrecognized type) → the ad-hoc `daemon_session` row never reaches
`reconcileSnapshot`. Fix (additive, no migration):

1. Add `"daemon_session"` to `EXECUTION_ENTITY_TYPES`.
2. In `groupEntityUuidsByType` and `filterValidExecutionEntities`, add a
   `daemon_session` branch that validates existence against
   `prisma.daemonSession` (by `uuid`, companyUuid-scoped) instead of the four
   content tables. A `daemon_session` row carries no `rootIdeaUuid` semantics
   change (ad-hoc sessions have `directIdeaUuid: null`). **Note:** the
   `Record<ExecutionEntityType, ...>` literal maps inside both functions (the
   `acc` accumulator in `groupEntityUuidsByType` and the `existing` map in
   `filterValidExecutionEntities`) must gain an explicit `daemon_session` key —
   widening the union type alone leaves those object literals missing the key and
   fails the build.
3. In `enrichExecutionViews`, resolve a `daemon_session` row's display title from
   the `DaemonSession` (its `title`, or a localized "Conversation {short-id}"
   fallback) and a `null` `projectUuid` (no project deep link — `execHref` returns
   null for the type, which is fine: the conversation lives in this modal).
4. The ingest route's zod `snapshotEntrySchema` enum gains `daemon_session` (it
   derives from `EXECUTION_ENTITY_TYPES`, so this is automatic once step 1 lands —
   verify the enum is built from the constant).
5. Frontend `useEntityTypeLabel` gains a `daemon_session → t("entityConversation")`
   case; `execHref` already returns `null` for unknown types (a conversation row
   is not a deep link). The execution row renders "Conversation" instead of
   `entityUnknown`.

### Frontend module shape

Inside `src/components/agent-presence/`:

- `chat/conversation-list.tsx` — agent dropdown + paginated session list (left
  pane). Consumes the `GET /api/daemon-sessions` list (fetched by the chat view).
- `chat/transcript-view.tsx` — right pane: header (title + trigger + status +
  collapsible connection details) + turn bands + footer (compose + interrupt).
- `chat/turn-band.tsx` — one turn: trigger glyph + label + live status + optional
  task/idea deep link; renders its `message-bubble`s.
- `chat/message.tsx` — a single `user`/`assistant` message (role-labeled,
  mono timestamp, privacy note that transcript text is daemon-self-reported).
- `chat/daemon-chat.tsx` — the two-pane composition + the read fetch + the live
  transcript wiring (via `useAgentPresence().setOpenSession` +
  `subscribeTranscript`, NOT a `realtime-context` hook) + the empty/offline/stale
  states. Replaces `AgentConnectionsView` as the modal body.
- `connections-modal.tsx` — swap `AgentConnectionsView` → `DaemonChat`.
- `contexts/agent-presence-context.tsx` — **extended** (not a new file): its
  existing `/api/events` stream also routes `type: "transcript"` events; the
  context value gains `setOpenSession(sessionUuid | null)` (drives the
  `?sessionUuid=` reconnect) and `subscribeTranscript(cb)`. This is the provider
  the modal actually lives under, so the transcript live updates must originate
  here.

`SendInstructionBox`, `ExecutionRow`/`InterruptButton`, `IdentityBlock`,
`StatusDot`, the formatter hooks are **reused** as-is.

## Design language (frontend-design)

This is a redesign *inside* an established product. The Chorus "warm deck" system
is the brief's own visual direction, so it is inherited exactly for cohesion:
background `#FAF8F4`, cards `#FFFFFF`, primary terracotta `#C67A52`, borders
`#E5E0D8` / `#EFEBE4`, muted `#6B6B6B` / `#9A9A9A`, Geist Sans for text and Geist
Mono for data (ids, timestamps, durations). No new palette is invented.

**Signature — the Turn as the structural unit.** The craft budget is spent on the
one thing that should be distinctive: the right pane is deliberately **not** a
generic two-color chat-bubble stream. It is a **session transcript** where the
structural device is the *turn band*, and each band's eyebrow encodes real
provenance — *why the agent woke*:

| trigger | glyph | label |
|---|---|---|
| `task_assigned` | ⚡ ListChecks | Task |
| `mentioned` | @ AtSign | Mention |
| `elaboration` | ? HelpCircle | Elaboration |
| `human_instruction` | ✎ PenLine | Instruction |
| `resume` | ↻ RotateCw | Resume |

The numbering/eyebrow is information, not decoration: turns are a real `seq`
sequence carrying genuine trigger provenance (this is exactly the
"structure is information" principle — not arbitrary 01/02 markers). A band that
is `task_assigned` or entity-bearing also shows a deep link to the related
task/idea, making "this chat = one task execution" literal.

**The single bold moment:** the *running* turn's left spine gets a soft terracotta
pulse (`motion-safe:` only; reduced-motion shows a static terracotta spine). One
animated element, everything else quiet — Chanel's "remove one accessory":
metadata is demoted to a collapsible disclosure rather than competing tiles.

Within a band, messages are a quiet transcript: a small role label
(`you` / agent name), the text, a mono timestamp. Not mirrored left/right bubbles
— a transcript reads top-to-bottom like a log, which matches "this is an
execution record."

**Quality floor:** responsive (desktop two-pane ↔ mobile list/drill-down, reusing
the existing breakpoint pattern), visible keyboard focus, `motion-safe`-gated
pulse, every string i18n'd (en + zh), IME-guarded Enter in the composer (already
handled by the reused `SendInstructionBox`).

## Empty / degraded states

- **No agent online + no sessions:** the modal shows a calm empty state ("No
  conversations yet" — an invitation, not an error).
- **Agent has no sessions:** left list empty state, right pane prompts to start a
  conversation (the composer's ad-hoc path).
- **Selected conversation's origin offline:** transcript is read-only — history
  shows, the composer disables the direct-send with the existing `originOffline`
  reason, Interrupt is hidden (nothing running on a dead origin). This reuses the
  shipped `originOnline` gate verbatim.
- **Read fetch fails:** a distinct error state in the right pane (never a silent
  empty — the no-silent-error contract the connection view already honors).

## Risks / Trade-offs

- **`transcript_appended` payload.** The shipped `TranscriptEvent` carries the
  `turn` but not the appended messages. To render an append live without a
  round-trip, the publish on append should include the appended message tail.
  Mitigation: extend the append publish to carry the tail (additive to the
  payload; the existing `turn` field stays). If that proves larger than wanted,
  fall back to a debounced re-fetch of the open session on append — slower but
  correct. We carry the tail.
- **Client-side pagination of the list.** The session list endpoint returns all
  visible sessions; for a heavy user this could be large. Acceptable for now
  (sessions are coarse-grained, one per conversation); if it grows, add server
  pagination later — out of scope here, and we `log` nothing is silently
  truncated (we render all, paginate the view).
- **SSE reconnect on conversation switch.** Reconnecting the EventSource with a
  new `?sessionUuid=` on every conversation switch is a stream churn. Mitigation:
  only the *open* conversation needs live transcript; switching is a deliberate
  user action (low frequency), and the execution/presence/change subscriptions
  re-establish on reconnect exactly as they do today on visibility-change. Keep it
  simple; revisit only if churn is observed.

## Migration

None. `DaemonExecution.entityType` is a free-string column (no enum constraint);
`DaemonTranscriptMessage` exists. The fix is code-only (whitelist + validation
branch + label + zod enum derivation).
