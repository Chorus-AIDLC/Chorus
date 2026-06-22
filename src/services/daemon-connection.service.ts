// src/services/daemon-connection.service.ts
// Daemon Connection Registry Service — persistence + read projection for
// long-lived daemon SSE connections.
//
// All functions are companyUuid-scoped. The two error-handling regimes are
// deliberately different:
//   - WRITE functions (registerConnection / markDisconnected / touchConnection)
//     swallow-and-log on failure: a registry write must NEVER throw to the
//     caller, so a failing DB write can never block or break SSE stream setup /
//     event delivery.
//   - READ functions (listConnectionsForOwner / listConnectionsForAgent) do NOT
//     swallow: a query failure propagates so the route surfaces a 500. An empty
//     list must mean genuinely zero rows, not a hidden error.

import { prisma } from "@/lib/prisma";
import logger from "@/lib/logger";

// ===== Constants =====

// Recognized daemon client types eligible for registration in this change.
// The `clientType` column also reserves "browser" / "other" (see schema) so
// browser registration can be added later without a migration, but only these
// machine daemon types are registered now.
export const DAEMON_CLIENT_TYPES = ["claude_code", "openclaw"] as const;
export type DaemonClientType = (typeof DAEMON_CLIENT_TYPES)[number];

// Staleness threshold for the liveness rule a downstream reader MUST apply:
// a connection is *effectively online* iff status === "online" AND
// (now - lastSeenAt) <= STALE_THRESHOLD_MS.
//
// Derivation: the SSE routes bump lastSeenAt from their existing 30s heartbeat
// interval. 90s = 3 × 30s tolerates one fully-missed tick (plus jitter) before
// a still-"online" row is treated as stale, while reaping a hard-crashed
// instance's row within ~1.5 heartbeat windows. This change only exports the
// constant; the reader (f2fe9a7f) applies it.
export const STALE_THRESHOLD_MS = 90_000;

// ===== Types =====

export interface SelfReport {
  clientType: string; // raw query value; gated against DAEMON_CLIENT_TYPES
  clientVersion?: string | null;
  host?: string | null;
  // Working directory this connection serves. The self-reporting representation
  // of "unknown cwd" is `null` (NOT the empty string): a daemon that does not
  // report cwd — i.e. an OLD daemon predating the multi-path change — yields
  // `cwd: null`, which lands a `cwd=null` registry row (HARD-1). This matches the
  // nullable `cwd` column and the rows backfilled to NULL at migration time, so
  // "unknown cwd" has a single consistent representation end to end.
  cwd?: string | null;
  startedAt?: Date | null;
}

/**
 * Handle returned by `registerConnection`, identifying a specific connection
 * *generation*. `connectedAt` is a fencing token: each (re)registration stamps a
 * fresh `connectedAt` on the row, and the per-connection lifecycle calls
 * (`touchConnection` / `markDisconnected`) only act on the row while it still
 * carries the same `connectedAt`. This isolates connection generations: once a
 * newer connection refreshes the row, an older generation's lingering heartbeat
 * or late `abort` becomes a no-op instead of corrupting the newer row's status.
 */
export interface ConnectionHandle {
  uuid: string;
  connectedAt: Date;
}

/**
 * Read projection of a `DaemonConnection` row returned to callers of the read
 * API. The raw `status` and the timestamps are passed through so a client can
 * render uptime and last-active without re-implementing liveness; the
 * server-derived `effectiveStatus` is the single liveness verdict the client
 * renders verbatim.
 *
 * Note the two distinct timestamps:
 *  - `startedAt`   — self-reported daemon *process* start time (untrusted,
 *                    display-only; may be null if the daemon did not report it).
 *  - `connectedAt` — when *this* SSE connection registered with the server
 *                    (server-stamped; the fencing token for the connection
 *                    generation). Used for the "uptime" of the current
 *                    connection, which is not the same as process uptime.
 */
export interface ConnectionView {
  uuid: string;
  agentUuid: string;
  // Owning agent's display name (Agent.name). Joined from the `agent` relation;
  // null if the relation cannot be resolved (e.g. the agent row was deleted out
  // from under the connection — we project null rather than throwing so the
  // page can still render the daemon's own self-reported clientType/host).
  agentName: string | null;
  clientType: string;
  clientVersion: string | null;
  host: string; // "" when host-less (display can show a placeholder)
  // Working directory this connection serves; null for an old daemon that did
  // not self-report cwd (the "unknown cwd" sentinel). Two connections of the
  // same agent+host with different cwds are distinct rows, so the cwd is what
  // distinguishes them in the projection.
  cwd: string | null;
  startedAt: string | null; // ISO-8601 — self-reported daemon process start
  status: string; // raw persisted status
  effectiveStatus: "online" | "offline";
  connectedAt: string; // ISO-8601 — when this SSE connection registered
  lastSeenAt: string; // ISO-8601
  disconnectedAt: string | null;
}

