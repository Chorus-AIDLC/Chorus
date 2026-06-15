# Technical Design: Daemon connection self-reporting + server-side registry

## Overview

Capture a small, self-reported metadata bundle for every long-lived daemon SSE
connection, and persist it in a DB-backed registry the server keeps alive and
reaps. The design has three moving parts:

1. **Wire contract** — clients append query params to the SSE URL.
2. **Persistence** — a `DaemonConnection` Prisma model + a thin service.
3. **Lifecycle + liveness** — the SSE route registers on connect, deregisters on
   `abort`, and bumps `lastSeenAt` from the heartbeat interval it already runs.

The guiding constraint is **minimal server-side surface, zero CLI heartbeat**.
The only genuinely new infrastructure is one table and one service; everything
else hangs off plumbing that already exists (the SSE route, its `request.signal`
abort, its 30s `setInterval`).

## Architecture

```
┌─────────────────────┐   GET /api/events/notifications        ┌────────────────────────┐
│ chorus CLI daemon   │   ?clientType=claude_code&...           │  SSE route handler     │
│ (cli/sse-listener)  │ ──────────────────────────────────────▶│  (per ECS instance)    │
└─────────────────────┘                                         │                        │
┌─────────────────────┐   GET /api/events/notifications         │  on connect → register │
│ OpenClaw plugin     │   ?clientType=openclaw&...               │  on abort   → mark off │
│ (sse-listener.ts)   │ ──────────────────────────────────────▶│  30s tick   → touch    │
└─────────────────────┘                                         └───────────┬────────────┘
                                                                            │
                                                          daemon-connection.service
                                                                            │
                                                                  ┌─────────▼─────────┐
                                                                  │  DaemonConnection │  (Postgres)
                                                                  │  status/lastSeenAt│  cross-instance
                                                                  └───────────────────┘
```

Because the table is in Postgres, a connection registered by the instance that
holds the socket is visible to a query served by the *other* ECS instance — which
is exactly what `f2fe9a7f`'s read API will need. An in-memory map could not do
this without a Redis broadcast layer; the DB gives cross-instance visibility and
durable history for free, at the cost of a few small writes per connection
(one on connect, one per 30s tick, one on disconnect).

## Data Model

New Prisma model. Mirrors `AgentSession`'s conventions: `Int` autoincrement PK +
`uuid` public id, `companyUuid` + application-level `company` relation,
`agentUuid` + cascade `agent` relation, indexed status/liveness columns.

```prisma
model DaemonConnection {
  id             Int       @id @default(autoincrement())
  uuid           String    @unique @default(uuid())
  companyUuid    String
  company        Company   @relation(fields: [companyUuid], references: [uuid])
  agentUuid      String
  agent          Agent     @relation(fields: [agentUuid], references: [uuid], onDelete: Cascade)

  clientType     String    // claude_code | openclaw | browser | other
  clientVersion  String?   // self-reported, untrusted, display-only
  host           String?   // self-reported hostname, display-only
  startedAt      DateTime? // self-reported daemon process start time

  status         String    @default("online")  // online | offline
  connectedAt    DateTime  @default(now())
  lastSeenAt     DateTime  @default(now())
  disconnectedAt DateTime?

  createdAt      DateTime  @default(now())
  updatedAt      DateTime  @updatedAt

  @@index([companyUuid])
  @@index([agentUuid])
  @@index([status])
  @@index([lastSeenAt])
}
```

Back-relations (`daemonConnections DaemonConnection[]`) are added to `Company`
and `Agent`, matching how `AgentSession` is wired. No FK to `AgentSession` —
that link is `f2fe9a7f`'s decision.

`clientType` is a free-form string (not a Prisma enum) to match the project's
existing pattern (`Document.type`, `AgentSession.status` are all strings) and to
avoid a migration when browser registration is added later. The allowed values
are enforced in the service, not the DB.

### Identity of a connection (upsert key)

A daemon may reconnect (SSE drops + backoff reconnect is built into both
listeners). We do **not** want a new row per reconnect of the same logical
daemon, nor do we want two daemons on two hosts to collide. The natural identity
is `(agentUuid, clientType, host)`:

- `registerConnection` upserts on `(agentUuid, clientType, host)`: if a row
  exists, flip it back to `online` and refresh `connectedAt`/`lastSeenAt`;
  else insert. This keeps reconnects idempotent and history compact.
- A `@@unique([agentUuid, clientType, host])` constraint backs the upsert. `host`
  is nullable; when null we treat it as the empty string for uniqueness so a
  host-less self-report still upserts deterministically.

> Tradeoff: keying on self-reported `host` means a spoofed/changed host yields a
> separate row. That is acceptable — the fields are display-only and untrusted by
> design, and a distinct host genuinely is a distinct connection for display.

## API Design

No new HTTP endpoint and no new MCP tool. The only contract change is the set of
**optional query params** accepted on the two existing SSE routes:

| Param | Meaning | Example |
|---|---|---|
| `clientType` | client kind | `claude_code`, `openclaw` |
| `clientVersion` | client semver | `0.11.0` |
| `host` | hostname | `mac-studio.local` |
| `startedAt` | process start, ISO-8601 | `2026-06-15T03:00:00.000Z` |

