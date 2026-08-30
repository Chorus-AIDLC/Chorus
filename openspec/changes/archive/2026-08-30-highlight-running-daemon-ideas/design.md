## Context

The current design already has the pieces needed for a smaller solution:

- every Idea-anchored `DaemonSession` carries `directIdeaUuid`, `agentUuid`, and `originConnectionUuid`;
- every daemon wake is a `DaemonSessionTurn` with strict `pending → running → ended/interrupted` transitions;
- `advanceTurn` is the shared transition chokepoint;
- the dashboard shell owns one company-wide `/api/events` EventSource and the live daemon connection list;
- each connection projection already carries the agent, host, and CWD;
- `openChatForAgent(agentUuid, { host, cwd })` is the established locator used by the project-header CWD badges.

Therefore the feature does not need to modify `DaemonExecution`, resolve durable session UUIDs into execution events, or create a second server-side activity projection. Session activity is ephemeral UI state and can be reconstructed from current running turns plus two lifecycle events.

The Tracker is DOM-based while the graph paints cards on Canvas 2D. They need different presentation code, but both can consume one small shell-level `activeSessionsByIdea` map.

## Goals / Non-Goals

**Goals:**

- Identify an Idea as active only while at least one of its session turns is `running`.
- Keep the database and existing session/execution models unchanged.
- Use only `session_started` and `session_ended` as the new realtime event types.
- Reconstruct correct activity state on first connection and reconnect without a new polling loop.
- Preserve the existing agent+CWD focus while carrying the already-known session UUID so every breakpoint opens the exact conversation.
- Preserve existing Tracker row and graph node behavior outside the activity indicator.

**Non-Goals:**

- Enriching `ExecutionView`, adding an exact-session focus API, or changing daemon execution reconciliation.
- Persisting an Idea activity flag or session-activity history.
- Showing queued, interrupted, ended, idle, or merely online sessions.
- Adding interrupt/resume controls or a product-level reduced-motion setting.

## Decisions

### D1 — Emit only session start/end events from the turn-transition chokepoint

Add a company-wide event channel for this payload:

```ts
type SessionActivityEvent = {
  type: "session_started" | "session_ended";
  companyUuid: string;
  sessionUuid: string;
  activityUuid: string; // running turn UUID
  directIdeaUuid: string | null;
  agentUuid: string;
  originConnectionUuid: string;
};
```

`advanceTurn` already knows every legal turn transition and loads the owning session. It emits:

- `session_started` on `pending → running`;
- `session_ended` when a `running` turn transitions to any terminal state.

`activityUuid` lets the frontend maintain a set of running turns per session. This avoids assuming that a session can never have overlapping running turns: ending one activity removes only that token, and the session remains active until its final token ends.

The event is emitted only after the status write succeeds. Existing per-session transcript events remain unchanged for the open chat; the new company-wide events contain no transcript content.

**Alternative rejected:** derive Idea activity from `DaemonExecution` and enrich each execution with `sessionUuid`. That adds a server join and a parallel identity contract when the session transition itself is already authoritative.

### D2 — Bootstrap and reconnect by replaying current running activities through the same event shape

When `/api/events` opens, it subscribes to the company-wide session-activity channel and then performs one company-scoped query for currently running turns and their sessions. It sends each result as a synthetic `session_started` event using the same payload shape.

The listener is attached before the snapshot query:

- a start arriving during bootstrap is harmless because state is keyed by `activityUuid`;
- an end arriving during bootstrap removes that token;
- the query observes persisted turn state, so a completed activity is not reintroduced after its end write.

On EventSource reconnect, the same replay rebuilds the active set. No timer, new REST endpoint, or persisted activity table is added.

Activity observation and chat authorization are deliberately separate. A user sees activity for every session in the same company; an agent key remains limited to its own session activity. For each user subscriber, bootstrap and live payloads derive a subscriber-relative `canOpen` flag from existing agent ownership. Cross-company activity is never forwarded. The event carries no transcript content, and `canOpen: false` is enforced again by the frontend action rather than treated as a cosmetic disabled state.

### D3 — Frontend owns the dynamic active-session map

`AgentPresenceProvider` handles the two event types:

- `session_started` inserts `activityUuid` under `sessionUuid`;
- `session_ended` removes it;
- a session with zero activity tokens is removed.

It derives:

