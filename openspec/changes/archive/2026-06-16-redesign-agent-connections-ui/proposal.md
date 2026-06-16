# Redesign the Agent Connections page into a master-detail observation deck

## Why

The Agent Connections page shipped (idea `f2fe9a7f`, PR #320) as a functionally-correct
but visually plain card grid. Three problems motivate a redesign:

1. **Identity is wrong.** Each card leads with the *client type* ("Claude Code",
   "OpenClaw"). But multiple connections can share a client type while belonging to
   different agents — the type alone cannot tell two Claude Code daemons apart. The
   thing a viewer actually needs to identify a connection is the **agent name**. The
   current read API does not even return the agent's display name, only `agentUuid`.
2. **It does not feel live.** Status is correct but static. For a page whose whole job
   is "is my daemon up right now", the absence of a pulsing online indicator and a
   ticking uptime makes it read like scaffolding, not an observation deck.
3. **No room to grow.** The flat grid has nowhere to put the parent idea's deferred
   capabilities (per-connection sessions, live transcript). A layout that can host them
   later avoids a second rewrite.

This change is the UI/identity slice. It is read-only over the existing registry and
adds **no** schema change and **no** new permission bit. The one backend touch is
additive: the read API joins and returns the agent's display name so the page can lead
with identity.

## What Changes

- **Read API — add `agentName`.** `GET /api/agent-connections` projects each
  connection's owning agent display name (joined from `Agent.name`) into the existing
  `ConnectionView`. No schema change (the column already exists); no new permission bit;
  same owner/self scoping.
- **Page — master-detail observation deck.** Replace the flat card grid with a
  two-pane master-detail layout: a left connection rail (online-first, each row a
  pulsing/static status dot + **agent name** primary + client type as a small badge +
  host + relative last-active) and a right detail panel for the selected connection
  (agent name + client-type badge + version·host subline + pulsing ONLINE / static
  offline badge + a stat block).
- **Identity inversion.** Agent name becomes the primary label everywhere; client type
  is demoted to a badge.
- **Live "alive" feel.** Online connections get a pulsing status dot and a monospace
  `HH:MM:SS` uptime that ticks every second. Offline connections render static and,
  consistent with the shipped uptime bug fix, show **no** uptime.
- **Coming-soon affordance.** The detail panel reserves an explicit "Sessions &
  Transcript — coming soon" placeholder zone, previewing the parent idea's deferred
  product direction without wiring real data.
- **Mobile.** A dedicated responsive experience: a single-column list of connection
  cards and a drill-down detail screen, both following the same identity-primary and
  live-uptime rules.
- **design.pen** updated with the desktop master-detail frame plus the two mobile
  frames; the legacy "Chorus - Daemons" frame and nav label retired in favor of
  "Agent Connections".

## Capabilities

- `agent-connection-observability` (MODIFIED page requirement + ADDED agent-name and
  responsive-layout requirements)

## Impact

- **API:** `src/app/api/agent-connections/route.ts` (unchanged shape; the service adds
  the field) and `src/services/daemon-connection.service.ts` (`ConnectionView` gains
  `agentName`; the list queries select the related agent's `name`).
- **UI:** `src/app/(dashboard)/agent-connections/page.tsx` rebuilt as master-detail with
  a responsive mobile path.
- **i18n:** new `agentConnections.*` keys in both `en` and `zh`.
- **No** Prisma schema change, **no** migration, **no** new permission bit, **no** change
  to SSE routes or the registry write path.

## Out of scope

- Live transcript ingest, per-connection `AgentSession` nesting, and connection
  management verbs (disconnect/delete) remain deferred to the parent idea's follow-on
  server work. This change only reserves visual space for them.
