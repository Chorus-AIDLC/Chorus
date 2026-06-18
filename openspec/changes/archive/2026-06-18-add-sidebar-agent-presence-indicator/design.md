# Design — Sidebar Online-Agent Presence Indicator

## Context

Three facts from the codebase shape this design:

1. **The sidebar renders outside any `RealtimeProvider`.** `RealtimeProvider` is
   mounted per-`<main>`, scoped by `projectUuid`, and remounts on navigation;
   `/settings` mounts none. The pill must therefore have its **own** self-contained
   data spine that wraps the whole dashboard shell and survives route changes.
2. **Execution state already streams to the browser.** The `/api/events` SSE route
   already subscribes each browser to every visible connection's
   `execution:{connectionUuid}` channel. Live increments are free; only the
   first-paint aggregate is missing.
3. **`getVisibleExecutions(auth)` already exists** in
   `daemon-execution.service.ts` (owner-scoped, enriched with titles + session
   labels) but is exposed by no route. The new endpoint is a thin wrapper.

This is not greenfield UI. The brief is to **extend an existing visual identity** —
the Agent Connections page's warm Chorus system — not to invent a new look. The
page already speaks a clear vocabulary: agent name as the primary label, client
type as a secondary badge, a pulsing green dot for online, monospace HH:MM:SS
uptime/elapsed, `Bot` tile for online / `Clock` tile for offline. We reuse that
vocabulary verbatim so the popover and modal read as the same product, relocated.

## Design direction

**Signature:** *your agents are alive in the chrome.* The single memorable move is
lifting the live pulsing presence dot out of a buried page and into the permanent
shell — a quiet "heartbeat" that sits just above your name and answers "is anyone
home?" at a glance, from any page. Everything else stays disciplined and quiet; the
boldness is spent only on that one resident pulse.

**Palette — reuse, do not invent.** Bind to the existing Chorus tokens already in
the design system; introduce no new hues.

- Surface `#FAF8F4` (warm cream), card `#FFFFFF`, ink `#2C2C2C`, accent terracotta
  `#C67A52`, hairline borders via the existing `border` token.
- Online pulse: the page's existing green (a single live-status green) — the only
  saturated color in the pill. Offline/idle: the muted grey dot already used.
- Used with restraint: the pill is mostly ink-on-cream; green appears only as the
  ~6px dot. No gradients, no second accent.

**Type — match the shell.** No new typefaces. The pill uses the sidebar's
`text-[11px]`/`text-[13px]` scale (matching the profile block it sits above); the
count is the only emphasized glyph (medium weight). Elapsed timers reuse the page's
monospace treatment so digits don't jitter as they tick.

**Layout concept.** The pill is a single quiet row that mirrors the rhythm of the
nav items above it and the profile block below it — it must feel like it was always
part of the rail, not bolted on. The popover is a compact "control-room strip":
a narrow column of online connections, each a two-line identity header with its
executions nested beneath as dense rows.

```
SIDEBAR (above profile)            POPOVER (click)                    MODAL ("View all")
┌──────────────────────┐          ┌───────────────────────────┐     ┌──────────────────────────────────────┐
│  ◉ nav: Overview     │          │  AGENTS ONLINE        2    │     │  Agent Connections            [x]      │
│  ◌ nav: Documents    │          ├───────────────────────────┤     ├───────────┬──────────────────────────┤
│  ◌ nav: Tasks        │          │ ● Admin Claude  [CC]       │     │ ● Claude  │  Admin Claude    ONLINE  │
│  …                   │          │   ↳ Idea: Daemon model     │     │ ● Worker  │  [Claude Code] · host    │
│ ┌──────────────────┐ │          │   ▸ run  Build pill  01:12 │     │   Worker  │  Uptime 02:14:55         │
│ │ ● 2 online    ▸  │◀─pill      │   ▸ queue Wire popover     │     │           │  ── Execution ──         │
│ └──────────────────┘ │          │ ● Worker Bee   [OpenClaw]  │     │           │  ▸ run  …    [interrupt] │
│ ┌──────────────────┐ │          │   ▸ run  Spec sweep  00:08 │     │           │  ▸ queue …               │
│ │ (A) Yifei  ⏻      │ │          ├───────────────────────────┤     └───────────┴──────────────────────────┘
│ └──────────────────┘ │          │  View all              →   │
└──────────────────────┘          └───────────────────────────┘
```

