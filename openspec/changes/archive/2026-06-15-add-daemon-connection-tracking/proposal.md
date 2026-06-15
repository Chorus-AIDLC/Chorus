# Proposal: Daemon connection self-reporting + server-side registry

## Why

Both the Chorus CLI daemon and the OpenClaw plugin hold a long-lived SSE
subscription to `/api/events/notifications` to receive task dispatches. The
browser dashboard holds the same kind of long-lived connection to `/api/events`.
Today the server is **blind** to these connections: both SSE routes parse only
the auth identity (`${auth.type}:${auth.actorUuid}`) and register nothing. There
is no connection registry anywhere in the codebase (grep-confirmed).

Concretely, the server cannot answer any of:

- Which client is on the other end — chorus CLI (Claude Code), OpenClaw plugin,
  browser, or something else?
- What version is it, what host is it running on, when did it connect, is it
  still alive?
- The same agent may hold several connections — they are indistinguishable.

This is the **data-collection gap**. A future "Daemons" observability UI (derived
idea `f2fe9a7f`) cannot list active connections because that information has
never been captured. This change closes the gap: connections **self-report** a
small metadata bundle at connect time, and the server **persists** them in a
registry it can keep alive and reap.

This change is deliberately the **collection + liveness layer only**. It does
**not** build a read API, a UI, or any link to `AgentSession`. Those belong to
`f2fe9a7f` (the consumption/observability layer), which builds on the registry
this change lands.

## What Changes

- **New Prisma model `DaemonConnection`** — persists one row per registered SSE
  connection: `companyUuid`, `agentUuid`, `clientType` (enum-like string:
  `claude_code` | `openclaw` | `browser` | `other`), `clientVersion`, `host`,
  `startedAt` (process start, self-reported), `connectedAt`, `lastSeenAt`,
  `status` (`online` | `offline`), `disconnectedAt`. This is a real DB table
  (one new migration) so the registry is **durable and cross-instance visible** —
  production runs 2 ECS tasks behind an ALB, so an in-memory map on the instance
  holding the socket would be invisible to a query that lands on the other
  instance.

- **SSE connections self-report via query params** — clients append
  `?clientType=…&clientVersion=…&host=…&startedAt=…` to the SSE URL. Query
  params (not headers) are the single contract because a future browser
  `EventSource` can only set query params, never custom headers; daemon and
  browser thus share one path. The auth mechanism is unchanged (Bearer / cookie);
  these params are **display-only metadata and never participate in
  authorization** — they are client-supplied and therefore untrusted.

- **Registry scope = daemon clients only, table reserves `clientType` for
  browser** — only connections that self-report a machine `clientType`
  (`claude_code`, `openclaw`) are registered in this change. The `browser` and
  `other` enum values exist in the column so browser registration can be added
  later **without a migration**, but browser SSE connections are not registered
  now (they are high-churn and overlap the existing presence system).

- **Connection lifecycle on the SSE route** — on connect with a daemon
  `clientType`, the route registers (upsert) a `DaemonConnection` row as `online`
  with `connectedAt`/`lastSeenAt = now`. On the stream's `abort` event (graceful
  disconnect: process exit, Ctrl-C, network close) the route marks the row
  `offline` with `disconnectedAt = now`. **Primary liveness signal = `abort`.**

- **Liveness safety net via the existing 30s heartbeat interval** — the SSE
  routes already run `setInterval(…, 30_000)` to push keep-alive comments. This
  change has that same interval also bump `lastSeenAt`. The interval dies with
  the instance process, so if an instance hard-crashes (OOM, kill, deploy roll)
  and its `abort` never fires, `lastSeenAt` simply stops advancing. A reader then
  treats `status === "online" && lastSeenAt` older than a staleness threshold
  (~90s) as effectively offline. **No CLI heartbeat is added** — SSE is
  one-way and the daemon sends nothing after connect; the server-side interval is
  the entire liveness mechanism.

- **Both real clients self-report** — `cli/sse-listener.mjs` appends
  `clientType=claude_code` (the CLI only drives Claude Code today, so it is not a
  generic "daemon"); `packages/openclaw-plugin/src/sse-listener.ts` appends
  `clientType=openclaw`. Both already use `fetch` against the same endpoint, so
  this is a URL-construction change on each.