```ts
type ActiveIdeaSession = {
  sessionUuid: string;
  ideaUuid: string;
  agentUuid: string;
  originConnectionUuid: string;
  activities: ReadonlySet<string>;
};

type ActiveSessionsByIdea = ReadonlyMap<string, ActiveIdeaSession[]>;
```

Only entries with non-null `directIdeaUuid` participate in Idea indicators. Results are deduplicated by `sessionUuid` and ordered by `agentUuid`, then `originConnectionUuid`, then `sessionUuid`, independent of event arrival order.

Connection details are joined in memory from the provider's existing live connection list when available. The UI displays the agent name and, for owned sessions, host/CWD from that connection. If the connection has not loaded yet or belongs to another user, the session remains visible with its agent identity and ownership-safe status label.

### D4 — Navigation preserves agent/CWD context and exact-session focus

Activating an owned activity resolves its current origin connection and seeds the chat focus with:

```ts
{ agentUuid, sessionUuid, pin: { host, cwd } }
```

The provider already has `sessionUuid` from the activity event, so this requires no backend lookup. The agent+CWD pin preserves the established left-rail location while `sessionUuid` selects the exact transcript; mobile also opens its drill-down after the session list settles.

If an owned origin connection is temporarily unavailable, the target retains `agentUuid` and `sessionUuid` without fabricating a pin. For `canOpen: false`, the action is absent/disabled and never opens chat.

For one owned active session the indicator invokes this action directly. A single other-user session opens the status disclosure instead of chat. For multiple sessions it shows a chooser whose entries identify ownership; owned entries invoke the existing locator and other-user entries are status-only.

### D5 — Tracker and graph consume the same state with small renderer-specific adapters

The Tracker uses one DOM activity indicator in the shared Idea row and Idea detail sidebar:

- hidden when the Idea has no active session;
- animated when active;
- the shared animated Agent avatar is the running signal;
- hover/focus shows avatar, identity, CWD, and ownership-safe status entries;
- click stops row propagation and performs direct-or-chooser navigation.

The graph attaches only an `activeSessionCount` and the corresponding session entries to Idea `ForceNode`s. The Canvas paints a compact active mark in a fixed node region. Existing node hover overlay displays the agent+CWD list, and hit-testing treats the mark separately from expand and card-body actions.

The existing generic read/write presence ring and lifecycle badge remain unchanged; session-running state is a separate visual signal.

### D6 — Tests focus on lifecycle convergence and the reused locator

- Service tests pin exactly two new event kinds and their transition edges.
- SSE tests cover company-scoped user observation, agent-key self isolation, cross-company fencing, subscriber-relative `canOpen`, bootstrap replay, live forwarding, reconnect convergence, and duplicate idempotence.
- Provider tests cover start/end token reduction, overlapping activities, direct-Idea grouping, stable ordering, and connection-detail joins.
- Navigation tests assert exact `sessionUuid` focus with optional agent+CWD pin, including mobile list-loading convergence and unpinned fallback, and assert zero navigation for other-user sessions.
- Tracker and graph tests cover zero/one/many sessions, propagation/hit-zone isolation, and final-end removal.

## Risks / Trade-offs

- **[Risk] Start/end events are duplicated by bootstrap and live delivery.** → Reducer state is keyed by `activityUuid`, so starts are idempotent and ends are safe.
- **[Risk] EventSource disconnect misses an end event.** → Reconnect replay rebuilds state from currently running turns instead of trusting stale client memory.
- **[Risk] The connection list has not resolved when activity arrives.** → Keep activity by stable connection UUID, render a temporary agent-only label, and join host/CWD when connections settle.
- **[Risk] Status visibility accidentally grants chat access to another user's session.** → Derive `canOpen` per subscriber from existing ownership, omit navigation for false entries, and test both server and UI enforcement.
- **[Risk] Canvas activity hit-testing conflicts with existing interactions.** → Reserve one small fixed region and test precedence: activity mark, expand affordance, card body.
- **[Risk] Animated marks become noisy.** → Animate only the compact mark and remove it immediately on the final end event.

## Migration Plan

This is additive and requires no data migration. Deploy the event producer and SSE forwarding with the frontend consumer. Older clients ignore unknown event types. Rollback removes the consumer and event forwarding without touching stored sessions or turns.

## Open Questions

None. The human explicitly selected existing agent+CWD navigation, frontend-derived activity, no database changes, and only session start/end SSE events.