**Motion, deliberate and singular.** One orchestrated element: the online dot's
`ping` halo (the page's existing `motion-safe:animate-ping`). Elapsed timers tick
(text, not animation). The popover uses the shadcn default open transition. Nothing
else animates. All motion is gated on `motion-safe:` so reduced-motion users get a
static dot. Restraint here is the point — extra motion would read as AI-generated
filler and undercut the one signature pulse.

## Architecture

### Data spine: `AgentPresenceProvider`

A new client provider mounted **once** in `DashboardLayout`, wrapping the whole
shell (sidebar + main), independent of the page-scoped `RealtimeProvider`. It owns:

- **Connections + online count** — polls `GET /api/agent-connections` every 15s
  (same cadence/source as the page today). Online count =
  `connections.filter(c => c.effectiveStatus === "online").length`.
- **Execution first paint** — fetches `GET /api/daemon/executions` once on mount
  (and on reconnect) for the aggregate running/queued set across all connections.
- **Execution live updates** — opens its own company-wide `EventSource("/api/events")`
  (no `projectUuid`) and merges `type === "execution"` events by `connectionUuid`
  into its execution map. This is a second, long-lived SSE connection distinct from
  the page-scoped one; it must be opened once at the shell level and closed on
  unmount, with the same visibility-reconnect handling the existing context uses.
- **Status surface** — exposes `{ status: "loading" | "ok" | "error", connections,
  onlineCount, executionsByConnection }` so the pill can render three distinct
  states. A failed poll sets `status: "error"` and does **not** zero the count
  (no silent error; failure ≠ "0 online").

Consumers: the pill (`useAgentPresence()`), the popover, and the modal all read from
this one provider — single poll, single SSE, zero duplicate requests (the
elaboration's chosen "shared hook/Context at layout layer").

> Implementation note: the provider must not depend on `RealtimeContext` (the
> sidebar is outside it). It either inlines its own EventSource or reuses the
> existing context's connection logic refactored to be mountable at the shell.
> Verify against `realtime-context.tsx` that opening a second `/api/events`
> EventSource at the shell does not conflict with the page-scoped one (they are
> independent browser EventSource instances; the server fans out per auth).

### New endpoint: `GET /api/daemon/executions`

```
GET /api/daemon/executions
  -> { success: true, data: { executions: ExecutionView[] } }
```

Handler: resolve `getAuthContext`, 401 if absent, return
`getVisibleExecutions(auth)`. Owner-scoped (users see their owned agents' executions;
agent keys see their own), `companyUuid`-scoped — identical visibility to
`GET /api/agent-connections` and the per-connection `execution-state` endpoint. No
new permission bit. Reuses `withErrorHandler` + the standard envelope. ~20 lines.

### Pill component

`<AgentPresencePill />` rendered in `SidebarContent` between the nav `</nav>` and the
`{/* User Profile */}` block (layout.tsx:436), in both desktop rail and mobile
drawer (the `mobile` prop tunes sizing as the profile block does). Wraps a shadcn
`PopoverTrigger`. Three states:

- `loading` — muted pill, dimmed dot, no count flash.
- `error` — distinguished unavailable state (e.g. "—" / localized "Agents
  unavailable"), never "0 online".
- `ok` — "{n} online" with pulsing green dot when `n > 0`; static grey dot + "0
  online" when `n === 0` (stays visible — never disappears).

### Popover content

`PopoverContent` (`side="top"`/`align="start"`, width within rail constraints).
Lists **online** connections only; under each, its `running` then `queued`
executions from `executionsByConnection`. Reuses the page's `IdentityBlock` /
`StatusDot` / client-type badge / monospace elapsed by extracting them into a shared
module so the popover, modal, and (former) page render identically. Task rows
deep-link to the entity. Footer button opens the modal. Empty/edge: if online but no
executions, show a quiet "idle" line, not a blank.

### Modal ("View all") + page removal

The current `agent-connections/page.tsx` body is refactored into
`<AgentConnectionsView />` (presentational, reads from `AgentPresenceProvider`
instead of its own poll). It is hosted in a shadcn `Dialog` opened from the popover
footer. Full parity: master-detail list, execution state, interrupt/resume controls
(子3). The route `src/app/(dashboard)/agent-connections/` is deleted and the
`RadioTower` nav item removed from `globalNavItems`; a middleware/route redirect from
`/agent-connections` preserves bookmarks (to the dashboard, or auto-opening the
modal — decided at implementation).

## Shared rendering module

Extract from `agent-connections/page.tsx` into a shared module (e.g.
`src/components/agent-presence/`): `IdentityBlock`, `StatusDot`, `StatusBadge`,
client-type label hook, `useRelativeTime`, `useUptimeMono`, and the execution-row
renderer. This is the linchpin that keeps pill-popover-modal visually identical and
avoids a second, drifting copy of the vocabulary.

## Risks & mitigations

- **Second SSE connection at the shell.** Risk: two `/api/events` EventSources
  (shell + page) per tab. Mitigation: the page no longer exists as a route, so its
  own EventSource goes away; the project pages keep their scoped one for entity
  events. Net per-tab SSE count is unchanged or lower. Verify no server-side
  per-auth connection cap is exceeded.
- **Provider mounted globally → polling on every page.** Intended (that is the
  feature). 15s poll of a small owner-scoped list is cheap; matches today's page.
- **Capability walk-back.** Relocating the just-shipped page redesign + interrupt
  controls into a modal is intentional (owner-confirmed). Mitigation: parity is a
  hard requirement — the modal hosts the same component, controls included.
- **Reduced motion.** All pulse/halo gated `motion-safe:`; static dot otherwise.
- **i18n.** Every string (pill states, popover headers, "View all", modal title,
  empty/idle/error) keyed in both `en` and `zh`, reusing the existing
  `agentConnections.*` and `time.*` namespaces where possible.
- **Hallucination guard.** Implementers SHALL verify shadcn `Popover`/`Dialog` APIs
  and the `ConnectionView`/`ExecutionView` field names against the actual source
  files rather than memory.