- **Wire the reserved `onConnect` upload hook** — the daemon already defines a
  no-op `onConnect({host, agentUuid})` hook (`cli/upload-hooks.mjs`) reserved for
  this work. This change may use that hook point as the place the daemon computes
  its self-report bundle, keeping the wake path untouched. The hook still
  performs no *upload* — registration happens server-side from the query params.

- **Visibility is owner-scoped (contract only, enforced when the read API
  lands)** — a connection's self-reported metadata (`host`, `clientVersion`) is
  mildly sensitive. The spec fixes the rule now — only the owning agent's owner
  may see a connection — so `f2fe9a7f`'s read API and UI inherit it. This change
  ships no read endpoint, so there is nothing to enforce yet, but the requirement
  is recorded to bind the consumer.

## Capabilities

### New Capabilities

- `daemon-connection-registry`: the server-side `DaemonConnection` model, the
  register/deregister lifecycle on the SSE route, heartbeat-driven liveness with
  the abort-primary + staleness-safety-net model, and the owner-scoped visibility
  contract for downstream consumers.

### Modified Capabilities

- `cli-daemon`: the chorus CLI daemon's SSE subscription SHALL append the
  self-report query params (`clientType=claude_code`, version, host, startedAt)
  when opening the notification stream.
- `openclaw-event-bridge`: the OpenClaw plugin's SSE notification listener SHALL
  append the same self-report query params with `clientType=openclaw`.

## Impact

- **Schema**: one new migration adding the `DaemonConnection` model. Per project
  convention, the schema is edited and the migration generated via the Prisma CLI
  (no hand-written SQL, DDL-only). `relationMode = "prisma"` — the `agent` /
  `company` relations are application-level, matching `AgentSession`.

- **Backend code**:
  - `prisma/schema.prisma` — new `DaemonConnection` model + back-relations on
    `Company` and `Agent`.
  - `src/services/daemon-connection.service.ts` (new) — `registerConnection`,
    `markDisconnected`, `touchConnection` (bump `lastSeenAt`), all
    `companyUuid`-scoped. Pure persistence; no read/query API in this change.
  - `src/app/api/events/notifications/route.ts` and `src/app/api/events/route.ts`
    — parse the self-report query params, call the service on connect / abort,
    and bump `lastSeenAt` from the existing 30s interval. Registration is gated
    on a recognized daemon `clientType`; absent/browser/unknown → no row written
    in this change.

- **Client code**:
  - `cli/sse-listener.mjs` — append query params to the endpoint URL;
    `clientType=claude_code`, `clientVersion` from the CLI package version, `host`
    from `os.hostname()`, `startedAt` from process start.
  - `packages/openclaw-plugin/src/sse-listener.ts` — same, `clientType=openclaw`.
  - `cli/upload-hooks.mjs` — `onConnect` may compute/carry the bundle; remains a
    no-op for *upload*.

- **No UI** — the Daemons sidebar page, per-connection session view, and
  transcript panel are all out of scope (they are `f2fe9a7f`). No `design.pen`
  change, because this change adds no user-facing screen.

- **No `AgentSession` change** — no `connectionUuid` FK is added. How a
  daemon-woken Claude session relates to a connection is `f2fe9a7f`'s core design
  question; adding the FK now would prejudge it.

- **Runtime**: no new dependency, no new MCP tool, no new permission, no change to
  the auth path. The only new network surface is the optional query params on an
  existing endpoint.

- **Backward compat**: fully additive. A client that does not self-report (older
  daemon, browser) connects exactly as before and simply is not registered.

## Boundary notes for `f2fe9a7f` (recorded so the consumer inherits them)

1. **`DaemonConnection` modeling moves here.** `f2fe9a7f`'s notes tentatively
   claimed the `DaemonConnection` table; this change absorbs it. `f2fe9a7f`
   retains the read API, the Daemons UI, the per-connection session view, and the
   transcript panel.
2. **Visibility narrows to owner-scoped.** `f2fe9a7f`'s "all connections of the
   company" global-view wording must narrow to owner-scoped to match the
   visibility requirement here, or `f2fe9a7f` must explicitly re-open that
   decision.
