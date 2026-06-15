# Proposal: Agent Connections observability (read API + page)

## Why

The `DaemonConnection` registry now exists and is fed by live data: the chorus
CLI daemon (`clientType=claude_code`) and the OpenClaw plugin
(`clientType=openclaw`) both self-report at SSE connect time, and the server
persists one row per connection with `status` / `lastSeenAt` liveness (shipped by
the parent change `add-daemon-connection-tracking`). That change was deliberately
**collection + liveness only** — it ships **no read API, no UI**.

So today the data is captured but **nobody can see it**. A user running the
daemon on their laptop has no way to confirm from Chorus that "my daemon is
connected and listening for dispatches", nor to notice that it silently went
offline. This change closes that consumption gap: an owner-scoped **Agent
Connections** page, backed by a small read API over the existing registry.

This change is the **observability slice** of idea `f2fe9a7f`. It does **not**
build live transcript ingest or per-connection session nesting — both depend on a
daemon-side stream-json upload protocol that does not exist yet (the parent
daemon only wakes Claude Code and writes back through existing `chorus_*` MCP
tools; `AgentSession` has no `connectionUuid` FK). Those, plus connection
management verbs (forced disconnect, history), are explicitly deferred to a
follow-on idea. What ships here is fully backed by data that exists today.

## What Changes

- **New read function on the registry service** —
  `src/services/daemon-connection.service.ts` gains `listConnectionsForOwner` (and
  a sibling for agent-key callers). It returns the caller's visible connections
  with a server-derived `effectiveStatus`. The service is currently
  write-only (`registerConnection` / `touchConnection` / `markDisconnected`); this
  adds the first read path.

- **Server-derived `effectiveStatus` is the single source of truth for liveness**
  — the read function computes
  `effectiveStatus = (status === "online" && now - lastSeenAt <= STALE_THRESHOLD_MS) ? "online" : "offline"`,
  reusing the already-exported `STALE_THRESHOLD_MS` (90s) constant. The client
  renders `effectiveStatus` verbatim and never re-implements the staleness rule.
  This honors the registry change's documented liveness contract — the consumer
  applies exactly the rule the producer specified.

- **New REST endpoint `GET /api/agent-connections`** — gated, agent-key callable
  **and** browser (user-cookie) callable, mirroring the just-merged root-idea
  resolution endpoint's "REST, agent-key callable" decision (this surface is
  **not** an MCP tool). Returns the visible connections as the API response
  envelope. No new MCP tool, no new permission bit.

- **Owner-scoped visibility, enforced server-side** — a **user** caller sees only
  connections whose agent is owned by that user (`agent.ownerUuid === user.uuid`),
  within their company. An **agent-key** caller sees only its own connections
  (`agentUuid === auth.actorUuid`) — an agent key has no "owner" to expand. This
  enforces the owner-scoped visibility requirement the parent change recorded as a
  binding contract, and narrows idea `f2fe9a7f`'s original "company-global view"
  wording to owner-scoped as the parent change's boundary note required.

- **New top-level page `/agent-connections`** — a global sidebar item labeled
  **"Agent Connections"** (zh: 智能体连接), peer to Projects and Settings, icon
  `RadioTower`. Per explicit product instruction the tab is **not** called
  "Daemons". The page lists the caller's connections as cards: client type +
  version, online/offline badge (from `effectiveStatus`), host, uptime
  (`connectedAt`), and last-active (`lastSeenAt`). It polls the read API on a ~15s
  interval to reflect online↔offline transitions; no new SSE event type is added
  (a 30s-per-connection touch would make SSE high-volume for marginal latency
  gain). An empty state explains how to start a daemon. All strings are i18n
  (`en` + `zh`).

- **Read-only this slice** — display + automatic liveness only. No manual
  disconnect/delete button: while a daemon is genuinely connected, its next 30s
  heartbeat touch flips any externally-set `offline` back to `online` (and the
  `connectedAt` fence means an external mark would not even stick against the live
  generation), so a "disconnect" button would be misleading. Management verbs are
  deferred with the transcript/session work.

## Capabilities

### New Capabilities

- `agent-connection-observability`: the owner-scoped read API
  (`GET /api/agent-connections`) over the `DaemonConnection` registry, the
  server-derived `effectiveStatus` liveness projection, and the Agent Connections
  observability page (nav item + polling list + empty state).

## Impact

- **Backend code**:
  - `src/services/daemon-connection.service.ts` — new read function(s) returning
    visible connections with `effectiveStatus`; reuses `STALE_THRESHOLD_MS`. No
    change to the existing write functions.
  - `src/app/api/agent-connections/route.ts` (new) — `GET` handler: resolve auth,
    branch user (owner-scoped) vs agent-key (self-scoped), call the service, return
    the standard response envelope via `withErrorHandler` + `success`/`errors.*`.

- **Frontend code**:
  - `src/app/(dashboard)/agent-connections/page.tsx` (new) — client component,
    polls `GET /api/agent-connections` every ~15s, renders connection cards with
    status badges, host, uptime, last-active, and an empty state.
  - `src/app/(dashboard)/layout.tsx` — add the `/agent-connections` item to
    `globalNavItems` with the `RadioTower` icon and `nav.agentConnections` label.
  - `messages/en.json` + `messages/zh.json` — add `nav.agentConnections` and an
    `agentConnections.*` namespace (title, subtitle, status labels, field labels,
    empty state, relative-time strings).

- **Design**: `docs/design.pen` already carries the reference frame for this page
  (drawn during planning). The implemented page follows that frame; the `.pen`
  is updated only if the implementation diverges.

- **No schema change** — the `DaemonConnection` model already exists. No
  migration. No `AgentSession` change (session nesting is deferred).

- **No new dependency, no new MCP tool, no new permission bit, no change to the
  auth path or the SSE routes.** The only new network surface is one additive REST
  GET endpoint.

- **Backward compat**: fully additive. Existing pages and the SSE registry write
  path are untouched.

## Out of scope (deferred to a follow-on idea)

- Live transcript ingest + render (needs an undefined daemon-side upload protocol).
- Per-connection `AgentSession` nesting (needs an `AgentSession.connectionUuid` FK
  and daemon-side session registration).
- Management verbs (forced disconnect with daemon-side teardown, history view).
- A background reaper that flips long-stale `online` rows to `offline`
  (`effectiveStatus` already covers the read correctly without it).
