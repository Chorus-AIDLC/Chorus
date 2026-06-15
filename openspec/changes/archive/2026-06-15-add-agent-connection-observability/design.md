# Technical Design: Agent Connections observability

## Overview

Expose the existing `DaemonConnection` registry through a thin, owner-scoped read
path and render it as a live page. Three moving parts, all additive:

1. **Read projection** — a service function that queries the registry scoped to
   the caller and projects each row to a DTO carrying a server-derived
   `effectiveStatus`.
2. **REST endpoint** — `GET /api/agent-connections`, agent-key + cookie callable,
   that branches the scope by auth type and returns the projection.
3. **Page** — a polling client component + a new global nav item.

The guiding constraint is **reuse, don't re-derive**: the liveness rule
(`STALE_THRESHOLD_MS`) already lives in the service from the parent change; this
change consumes that constant rather than restating it, so producer and consumer
can never drift.

## Architecture

```
┌────────────────────────┐  GET /api/agent-connections     ┌─────────────────────────┐
│ Agent Connections page │ ───── poll every ~15s ─────────▶│  route handler          │
│ (client component)     │                                 │  - getAuthContext       │
└────────────────────────┘                                 │  - user → owner-scoped  │
            ▲                                               │  - agent → self-scoped  │
            │ effectiveStatus, host, uptime, lastSeen       └───────────┬─────────────┘
            │                                                           │
            └───────────────────────────────────────────────────────────
                                                       listConnectionsForOwner / ...ForAgent
                                                                        │
                                                              ┌─────────▼─────────┐
                                                              │  DaemonConnection │ (Postgres,
                                                              │  + agent.ownerUuid│  already populated
                                                              └───────────────────┘  by SSE routes)
```

The registry is written by the SSE routes (parent change); this change only
reads. Because the table is in Postgres, the read is correct regardless of which
ECS instance holds the socket or serves the GET.

## Data flow & visibility

`getAuthContext(request)` already returns a discriminated union (user / agent /
super_admin). The endpoint branches on it:

- **User caller** (cookie or user Bearer): visible set =
  `prisma.daemonConnection.findMany({ where: { companyUuid, agent: { ownerUuid: user.uuid } } })`.
  This is the owner-scoped rule the parent change fixed as a binding contract.
- **Agent-key caller**: visible set =
  `where: { companyUuid, agentUuid: auth.actorUuid }`. An agent key has no owner
  to expand, so it sees only its own connections — the natural agent-side
  analogue of owner-scoping, and what a daemon would call to confirm "am I
  registered?".
- **Super-admin**: treated as a user with no owner filter is **not** done here —
  super-admin is out of the daemon-owner model; it falls through to the
  agent/user branches by `auth.type`. (No special super-admin view in this slice.)

All queries are `companyUuid`-scoped — multi-tenancy is never relaxed.

## Module contracts

### Service: `src/services/daemon-connection.service.ts` (additions only)

```ts
// Projection returned to callers. Raw status/lastSeenAt are included so the UI
// can show "last active" + uptime; effectiveStatus is the liveness verdict.
export interface ConnectionView {
  uuid: string;
  agentUuid: string;
  clientType: string;
  clientVersion: string | null;
  host: string;            // "" when host-less (display can show a placeholder)
  startedAt: string | null;     // ISO-8601
  status: string;               // raw persisted status
  effectiveStatus: "online" | "offline";
  connectedAt: string;          // ISO-8601
  lastSeenAt: string;           // ISO-8601
  disconnectedAt: string | null;
}

// Owner-scoped: connections for agents owned by `ownerUuid`, within company.
export async function listConnectionsForOwner(
  companyUuid: string, ownerUuid: string
): Promise<ConnectionView[]>;

// Agent-key scoped: the calling agent's own connections, within company.
export async function listConnectionsForAgent(
  companyUuid: string, agentUuid: string
): Promise<ConnectionView[]>;
```

**`effectiveStatus` derivation (the single source of truth):**

```ts
function projectStatus(row): "online" | "offline" {
  const fresh = Date.now() - row.lastSeenAt.getTime() <= STALE_THRESHOLD_MS;
  return row.status === "online" && fresh ? "online" : "offline";
}
```

Reuses the module-level `STALE_THRESHOLD_MS = 90_000`. Both list functions share
one internal mapper (`toConnectionView`) so the projection is defined once.
Ordering: `effectiveStatus` online first, then `lastSeenAt` desc — most-relevant
connections surface at the top.

The read functions do **not** swallow-and-log like the write functions: a read
failure is a real error the caller (the route) should surface as a 500 via
`withErrorHandler`, not a silently-empty list that would falsely read as "no
connections".

### Route: `src/app/api/agent-connections/route.ts` (new)