// ===== Helpers =====

function isDaemonClientType(value: string): value is DaemonClientType {
  return (DAEMON_CLIENT_TYPES as readonly string[]).includes(value);
}

// Subset of the DaemonConnection row the mapper reads. Kept structural (rather
// than importing Prisma's generated type) so the mapper is trivially unit-
// testable with plain fixture objects. The `agent` relation is included with a
// `name`-only select so the mapper can project the owning agent's display name
// without pulling the full Agent row; nullable for the rare case where Prisma
// returns no related row (deleted agent — should not happen given the
// onDelete: Cascade, but we belt-and-suspenders the mapping rather than throw).
interface DaemonConnectionRow {
  uuid: string;
  agentUuid: string;
  clientType: string;
  clientVersion: string | null;
  host: string;
  cwd: string | null;
  startedAt: Date | null;
  status: string;
  connectedAt: Date;
  lastSeenAt: Date;
  disconnectedAt: Date | null;
  agent: { name: string } | null;
}

/**
 * Map a persisted row to its `ConnectionView`, deriving `effectiveStatus` —
 * the single source of truth for liveness. A connection is *effectively online*
 * iff its raw `status` is the literal "online" AND its `lastSeenAt` is within
 * `STALE_THRESHOLD_MS` of now; otherwise it is "offline". This REUSES the
 * exported `STALE_THRESHOLD_MS` so producer (the SSE heartbeat) and consumer
 * (this read path) can never drift. The boundary is inclusive: elapsed exactly
 * equal to the threshold still counts as fresh → "online".
 */
function toConnectionView(row: DaemonConnectionRow): ConnectionView {
  const fresh = Date.now() - row.lastSeenAt.getTime() <= STALE_THRESHOLD_MS;
  const effectiveStatus = row.status === "online" && fresh ? "online" : "offline";

  return {
    uuid: row.uuid,
    agentUuid: row.agentUuid,
    agentName: row.agent?.name ?? null,
    clientType: row.clientType,
    clientVersion: row.clientVersion,
    host: row.host,
    cwd: row.cwd,
    startedAt: row.startedAt ? row.startedAt.toISOString() : null,
    status: row.status,
    effectiveStatus,
    connectedAt: row.connectedAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    disconnectedAt: row.disconnectedAt ? row.disconnectedAt.toISOString() : null,
  };
}

/**
 * Order the projected views online-first, then by `lastSeenAt` desc — the
 * most-relevant connections surface at the top. Sorts a copy; does not mutate
 * the input.
 */
function sortConnectionViews(views: ConnectionView[]): ConnectionView[] {
  return [...views].sort((a, b) => {
    if (a.effectiveStatus !== b.effectiveStatus) {
      return a.effectiveStatus === "online" ? -1 : 1;
    }
    return b.lastSeenAt.localeCompare(a.lastSeenAt);
  });
}

/**
 * Parse the optional self-report query params off an SSE request URL.
 *
 * `startedAt` is parsed defensively from ISO-8601 → Date | null: an absent or
 * unparseable value yields null rather than an `Invalid Date`.
 */
export function parseSelfReport(searchParams: URLSearchParams): SelfReport {
  const clientType = searchParams.get("clientType") ?? "";
  const clientVersion = searchParams.get("clientVersion");
  const host = searchParams.get("host");
  // `cwd` is the working directory the connection serves. An absent param
  // (an OLD daemon that predates the multi-path change) parses to `null` — the
  // single representation of "unknown cwd" — which registerConnection lands as a
  // `cwd=null` row (HARD-1). Unlike `host`, cwd is NOT coerced to "": null is the
  // sentinel here, matching the nullable column and the migration-era NULL rows.
  const cwd = searchParams.get("cwd");

  let startedAt: Date | null = null;
  const startedAtRaw = searchParams.get("startedAt");
  if (startedAtRaw) {
    const parsed = new Date(startedAtRaw);
    if (!Number.isNaN(parsed.getTime())) {
      startedAt = parsed;
    }
  }

  return {
    clientType,
    clientVersion: clientVersion ?? null,
    host: host ?? null,
    cwd: cwd ?? null,
    startedAt,
  };
}

// ===== Service functions =====

