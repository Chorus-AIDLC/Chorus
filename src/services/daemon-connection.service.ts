// src/services/daemon-connection.service.ts
// Daemon Connection Registry Service — persistence layer for long-lived daemon
// SSE connections. Collection + liveness only: no read/query API, no HTTP/MCP
// endpoint, no AgentSession link, no UI (those are deferred to idea f2fe9a7f).
//
// All functions are companyUuid-scoped and swallow-and-log on failure: a registry
// write must NEVER throw to the caller, so a failing DB write can never block or
// break SSE stream setup / event delivery.

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

// ===== Helpers =====

function isDaemonClientType(value: string): value is DaemonClientType {
  return (DAEMON_CLIENT_TYPES as readonly string[]).includes(value);
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
 * Idempotent per logical daemon: keyed on (agentUuid, clientType, host). A
 * reconnect refreshes the existing row (status→online, connectedAt/lastSeenAt
 * refreshed, disconnectedAt cleared) rather than inserting a new one. `host`
 * defaults to "" so the composite unique key is deterministic even for a
 * host-less self-report (Prisma treats null as distinct, which would defeat the
 * dedup — see schema comment).
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
  const now = new Date();

  try {
    const row = await prisma.daemonConnection.upsert({
      where: {
        agentUuid_clientType_host: {
          agentUuid,
          clientType: report.clientType,
          host,
        },
      },
      create: {
        companyUuid,
        agentUuid,
        clientType: report.clientType,
        clientVersion: report.clientVersion ?? null,
        host,
        startedAt: report.startedAt ?? null,
        status: "online",
        connectedAt: now,
        lastSeenAt: now,
        disconnectedAt: null,
      },
      update: {
        // Multi-tenancy: re-affirm companyUuid from the authenticated context.
        companyUuid,
        clientVersion: report.clientVersion ?? null,
        startedAt: report.startedAt ?? null,
        status: "online",
        connectedAt: now,
        lastSeenAt: now,
        disconnectedAt: null,
      },
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