```ts
export const GET = withErrorHandler(async (request: NextRequest) => {
  const auth = await getAuthContext(request);
  if (!auth) return errors.unauthorized();

  let connections: ConnectionView[];
  if (auth.type === "agent") {
    connections = await listConnectionsForAgent(auth.companyUuid, auth.actorUuid);
  } else {
    // user / super_admin → owner-scoped by the acting user's uuid
    connections = await listConnectionsForOwner(auth.companyUuid, auth.actorUuid);
  }
  return success({ connections });
});
```

No permission-bit gate: visibility is enforced by the query scope itself
(owner / self), and the data is the caller's own connection metadata. This
matches the root-idea-resolution endpoint, which is likewise agent-key callable
without a dedicated permission bit. Auth is still required (401 without it).

### Page: `src/app/(dashboard)/agent-connections/page.tsx` (new)

Client component (`"use client"`). Pattern mirrors the existing projects page:
`useState` for the list + loading, a `useCallback` fetcher hitting
`GET /api/agent-connections`, a `useEffect` that fetches on mount and sets a
`setInterval(fetch, 15_000)` (cleared on unmount). No SSE subscription — polling
is sufficient and avoids a new realtime event type. Renders:

- Header: title + owner-scoped subtitle + online/total summary count.
- One card per connection (shadcn `Card` + `Badge`): client-type label + version
  pill, online/offline `Badge` from `effectiveStatus`, host row, uptime (from
  `connectedAt`), last-active (from `lastSeenAt`).
- Empty state when the list is empty: short copy on how to start a daemon
  (`chorus daemon` / OpenClaw), all i18n.

Relative-time rendering ("just now", "5 min ago") reuses the existing relative-
time helper if one exists in the codebase; otherwise a small local formatter with
i18n keys. All visible strings go through `t()`.

### Nav: `src/app/(dashboard)/layout.tsx`

Add to `globalNavItems`:

```ts
{ href: "/agent-connections", label: t("nav.agentConnections"), icon: RadioTower },
```

`RadioTower` imported from `lucide-react`. Active-state highlight is handled by
the existing `isNavActive` logic (matches `/agent-connections`).

## i18n keys (both `en` and `zh`)

- `nav.agentConnections`
- `agentConnections.title`, `.subtitle`, `.summaryOnline`, `.summaryOffline`
- `agentConnections.statusOnline`, `.statusOffline`
- `agentConnections.fieldHost`, `.fieldVersion`, `.fieldUptime`, `.fieldLastActive`,
  `.fieldStarted`
- `agentConnections.clientClaudeCode`, `.clientOpenclaw`, `.clientUnknown`
- `agentConnections.empty.title`, `.empty.body`
- relative-time keys as needed (`agentConnections.justNow`, `.minutesAgo`, etc.)
  unless an existing shared time helper already provides them.

## Testing strategy

- **Service** (`__tests__/daemon-connection.service.test.ts`, extend existing):
  - `listConnectionsForOwner` filters by `companyUuid` + `agent.ownerUuid` and maps
    rows to `ConnectionView`.
  - `listConnectionsForAgent` filters by `companyUuid` + `agentUuid`.
  - `effectiveStatus`: row `status="online"` with fresh `lastSeenAt` → `online`;
    `status="online"` with `lastSeenAt` older than `STALE_THRESHOLD_MS` → `offline`
    (the staleness case); `status="offline"` → `offline` regardless of `lastSeenAt`.
  - Boundary exactly at `STALE_THRESHOLD_MS`.
  - Ordering: online-first then `lastSeenAt` desc.
  - A read error propagates (does NOT swallow to `[]`).
  Prisma + clock mocked (the existing test file already mocks both).

- **Route** (`src/app/api/agent-connections/__tests__/route.test.ts`, new):
  - 401 when unauthenticated.
  - User auth → calls `listConnectionsForOwner(companyUuid, actorUuid)`.
  - Agent auth → calls `listConnectionsForAgent(companyUuid, actorUuid)`.
  - Returns `{ success: true, data: { connections } }`.
  Service mocked.

## Risks & mitigations

- **Poll volume.** ~15s polling per open page is negligible (a single indexed
  query scoped to one owner). Mitigation: the existing `@@index([companyUuid])` +
  `@@index([agentUuid])` cover both scope branches; the join to `agent.ownerUuid`
  uses the indexed `ownerUuid`.
- **Stale `online` rows from a crashed instance.** Covered by `effectiveStatus` —
  a row whose `lastSeenAt` stopped advancing reads as `offline` after 90s without
  any reaper. No background job needed for read correctness.
- **Clock for staleness.** Uses `Date.now()` server-side; tests mock the clock to
  pin the boundary deterministically.
- **Empty `host`.** The registry stores `""` for host-less self-reports (non-null
  default). The DTO passes `""` through; the page shows a neutral placeholder
  rather than an empty gap.