/**
 * Register (upsert) a daemon connection as `online`.
 *
 * Returns a `ConnectionHandle` (`{ uuid, connectedAt }`) on success, or `null`
 * when:
 *  - the clientType is not a recognized daemon type (the caller then skips the
 *    rest of the lifecycle — no touch / no markDisconnected), or
 *  - the persistence write fails (swallowed + logged).
 *
 * Idempotent per logical daemon: keyed on (agentUuid, clientType, host, cwd) —
 * the composite unique key T1 widened with `cwd`. A reconnect refreshes the
 * existing row (status→online, connectedAt/lastSeenAt refreshed, disconnectedAt
 * cleared) rather than inserting a new one. `host` defaults to "" so the key is
 * deterministic even for a host-less self-report.
 *
 * cwd carries the working directory this connection serves, which fixes the
 * overwrite bug: the *same* agent on the *same* host driving two *different*
 * cwds now lands two independent rows (each its own presence) instead of one
 * overwriting the other. "Unknown cwd" is represented as SQL `NULL` (NOT the
 * empty string) — consistent with the nullable `cwd` column and the rows
 * backfilled to NULL at migration time. (This supersedes T1's compile-only
 * `cwd=""` shim, which existed only to preserve deterministic dedup until this
 * task wired the real self-report; the ""-vs-NULL asymmetry is resolved here in
 * favor of NULL.)
 *
 * Two write paths, because Postgres + Prisma treat a NULL cwd specially:
 *  - cwd PRESENT (a current daemon) → a single `upsert` on the compound unique
 *    key. Clean idempotent reconnect.
 *  - cwd NULL (an OLD daemon that does not self-report cwd — HARD-1) → we CANNOT
 *    use the compound-key upsert: Postgres treats each NULL as distinct in a
 *    UNIQUE index (so two `(agent,clientType,host,NULL)` rows never collide) AND
 *    Prisma types the compound-key `where` field as non-null (so NULL cannot be
 *    targeted there at all). Both verified empirically by T1 on Postgres 16. A
 *    naive cwd=null upsert would therefore ACCUMULATE a fresh row on every
 *    reconnect. So we implement the tech design's compatibility path: find the
 *    existing `(agentUuid, clientType, host, cwd:null)` row via `findFirst` and
 *    `update` it by uuid; only `create` when none exists. This keeps an old
 *    daemon on a single stable null row across reconnects — no error, no
 *    rejection, behavior identical to the pre-cwd world. New and old daemons
 *    coexist under the same agent without interfering (the new daemon owns its
 *    cwd row; the old daemon owns its null row).
 *
 * The returned `connectedAt` is the fencing token for the lifecycle calls: it is
 * stamped fresh on every (re)registration, so a later reconnect's `connectedAt`
 * differs from an earlier generation's. `touchConnection` / `markDisconnected`
 * gate on it, so an older connection's late `abort` or lingering heartbeat
 * cannot flip the newer generation's row (the "stale-abort-resurrects-offline"
 * race).
 */
export async function registerConnection(
  companyUuid: string,
  agentUuid: string,
  report: SelfReport,
): Promise<ConnectionHandle | null> {
  if (!isDaemonClientType(report.clientType)) {
    return null;
  }

  const host = report.host ?? "";
  // "Unknown cwd" → SQL NULL. Do NOT coerce to "" — null is the single sentinel
  // for an old daemon that does not report cwd, matching the nullable column.
  const cwd = report.cwd ?? null;
  const now = new Date();

  try {
    // Shared field sets, so the upsert and the null-compat path stay in lockstep.
    const createData = {
      companyUuid,
      agentUuid,
      clientType: report.clientType,
      clientVersion: report.clientVersion ?? null,
      host,
      cwd,
      startedAt: report.startedAt ?? null,
      status: "online",
      connectedAt: now,
      lastSeenAt: now,
      disconnectedAt: null,
    };
    const refreshData = {
      // Multi-tenancy: re-affirm companyUuid from the authenticated context.
      companyUuid,
      clientVersion: report.clientVersion ?? null,
      startedAt: report.startedAt ?? null,
      status: "online",
      connectedAt: now,
      lastSeenAt: now,
      disconnectedAt: null,
    };

    if (cwd === null) {
      // ===== Old-daemon / unknown-cwd compatibility path (HARD-1) =====
      // Prisma cannot target a NULL cwd in the compound-unique `where`, and
      // Postgres would never dedup two NULL-cwd rows on its own. So reuse the
      // existing null row by uuid when present; create one only on first connect.
      // This prevents null-row pileup on reconnect while keeping old daemons
      // behaving exactly as before.
      const existing = await prisma.daemonConnection.findFirst({
        where: { agentUuid, clientType: report.clientType, host, cwd: null },
        select: { uuid: true },
      });

      if (existing) {
        const row = await prisma.daemonConnection.update({
          where: { uuid: existing.uuid },
          data: refreshData,
          select: { uuid: true, connectedAt: true },
        });
        return { uuid: row.uuid, connectedAt: row.connectedAt };
      }

      const row = await prisma.daemonConnection.create({
        data: createData,
        select: { uuid: true, connectedAt: true },
      });
      return { uuid: row.uuid, connectedAt: row.connectedAt };
    }

    // ===== Current-daemon path: real cwd → clean compound-key upsert =====
    const row = await prisma.daemonConnection.upsert({
      where: {
        agentUuid_clientType_host_cwd: {
          agentUuid,
          clientType: report.clientType,
          host,
          cwd,
        },
      },
      create: createData,
      update: refreshData,
      select: { uuid: true, connectedAt: true },
    });
    return { uuid: row.uuid, connectedAt: row.connectedAt };
  } catch (err) {
    logger.error(
      { err, companyUuid, agentUuid, clientType: report.clientType },
      "Failed to register daemon connection",
    );
    return null;
  }
}

