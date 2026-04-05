# Chorus Presence System — Design Document

This document explains the architecture and design logic of Chorus's real-time agent presence system. Presence answers the question: **"Which agents are looking at or working on what, right now?"**

## Overview

Chorus presence is a fire-and-forget, event-driven system that automatically detects agent activity from MCP tool invocations and broadcasts it to all connected frontends in real time. No explicit "presence API" is needed — agents gain presence simply by using Chorus tools.

The system is designed around three properties:

1. **Zero-effort for agents** — Presence is inferred, not declared. Agents never call a "set presence" endpoint.
2. **Ephemeral by nature** — Presence indicators auto-expire within seconds. There is no persistent "online" state to manage.
3. **Non-blocking** — Presence emission is async and never delays the tool execution that triggered it.

## Architecture Layers

```
┌─────────────────────────────────────────────────────────────┐
│  MCP Tool Call                                              │
│  (e.g., chorus_get_task { taskUuid: "..." })                │
├─────────────────────────────────────────────────────────────┤
│  Presence Wrapper (src/mcp/tools/presence.ts)               │
│  ├─ Classifies action: "view" vs "mutate"                   │
│  ├─ Extracts resource: entityType + entityUuid              │
│  ├─ Resolves projectUuid (cached per session)               │
│  └─ Emits PresenceEvent (fire-and-forget)                   │
├─────────────────────────────────────────────────────────────┤
│  Event Bus (src/lib/event-bus.ts)                           │
│  ├─ Server-side throttle: 2s per agent+entity               │
│  ├─ Local EventEmitter for single-instance                  │
│  └─ Redis Pub/Sub for multi-instance (optional)             │
├─────────────────────────────────────────────────────────────┤
│  SSE Endpoint (GET /api/events?projectUuid=...)             │
│  ├─ Streams presence + change events                        │
│  └─ 30s heartbeat to keep connection alive                  │
├─────────────────────────────────────────────────────────────┤
│  Frontend (RealtimeProvider → usePresence → UI)             │
│  ├─ 3s auto-clear per agent+entity                          │
│  ├─ useSyncExternalStore for React state                    │
│  └─ PresenceIndicator renders colored borders + badges      │
└─────────────────────────────────────────────────────────────┘
```

## Key Components

### 1. Automatic Detection — Presence Wrapper

**File:** `src/mcp/tools/presence.ts`

The `enablePresence()` function wraps every MCP tool handler. When a tool is called, the wrapper:

- **Classifies the action** based on tool name prefix:
  - `chorus_get_*`, `chorus_list_*`, `chorus_search*` → `"view"`
  - Everything else → `"mutate"`
- **Extracts the target resource** from tool parameters:
  - Direct UUID fields: `taskUuid`, `ideaUuid`, `proposalUuid`, `documentUuid`
  - Polymorphic fields: `targetUuid` + `targetType`
  - Sub-entity support: e.g., `draftUuid` within a proposal
- **Resolves the projectUuid** via database lookup (cached per MCP session to avoid repeated queries)
- **Emits a `PresenceEvent`** asynchronously without awaiting the result

This design means any new MCP tool automatically participates in presence as long as it follows the standard parameter naming conventions.

### 2. Event Transport — Event Bus

**File:** `src/lib/event-bus.ts`

The `PresenceEvent` type:

```typescript
interface PresenceEvent {
  companyUuid: string;
  projectUuid: string;
  entityType: "task" | "idea" | "proposal" | "document";
  entityUuid: string;
  subEntityType?: string;   // e.g., "draft", "comment"
  subEntityUuid?: string;
  agentUuid: string;
  agentName: string;
  action: "view" | "mutate";
  timestamp: number;
}
```

**Throttling:** The event bus deduplicates presence events using a 2-second sliding window keyed by `agentUuid + entityUuid`. Throttle entries auto-evict after 30 seconds. This prevents an agent rapidly reading the same task from flooding the event stream.

**Transport modes:**
- **Single-instance:** Local `EventEmitter` — events stay in-process.
- **Multi-instance (production):** Redis Pub/Sub on the `chorus:events` channel. Each instance subscribes and re-broadcasts locally. Origin-based deduplication prevents echo loops.

### 3. Real-Time Delivery — SSE

**File:** `src/app/api/events/route.ts`

The SSE endpoint streams two event types to browsers:
- `change` — Entity CRUD notifications (triggers data refetch)
- `presence` — Agent activity indicators

