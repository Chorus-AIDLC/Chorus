# Technical Design: Agent Connections UI Redesign

## Overview

Two layers change, in dependency order:

1. **Service/API (small, additive):** `ConnectionView` gains an `agentName` field; the
   two list queries join the related `Agent.name`. The route handler is untouched —
   it already passes the service result through verbatim.
2. **Page (the bulk):** `page.tsx` is rebuilt from a flat card grid into a responsive
   master-detail observation deck, leading with agent name, with a live ticking uptime
   for online connections and a coming-soon placeholder.

No schema change, no migration, no new permission bit, no SSE/registry-write changes.

## Data Model

No Prisma change. `DaemonConnection.agentUuid` already references `Agent`, and
`Agent.name` already exists. The redesign only *reads* the name.

## API Design

`GET /api/agent-connections` — response shape extends, does not break:

```jsonc
{
  "success": true,
  "data": {
    "connections": [
      {
        "uuid": "...",
        "agentUuid": "...",
        "agentName": "Admin Claude",   // NEW — null if the agent row is missing
        "clientType": "claude_code",
        "clientVersion": "0.11.0",
        "host": "laptop-01",
        "startedAt": "...|null",
        "status": "online",
        "effectiveStatus": "online",   // unchanged: derived via STALE_THRESHOLD_MS
        "connectedAt": "...",
        "lastSeenAt": "...",
        "disconnectedAt": "...|null"
      }
    ]
  }
}
```

`agentName` is additive — existing consumers ignoring it are unaffected. The field is
nullable to tolerate a connection whose agent row was deleted (defensive; should not
happen under cascade rules, but the projection must not throw).

## Module Contracts

### `src/services/daemon-connection.service.ts`

- `interface ConnectionView` gains `agentName: string | null`.
- Both `listConnectionsForOwner` and `listConnectionsForAgent` already `findMany` over
  `DaemonConnection`; add the related agent name to the selection. Two options, pick the
  one matching the existing query style:
  - **Prisma `include`/`select`:** `include: { agent: { select: { name: true } } }` (the
    owner query already filters on `agent: { ownerUuid }`, so the relation is present),
    then map `row.agent?.name ?? null` in `toConnectionView`.
  - If the existing code uses a flat `select`, extend it with the relation select.
- `toConnectionView(row)` maps the joined name into the view. The existing
  `effectiveStatus` derivation (reusing the exported `STALE_THRESHOLD_MS`) and
  `sortConnectionViews` ordering are unchanged.
- Read functions keep propagating errors (no swallow-and-return-`[]`).

### `src/app/api/agent-connections/route.ts`

Unchanged. Already: `getAuthContext` → 401 if absent → branch agent-self vs owner →
`success({ connections })`. The new field flows through automatically.

## UI Design

### Desktop — master-detail (`lg+`)

- Page header: title "Agent Connections" + a summary pill ("N / M online") with a pulsing
  green halo dot; subtitle.
- Body: two panes side by side.
  - **Connection rail (left, fixed ~340px):** header ("CONNECTIONS" + count), then
    online-first rows. Each row: status dot (pulsing green halo when online, static grey
    when offline) · agent name (primary, 14px semibold) · client-type badge + `· host`
    monospace subline · relative last-active (green when online). Selected row carries a
    terracotta (`#C67A52`) left accent bar and a warm tint (`#FBF4EF`).
  - **Detail panel (right, fills):** header — bot icon tile, agent name (18px), client-type
    badge, `vX · host` monospace subline, and a status badge (pulsing `ONLINE` on
    `#DCFCE7`/`#15803D`, static `offline` on grey). Divider. Stat grid (2×2): **Uptime**
    (monospace `HH:MM:SS`, large, **online-only**), **Last active**, **Started**, **Host**.
    Bottom: "Sessions & Transcript — coming soon" placeholder with ghost lines.

### Mobile — list + drill-down (`< md`)

- **List screen:** stacked full-width connection cards. Each card: bot/clock icon tile,
  agent name primary, client-type badge + `· host`, a status badge, and a two-stat footer
  (Uptime online-only / Last active). Tapping a card navigates to the detail screen.
- **Detail screen:** back nav ("Connections"), the identity block (icon, agent name,
  badge, version·host, status badge), the stat tiles (Uptime online-only, Last active,
  Started), and the coming-soon placeholder.

Responsive strategy in React: a single page component that renders the master-detail two
pane on `lg+` and, on small screens, the rail-as-list with the detail behind a selection
(client state `selectedUuid`); Tailwind breakpoints switch between the two compositions.
No separate route is required — selection is client state.

### Live behavior

- **Uptime ticking:** a 1s interval recomputes `now - connectedAt` formatted as
  `HH:MM:SS`, **only for connections whose `effectiveStatus === "online"`**. Offline
  connections never render an uptime row (carries forward the shipped bug fix). The
  existing 15s poll of `GET /api/agent-connections` continues to refresh the dataset and
  flip online↔offline.
- **Pulsing dot:** CSS/Tailwind animation on the online status dot's halo; offline dots are
  static. Respect `prefers-reduced-motion` by degrading the pulse to a solid dot.

### i18n

All strings localized in `en` + `zh`: nav label, page title/subtitle, rail header, status
labels, stat labels (Uptime/Last active/Started/Host), uptime/relative-time formatters,
client-type labels, coming-soon copy, empty state. Reuse the shared `time.*` namespace for
relative time; keep `agentConnections.*` for the rest.

## Implementation Plan

1. **Task 1 — Read API `agentName`.** Extend `ConnectionView` + both list queries +
   `toConnectionView`; update the service + route tests for the new field. Pure additive.
2. **Task 2 — Page redesign + mobile + i18n + design.pen sync.** Rebuild `page.tsx` as the
   responsive master-detail deck consuming `agentName`, ticking uptime online-only, pulsing
   dot, coming-soon placeholder; add/adjust i18n keys in both locales; reflect the new
   frames in `design.pen` and retire the "Daemons" naming.

Task 2 depends on Task 1 (the page leads with `agentName`, which Task 1 supplies).

## Risks & Mitigations

- **`agentName` null:** agent row missing → render a localized "Unknown agent" fallback;
  projection returns `null`, never throws.
- **Interval leak:** the 1s uptime ticker and 15s poll must both clear on unmount — use
  `useEffect` cleanup; verify no double-interval on re-render.
- **Reduced motion:** gate the pulse animation behind `motion-safe:` so it degrades to a
  static dot.
- **Mobile/desktop divergence:** keep one data layer and one set of formatters; only the
  composition differs by breakpoint, so the uptime/identity rules cannot drift between
  views.
- **design.pen is encrypted:** edit only via Pencil MCP (already done for the mock); never
  Read/Grep the `.pen` file.