/**
 * Mark a connection `offline` with `disconnectedAt = now` (primary disconnect
 * signal: the SSE stream's `abort` event). companyUuid-scoped and fenced on
 * `connectedAt`: if a newer connection generation has since re-registered the
 * row (refreshing `connectedAt`), this update matches 0 rows and is a no-op, so
 * a stale `abort` from an old generation never flips a freshly-online row to
 * `offline`. Swallows + logs on failure; never throws to the caller.
 */
export async function markDisconnected(
  companyUuid: string,
  handle: ConnectionHandle,
): Promise<void> {
  try {
    await prisma.daemonConnection.updateMany({
      where: { uuid: handle.uuid, companyUuid, connectedAt: handle.connectedAt },
      data: { status: "offline", disconnectedAt: new Date() },
    });
  } catch (err) {
    logger.error(
      { err, companyUuid, connectionUuid: handle.uuid },
      "Failed to mark daemon connection disconnected",
    );
  }
}

/**
 * Heartbeat tick → bump `lastSeenAt` (and ensure status stays `online`).
 * companyUuid-scoped and fenced on `connectedAt`: a heartbeat from an old
 * connection generation (whose row has since been re-registered by a newer
 * generation) matches 0 rows and is a no-op, so it cannot resurrect or keep
 * alive a row that now belongs to a different connection. Swallows + logs on
 * failure; never throws to the caller.
 */
export async function touchConnection(
  companyUuid: string,
  handle: ConnectionHandle,
): Promise<void> {
  try {
    await prisma.daemonConnection.updateMany({
      where: { uuid: handle.uuid, companyUuid, connectedAt: handle.connectedAt },
      data: { status: "online", lastSeenAt: new Date() },
    });
  } catch (err) {
    logger.error(
      { err, companyUuid, connectionUuid: handle.uuid },
      "Failed to touch daemon connection",
    );
  }
}

// ===== Read functions =====
//
// Unlike the write functions above, the read functions deliberately do NOT
// swallow-and-log to an empty list. A query failure is a real error the caller
// (the route) must surface (as a 500 via withErrorHandler) — an empty list MUST
// mean genuinely zero rows, never "the DB threw". So these intentionally have no
// try/catch: a rejected query propagates.

/**
 * List the daemon connections visible to a *user* owner: every connection whose
 * agent is owned by `ownerUuid`, scoped to `companyUuid`. Projected to
 * `ConnectionView` (with server-derived `effectiveStatus`) and ordered
 * online-first then `lastSeenAt` desc.
 */
export async function listConnectionsForOwner(
  companyUuid: string,
  ownerUuid: string,
): Promise<ConnectionView[]> {
  const rows = await prisma.daemonConnection.findMany({
    where: { companyUuid, agent: { ownerUuid } },
    // Pull only the owning agent's display name — the page leads with agent
    // identity, so the read must carry it. `name`-only keeps the payload tight.
    include: { agent: { select: { name: true } } },
  });
  return sortConnectionViews(rows.map(toConnectionView));
}

/**
 * List the daemon connections owned by a single agent (`agentUuid`), scoped to
 * `companyUuid` — the agent-key analogue of owner-scoping ("am I registered?").
 * Projected to `ConnectionView` and ordered online-first then `lastSeenAt` desc.
 */
export async function listConnectionsForAgent(
  companyUuid: string,
  agentUuid: string,
): Promise<ConnectionView[]> {
  const rows = await prisma.daemonConnection.findMany({
    where: { companyUuid, agentUuid },
    // Same join as the owner-scoped read — agent self-scope still wants the
    // display name (it's the agent's own name, but the projection stays uniform).
    include: { agent: { select: { name: true } } },
  });
  return sortConnectionViews(rows.map(toConnectionView));
}