Events are filtered by `companyUuid` (multi-tenancy) and optionally by `projectUuid`. A `:heartbeat` comment is sent every 30 seconds to keep the connection alive through proxies and load balancers.

### 4. Frontend State — usePresence Hook

**File:** `src/hooks/use-presence.ts`

The hook maintains a module-level presence map (shared across all component instances) with:
- **3-second auto-clear:** Each presence entry expires 3 seconds after the last event, causing the indicator to fade.
- **Deduplication:** Events from the same agent for the same entity within the 3-second window reset the timer rather than creating duplicates.
- **React sync:** Uses `useSyncExternalStore` for tear-free rendering — all components observing the same entity see the same state.

### 5. Visual Rendering — PresenceIndicator

**File:** `src/components/ui/presence-indicator.tsx`

Wraps any entity card or panel. When agents are present:
- **Colored border:** Solid for `"mutate"`, dashed for `"view"`. Color is deterministic per agent (hash of agent name into a 12-color palette).
- **Agent badges:** Up to 3 agent name badges with a robot icon. Overflow shows `"+N"`.
- **`badgeInside` mode:** For containers with `overflow-hidden`, badges render inside rather than above the border.

### 6. Agent Color Assignment

**File:** `src/lib/agent-color.ts`

A 12-color palette is assigned deterministically by hashing the agent name. This ensures the same agent always appears in the same color across all views and sessions, making it easy for humans to visually track a specific agent's activity.

## Usage Across the UI

Presence indicators appear on:

| Surface | Entity Type | File |
|---------|-------------|------|
| Kanban board | Task cards | `projects/[uuid]/tasks/kanban-board.tsx` |
| Proposal editor | Proposal + drafts | `proposals/[proposalUuid]/proposal-editor.tsx` |
| Discussion drawer | Comments | `proposals/[proposalUuid]/discussion-drawer.tsx` |
| Ideas list | Idea cards | Ideas components |
| Proposal kanban | Proposal cards | Proposal components |
| Document grid | Document cards | Document components |

## Relationship to Sessions

Presence and Sessions are complementary but distinct:

| Aspect | Presence | Sessions |
|--------|----------|----------|
| Granularity | Per-entity, per-tool-call | Per-agent, per-work-unit |
| Lifetime | ~3 seconds (ephemeral) | Hours to days (persistent) |
| Purpose | "Agent X is looking at Task Y right now" | "Agent X is working on Tasks Y, Z this session" |
| Data source | MCP tool parameters (automatic) | Explicit create/checkin/checkout/close |
| Storage | In-memory only (event bus + frontend map) | Database (AgentSession + SessionTaskCheckin) |

Sessions answer "who is assigned to what work?" — presence answers "what is happening right now?"

### PixelCanvas Visualization

**Files:** `src/components/pixel-canvas.tsx`, `src/components/pixel-canvas-widget.tsx`

A project-level visualization showing up to 7 active workers as animated pixel-art sprites. It combines both data sources:
- Session-based workers (agents with active sessions and task checkins)
- Sessionless agents (main agents with in_progress task assignments)

Sprite states (`empty`, `idle`, `typing`, `celebrate`, `looking`) are driven by SSE events, providing a playful real-time view of project activity.

## Design Decisions

### Why infer presence from tool calls?

Requiring agents to explicitly declare presence would add friction and risk inconsistency (agents forgetting to update). By intercepting MCP tool calls — which agents already make to do their work — presence becomes a side effect of normal operation. This follows the principle of making the right thing the easy thing.

### Why ephemeral (3-second) indicators?

Long-lived "online" indicators require explicit disconnect handling, heartbeats, and timeout logic. Ephemeral indicators are self-healing: if an agent crashes, its presence simply fades in 3 seconds. No cleanup needed.

### Why two throttle layers?

Server-side throttling (2s) prevents an agent in a tight loop from generating thousands of events per minute. Frontend throttling (3s) prevents a burst of events from causing excessive React re-renders. Together they provide smooth, low-overhead visualization.

### Why fire-and-forget?

Presence is advisory, not transactional. A dropped presence event has zero impact on correctness — the worst case is a briefly missing indicator. Making presence async ensures it never adds latency to the agent's actual work.

## Testing

- **Event bus:** `src/lib/__tests__/event-bus.test.ts` — throttling, eviction, Redis dedup
- **Presence wrapper:** `src/mcp/__tests__/presence.test.ts` — action classification, resource detection, caching
- **Session service:** `src/services/__tests__/session.service.test.ts` — lifecycle, checkin/checkout, inactive marking