Auth is unchanged — Bearer (`cho_` key) for daemons, cookie for browser. These
params never feed authorization; they are read after `getAuthContext` succeeds
and used only to populate the registry row.

Registration is gated on `clientType` being a recognized **daemon** value
(`claude_code` | `openclaw`). `browser`, `other`, unknown, or absent → the route
runs exactly as today and writes no row.

## Module Contracts

`src/services/daemon-connection.service.ts` (all functions `companyUuid`-scoped,
all swallow-and-log on failure so SSE setup is never blocked by a registry write):

```ts
// Recognized daemon client types eligible for registration in this change.
export const DAEMON_CLIENT_TYPES = ["claude_code", "openclaw"] as const;

export interface SelfReport {
  clientType: string;          // raw query value
  clientVersion?: string | null;
  host?: string | null;
  startedAt?: Date | null;
}

// Upsert on (agentUuid, clientType, host). Returns the row uuid, or null when
// clientType is not a recognized daemon type (caller then skips lifecycle).
export async function registerConnection(
  companyUuid: string, agentUuid: string, report: SelfReport
): Promise<string | null>;

// abort → status=offline, disconnectedAt=now. No-op if uuid is null/absent.
export async function markDisconnected(
  companyUuid: string, connectionUuid: string
): Promise<void>;

// heartbeat tick → bump lastSeenAt (and ensure status=online). Cheap UPDATE.
export async function touchConnection(
  companyUuid: string, connectionUuid: string
): Promise<void>;
```

**Liveness contract (the rule `f2fe9a7f`'s reader MUST apply):** a connection is
*effectively online* iff `status === "online"` AND
`now - lastSeenAt <= STALE_THRESHOLD_MS`. The threshold is ~90s = 3× the 30s
heartbeat, tolerating one missed tick. This change exports the constant so the
future reader uses the same value; it does not itself read.

### SSE route wiring (both routes, same shape)

```
auth = getAuthContext(req)            // unchanged
report = parseSelfReport(req.nextUrl.searchParams)
connUuid = await registerConnection(auth.companyUuid, auth.actorUuid, report)  // null if not a daemon

start(controller):
  ...existing subscribe + ": connected" ...
  heartbeat = setInterval(() => {
    send(": heartbeat\n\n")
    if (connUuid) void touchConnection(auth.companyUuid, connUuid)   // NEW
  }, 30_000)
  req.signal.addEventListener("abort", () => {
    ...existing cleanup...
    if (connUuid) void markDisconnected(auth.companyUuid, connUuid)  // NEW
  })
```

All registry calls are fire-and-forget (`void` + internal try/catch) — a registry
write must never delay or break event delivery.

### Client self-report (both listeners, same shape)

`cli/sse-listener.mjs` and `packages/openclaw-plugin/src/sse-listener.ts` already
build `${url}/api/events/notifications`. Each appends a query string:

```js
const params = new URLSearchParams({
  clientType: "claude_code",            // "openclaw" in the plugin
  clientVersion: PKG_VERSION,           // from package.json / build constant
  host: os.hostname(),
  startedAt: processStart.toISOString(),
});
const endpoint = `${base}/api/events/notifications?${params}`;
```

The chorus CLI computes `clientVersion` from its own package version and
`startedAt` from a module-load timestamp; the OpenClaw plugin does the equivalent
in its TS runtime. Both keep their existing Bearer header and reconnect logic.

## Implementation Plan

1. **Schema + migration** — add `DaemonConnection` to `schema.prisma` (+
   back-relations), generate the migration via the Prisma CLI, run
   `prisma generate`.
2. **Service** — `daemon-connection.service.ts` with the three functions + the
   `DAEMON_CLIENT_TYPES` / `STALE_THRESHOLD_MS` constants + `parseSelfReport`.
3. **Route wiring** — add register/touch/disconnect to both SSE routes.
4. **Clients** — append query params in both listeners.

Tasks 1→2→3 are a chain (route needs the service needs the model). Task 4
(clients) depends only on the wire contract being fixed, but its acceptance
(rows actually appear) depends on 3, so it is ordered after 3 and serves as the
end-to-end integration checkpoint.

## Risks & Mitigations

- **Registry write latency on the hot connect path.** Mitigation: all service
  calls are fire-and-forget with internal try/catch; the stream is set up
  regardless. A failed registry write logs and is dropped, never surfaced to the
  client.
- **Row churn from reconnect storms.** Mitigation: upsert on
  `(agentUuid, clientType, host)` means a reconnect refreshes one row rather than
  inserting; `lastSeenAt` history is not retained per-tick (we overwrite).
- **Stale `online` rows after instance crash.** Mitigation: the
  `status==="online" && lastSeenAt fresh` read rule; the crashed instance's
  heartbeat interval stops, so `lastSeenAt` goes stale within ~90s. No sweeper job
  is required for correctness of the read; a background reaper that flips long-
  stale rows to `offline` is explicitly deferred to `f2fe9a7f` (it is a
  read-side nicety, not needed for collection).
- **Spoofed self-report.** Accepted by design — `clientVersion`/`host` are
  display-only and never authorize anything; auth remains Bearer/cookie.
- **Multi-tenancy.** Every service function is `companyUuid`-scoped and derives
  `companyUuid`/`agentUuid` from the authenticated context, never from the
  client-supplied params.
