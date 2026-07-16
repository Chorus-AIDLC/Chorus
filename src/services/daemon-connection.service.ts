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
export const DAEMON_CLIENT_TYPES = ["claude_code", "openclaw", "codex", "kiro"] as const;
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
 * Returned by `registerConnection` when the registration is REJECTED because a
 * live, different-process daemon already holds the same `(agentUuid, host, cwd)`
 * identity (add-daemon-connection-conflict-skip). This is NOT an error and NOT a
 * handle — it is a third, distinct outcome the caller (the SSE route) must
 * recognize so it can emit a `connection_conflict` event instead of wiring up the
 * per-connection lifecycle for a connection that was never written.
 *
 * The crucial contract: when this is returned, NOTHING was written — no
 * `DaemonConnection` row was created/upserted/refreshed and no `AgentInstance`
 * was materialized. Because the only process-identity discriminator is the
 * self-reported `startedAt` (DEC-1), a rejected registration that wrote even
 * `lastSeenAt` would corrupt the incumbent's own reconnect comparison.
 *
 * `host`/`cwd` echo the conflicting identity so the route can forward them to the
 * daemon (which names them in its WARNING). `cwd` is always a real string here —
 * conflict detection runs only on the real-cwd path; the `cwd=null` HARD-1 branch
 * is exempt (Q5).
 */
export interface ConnectionConflict {
  conflict: true;
  host: string;
  cwd: string;
}

/**
 * Narrow a `registerConnection` result to the conflict sentinel. Callers use this
 * to distinguish the three outcomes (success handle | conflict | null) without
 * leaning on structural truthiness — a conflict object is truthy, so a naive
 * `if (result)` would mistake it for a handle.
 */
export function isConnectionConflict(
  result: ConnectionHandle | ConnectionConflict | null,
): result is ConnectionConflict {
  return result !== null && "conflict" in result;
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
  // Owning agent's human owner (Agent.ownerUuid). Joined from the same `agent`
  // relation; null for an unowned/system agent or when the relation cannot be
  // resolved. Mirrors the server owner rule in daemon-control.service
  // (`resolveConnectionOwner` → `row.agent?.ownerUuid ?? null`) so a client can
  // gate an owner-only action (e.g. the mention badge's "Open conversation")
  // against `useAuth().user.uuid` without a second fetch — never inferring
  // ownership from name/email.
  ownerUuid: string | null;
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
  // The durable AgentInstance this connection currently serves — the stable
  // `(agent, host, cwd)` identity that survives reconnects (DaemonConnection.uuid
  // does not). Additive: null for a row that predates the AgentInstance link
  // (existed at migration time, not yet re-handshaked) or whose link could not be
  // resolved. A client can pin against this uuid; liveness is still read from the
  // connection's `effectiveStatus`, never from the instance row.
  agentInstanceUuid: string | null;
}

/**
 * Read projection of an `AgentInstance` for the InstancePicker. The instance row
 * itself carries NO liveness (R5: liveness is a DaemonConnection property), so
 * `online` here is DERIVED from the instance's linked connections using the same
 * `effectiveStatus` rule the connection read path applies — an instance is online
 * iff *any* of its connections is effectively online. This is what backs the
 * picker's "online instances only" requirement: the caller filters on `online`.
 */
export interface InstanceView {
  uuid: string;
  agentUuid: string;
  host: string; // "" when host-less
  cwd: string | null; // null = unknown-path sentinel
  // True iff at least one linked DaemonConnection is effectively online
  // (status === "online" AND within STALE_THRESHOLD_MS). Derived, never stored.
  online: boolean;
  createdAt: string; // ISO-8601
  updatedAt: string; // ISO-8601
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
  // The linked durable instance (additive). Null when unlinked (pre-migration
  // row not yet re-handshaked). Passed straight through to the view.
  agentInstanceUuid: string | null;
  // `name` for the display identity, `ownerUuid` for the owner gate. nullable for
  // the rare deleted-agent case (see ConnectionView.agentName / ownerUuid).
  agent: { name: string; ownerUuid: string | null } | null;
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
/**
 * The single liveness predicate shared by every consumer (the read projection,
 * the instance-online derivation, AND the registration conflict check), so
 * producer and consumer can never drift (Module Contract 4). A connection is
 * *effectively online* iff its raw `status` is the literal "online" AND its
 * `lastSeenAt` is within `STALE_THRESHOLD_MS` of `now`. The boundary is
 * inclusive: elapsed exactly equal to the threshold still counts as fresh.
 * `now` is injected (defaulting to `Date.now()`) so callers that already
 * captured a timestamp can pass it for internal consistency.
 */
function isEffectivelyOnline(status: string, lastSeenAt: Date, now: number = Date.now()): boolean {
  return status === "online" && now - lastSeenAt.getTime() <= STALE_THRESHOLD_MS;
}

function toConnectionView(row: DaemonConnectionRow): ConnectionView {
  const effectiveStatus = isEffectivelyOnline(row.status, row.lastSeenAt) ? "online" : "offline";

  return {
    uuid: row.uuid,
    agentUuid: row.agentUuid,
    agentName: row.agent?.name ?? null,
    // Same non-disclosure-safe projection as resolveConnectionOwner: a deleted /
    // unresolved agent relation projects null rather than throwing.
    ownerUuid: row.agent?.ownerUuid ?? null,
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
    agentInstanceUuid: row.agentInstanceUuid ?? null,
  };
}

const MISSING_NAME_SORT_KEY = "\uffff";
const NULL_CWD_SORT_KEY = "\uffff";

function normalizedTextSortKey(value: string | null): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed.toLocaleLowerCase("en-US") : MISSING_NAME_SORT_KEY;
}

function cwdSortKey(value: string | null): string {
  return value === null ? NULL_CWD_SORT_KEY : value;
}

function compareText(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Order the projected views deterministically for stable daemon presence UI.
 *
 * Timestamps remain display data only: `lastSeenAt` changes on heartbeat and
 * therefore must not reorder an otherwise-equivalent connection set. Sorts a
 * copy; never mutates the caller-owned array.
 */
export function sortConnectionViews(views: ConnectionView[]): ConnectionView[] {
  return [...views].sort((a, b) => {
    if (a.effectiveStatus !== b.effectiveStatus) {
      return a.effectiveStatus === "online" ? -1 : 1;
    }
    return (
      compareText(normalizedTextSortKey(a.agentName), normalizedTextSortKey(b.agentName)) ||
      compareText(a.agentUuid, b.agentUuid) ||
      compareText(cwdSortKey(a.cwd), cwdSortKey(b.cwd)) ||
      compareText(a.host, b.host) ||
      compareText(a.clientType, b.clientType) ||
      compareText(a.uuid, b.uuid)
    );
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
/**
 * Upsert the durable `AgentInstance` for `(companyUuid, agentUuid, host, cwd)` and
 * return its uuid. This is the stable `(agent, host, cwd)` identity that outlives
 * the churning `DaemonConnection.uuid` (which is recreated on every reconnect via
 * its own composite `@@unique`). Called from `registerConnection` so the very same
 * handshake that registers a connection also materializes (or reuses) the instance
 * it serves, then links the connection to it.
 *
 * Idempotent per identity tuple: a repeat report for an existing `(agent,host,cwd)`
 * reuses the row (no duplicate); the returned uuid is therefore stable across
 * reconnects even though the connection uuid is not.
 *
 * Same two write paths as the connection upsert, and for the same reason — Postgres
 * treats a NULL `cwd` as distinct in the `@@unique([companyUuid,agentUuid,host,cwd])`
 * index, and Prisma types the compound-key `where` field as non-null:
 *  - cwd PRESENT → a single compound-key `upsert` (clean idempotent reuse). The
 *    `update` is a no-op data-wise (the identity tuple cannot change), but it bumps
 *    `updatedAt` and, crucially, returns the existing row's uuid.
 *  - cwd NULL → `findFirst` the existing `(…, cwd:null)` row and reuse its uuid;
 *    only `create` when none exists — mirroring the connection null-cwd branch so an
 *    old daemon keeps a single stable instance row across reconnects (no pileup).
 *
 * Returns null on failure; the caller treats a null instance as "could not link"
 * and still registers the connection (the link is additive — a missing link must
 * never block SSE setup). The caller's own try/catch also covers this, but the
 * resilience is documented here as the contract.
 */
async function upsertAgentInstance(
  companyUuid: string,
  agentUuid: string,
  host: string,
  cwd: string | null,
): Promise<string | null> {
  const createData = { companyUuid, agentUuid, host, cwd };

  // Self-contained swallow-and-log: an AgentInstance write failure must degrade the
  // connection link to `null` (the additive, never-blocking contract) rather than
  // propagate into registerConnection's outer catch and abort the WHOLE registration.
  // The connection registry write must never be blocked by the instance table — so a
  // failure here is contained here, logged, and surfaced as a null link.
  try {
    if (cwd === null) {
      // ===== Old-daemon / unknown-cwd path: findFirst → create (NULL-distinct) =====
      const existing = await prisma.agentInstance.findFirst({
        where: { companyUuid, agentUuid, host, cwd: null },
        select: { uuid: true },
      });
      if (existing) {
        // Touch updatedAt so "last materialized" tracks the latest handshake; the
        // identity tuple is immutable, so this is the only mutable effect.
        const row = await prisma.agentInstance.update({
          where: { uuid: existing.uuid },
          data: { updatedAt: new Date() },
          select: { uuid: true },
        });
        return row.uuid;
      }
      const row = await prisma.agentInstance.create({
        data: createData,
        select: { uuid: true },
      });
      return row.uuid;
    }

    // ===== Current-daemon path: real cwd → clean compound-key upsert =====
    const row = await prisma.agentInstance.upsert({
      where: { companyUuid_agentUuid_host_cwd: { companyUuid, agentUuid, host, cwd } },
      create: createData,
      // Identity is immutable; bump updatedAt and return the row (its uuid is stable).
      update: { updatedAt: new Date() },
      select: { uuid: true },
    });
    return row.uuid;
  } catch (err) {
    logger.error(
      { err, companyUuid, agentUuid, host, cwd },
      "Failed to upsert AgentInstance; connection will register with a null instance link",
    );
    return null;
  }
}

/**
 * Result of the conflict pre-check: identifies the fresh incumbent that blocks the
 * registration, so the caller can log it. `null` from `detectRegistrationConflict`
 * means "no conflict — proceed to register".
 */
interface ConflictDetail {
  incumbentStartedAt: Date | null;
  incumbentClientType: string;
}

/**
 * Decide whether registering at `(agentUuid, host, cwd)` would silently preempt a
 * different live daemon process (add-daemon-connection-conflict-skip). Returns a
 * `ConflictDetail` when it WOULD (the caller must skip + signal), or `null` when
 * registration may proceed.
 *
 * Truth table over the existing rows at the `(agentUuid, host, cwd)` TRIPLE —
 * evaluated ACROSS ALL clientTypes (Q2/DEC-2), so a fresh claude_code incumbent
 * blocks a codex registration at the same path and vice-versa:
 *  - no effectively-online incumbent → null (first connect OR stale takeover — a
 *    stale/offline row is always takeable, regardless of startedAt);
 *  - a fresh incumbent whose startedAt EQUALS the incoming startedAt → null (this
 *    is the same process reconnecting; preserve reconnect semantics 1:1);
 *  - a fresh incumbent whose startedAt DIFFERS from the incoming startedAt
 *    (including the null-vs-non-null asymmetry in either direction) → CONFLICT.
 *
 * Liveness uses the shared `isEffectivelyOnline` predicate (Module Contract 4) so
 * it can never drift from the read projection. `now` is the registration timestamp
 * already captured by the caller, passed in for internal consistency.
 *
 * Read-only: this issues a single `findMany` and never writes — it runs before any
 * mutation so the write-nothing invariant holds. It is invoked inside
 * `registerConnection`'s try/catch, so a query failure propagates to that catch and
 * degrades to the existing swallow-and-log "return null" (treated as "no conflict,
 * but the subsequent write will also fail and be swallowed") rather than throwing.
 */
async function detectRegistrationConflict(
  agentUuid: string,
  host: string,
  cwd: string,
  incomingStartedAt: Date | null,
  now: number,
): Promise<ConflictDetail | null> {
  // The composite unique is (agentUuid, clientType, host, cwd); querying the
  // (agentUuid, host, cwd) SUBSET is intentionally non-unique so it spans every
  // clientType at this path. Only liveness-relevant fields are selected.
  const rows = await prisma.daemonConnection.findMany({
    where: { agentUuid, host, cwd },
    select: { status: true, lastSeenAt: true, startedAt: true, clientType: true },
  });

  for (const row of rows) {
    if (!isEffectivelyOnline(row.status, row.lastSeenAt, now)) {
      // Stale / offline incumbent — always takeable, never a conflict.
      continue;
    }
    // Fresh incumbent. Same startedAt ⇒ same process reconnecting (not a conflict).
    // - Both non-null and equal instants → same process → refresh.
    // - One null, one non-null (either direction) → DIFFERENT → conflict (the
    //   confirmed null-startedAt edge: a fresh row we cannot prove is "us" is
    //   treated as someone else's, biasing toward non-preemption).
    // - Both null → treated as "same" → refresh. This biases toward preserving
    //   reconnect (DEC-1 fails safe toward today's behavior) and is practically
    //   unreachable: this branch only runs on the real-cwd path, where every
    //   feature-carrying daemon always self-reports startedAt, so an incoming
    //   null here is not a real CLI. Two genuinely-different startedAt-less
    //   daemons at one real cwd would be required to hit the preempt case — which
    //   the real client never produces.
    const bothNonNullEqual =
      incomingStartedAt !== null &&
      row.startedAt !== null &&
      row.startedAt.getTime() === incomingStartedAt.getTime();
    const bothNull = incomingStartedAt === null && row.startedAt === null;
    if (bothNonNullEqual || bothNull) {
      continue;
    }
    // Fresh + different process identity → conflict. Return the first such incumbent.
    return { incumbentStartedAt: row.startedAt, incumbentClientType: row.clientType };
  }
  return null;
}

export async function registerConnection(
  companyUuid: string,
  agentUuid: string,
  report: SelfReport,
): Promise<ConnectionHandle | ConnectionConflict | null> {
  if (!isDaemonClientType(report.clientType)) {
    return null;
  }

  const host = report.host ?? "";
  // "Unknown cwd" → SQL NULL. Do NOT coerce to "" — null is the single sentinel
  // for an old daemon that does not report cwd, matching the nullable column.
  const cwd = report.cwd ?? null;
  const now = new Date();

  try {
    // ===== Conflict detection (add-daemon-connection-conflict-skip) =====
    // Before writing ANYTHING, on the real-cwd path only, refuse to silently take
    // over a connection that a *different live daemon process* already holds at the
    // same (agentUuid, host, cwd). This is the one new branch; it must return BEFORE
    // upsertAgentInstance and before any connection write (the write-nothing
    // invariant — a rejected write would corrupt the incumbent's startedAt-based
    // reconnect comparison, since startedAt is the only process discriminator, DEC-1).
    //
    // Scope is the (agentUuid, host, cwd) TRIPLE across ALL clientTypes (Q2/DEC-2),
    // not the (agent, clientType, host, cwd) unique row — two backends in the same
    // cwd would be woken by the same notification batch and double-execute, the very
    // harm this guards. The cwd=null HARD-1 branch is EXEMPT (Q5): an old daemon
    // neither self-reports startedAt nor can act on a conflict signal, so detecting
    // there could only break its reconnect.
    if (cwd !== null) {
      const conflict = await detectRegistrationConflict(
        agentUuid,
        host,
        cwd,
        report.startedAt ?? null,
        now.getTime(),
      );
      if (conflict) {
        // Structured WARN (Q6) — distinct from the write-failure logger.error below;
        // a conflict is an expected outcome, not a failure. Carries enough identity to
        // diagnose a duplicate daemon even when the second process's stderr lands in a
        // different journal.
        logger.warn(
          {
            companyUuid,
            agentUuid,
            host,
            cwd,
            incumbentStartedAt: conflict.incumbentStartedAt,
            incomingStartedAt: report.startedAt ?? null,
            incumbentClientType: conflict.incumbentClientType,
            incomingClientType: report.clientType,
          },
          "Skipping daemon connection registration: a live daemon already holds this (agent, host, cwd)",
        );
        return { conflict: true, host, cwd };
      }
    }

    // Materialize / reuse the durable AgentInstance for this identity FIRST, so we
    // can link the connection to it in the SAME write path. upsertAgentInstance
    // swallows its own errors and returns `null` on failure: an instance-table write
    // failure degrades the link to null but must NEVER abort the connection
    // registration (the additive-link contract). The connection write still runs in
    // the outer try/catch for ITS own failures. The resolved instance uuid (or null
    // if unresolved/failed) is stamped onto the connection's create AND update data
    // so a reconnecting row is (re)linked too.
    const agentInstanceUuid = await upsertAgentInstance(companyUuid, agentUuid, host, cwd);
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
      // Link to the durable instance materialized above (null if it could not be
      // resolved — the link is additive and never blocks registration).
      agentInstanceUuid,
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
      // Re-affirm the instance link on reconnect: a row that existed before the
      // AgentInstance migration (agentInstanceUuid=null) gets linked on this
      // handshake, and a row whose instance was resolved stays linked.
      agentInstanceUuid,
    };

    if (cwd === null) {
      // ===== Old-daemon / unknown-cwd compatibility path (HARD-1) =====
      // Prisma cannot target a NULL cwd in the compound-unique `where`, and
      // Postgres would never dedup two NULL-cwd rows on its own. So reuse the
      // existing null row by uuid when present; create one only on first connect.
      // This prevents null-row pileup on reconnect while keeping old daemons
      // behaving exactly as before. (No generation reconcile here: a cwd-less old
      // daemon never self-reports startedAt, so a generation change is unprovable.)
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
    // Generation probe (restart-window seam, fix-daemon-exit-orphan-running-turn):
    // read the row's stored startedAt BEFORE the upsert refreshes it, so a NEW
    // PROCESS GENERATION (different self-reported process start) is detectable. A
    // crashed daemon that restarts within the staleness window reuses this row with
    // a fresh lastSeenAt, which permanently defeats the age-only orphan-turn
    // reconcile — the generation change is the only remaining evidence that the
    // previous process (and any turn it left `running`) is dead.
    const prior = await prisma.daemonConnection.findFirst({
      where: { agentUuid, clientType: report.clientType, host, cwd },
      select: { uuid: true, startedAt: true },
    });
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

    // New-generation orphan-turn reconcile: fire only when the row pre-existed AND
    // both generations are provable (non-null startedAt on both sides) AND they
    // differ. Same startedAt = the same process reconnecting (transient SSE drop) —
    // nothing to reconcile. Null on either side is treated conservatively as
    // unprovable (bias toward not interrupting). Fire-and-forget + lazily imported:
    // registration must never fail, slow, or cycle on the session service
    // (daemon-session.service imports this module for STALE_THRESHOLD_MS).
    const incomingStartedAt = report.startedAt ?? null;
    const priorStartedAt = prior?.startedAt instanceof Date ? prior.startedAt : null;
    if (
      prior &&
      priorStartedAt !== null &&
      incomingStartedAt !== null &&
      priorStartedAt.getTime() !== incomingStartedAt.getTime()
    ) {
      void import("@/services/daemon-session.service")
        .then(({ reconcileOrphanTurns }) =>
          reconcileOrphanTurns(companyUuid, row.uuid, { force: true }),
        )
        .catch((err) => {
          logger.error(
            { err, companyUuid, connectionUuid: row.uuid },
            "New-generation orphan-turn reconcile failed to dispatch",
          );
        });
    }
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
    // Pull the owning agent's display name (page leads with agent identity) and
    // its ownerUuid (the owner gate for client owner-only actions). Selecting two
    // scalar fields keeps the payload tight.
    include: { agent: { select: { name: true, ownerUuid: true } } },
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
    // display name + ownerUuid so the projection stays uniform (it's the agent's
    // own name/owner, but the shape is identical across both read paths).
    include: { agent: { select: { name: true, ownerUuid: true } } },
  });
  return sortConnectionViews(rows.map(toConnectionView));
}

// ===== Instance resolution (read functions — do NOT swallow) =====
//
// Like the connection reads above, these propagate a query failure rather than
// returning a default — null/[] must mean "genuinely absent", never "the DB threw".
// They are the lookups the wake path (notification-turn) and the InstancePicker UI
// build on: a durable instance pointer that survives reconnects.

/**
 * Resolve the durable `AgentInstance` uuid for an identity tuple
 * `(companyUuid, agentUuid, host, cwd)`, or null if no such instance exists.
 *
 * Used by the wake path to turn a pin's `(host, cwd)` — whether typed in a mention
 * suffix or carried by an `agent_instance` assignment — into the stable instance
 * pointer. `host` defaults to "" and `cwd` to null exactly as `registerConnection`
 * derives them, so the lookup key maps 1:1 to the upserted row. The null-cwd lookup
 * uses `findFirst` (Postgres treats NULL as distinct, so a compound-key `where`
 * cannot target it) — the same NULL-handling asymmetry the upsert observes.
 */
export async function resolveInstanceByTuple(
  companyUuid: string,
  agentUuid: string,
  host: string | null,
  cwd: string | null,
): Promise<string | null> {
  const normalizedHost = host ?? "";
  const row = await prisma.agentInstance.findFirst({
    where: { companyUuid, agentUuid, host: normalizedHost, cwd: cwd ?? null },
    select: { uuid: true },
  });
  return row?.uuid ?? null;
}

/**
 * Given a connection uuid, return the uuid of the `AgentInstance` it currently
 * serves (its `agentInstanceUuid` link), or null when the connection does not
 * exist in this company or is not yet linked (a pre-migration row not re-handshaked).
 * companyUuid-scoped so a connection in another tenant is never resolved.
 */
export async function resolveInstanceForConnection(
  companyUuid: string,
  connectionUuid: string,
): Promise<string | null> {
  const row = await prisma.daemonConnection.findFirst({
    where: { uuid: connectionUuid, companyUuid },
    select: { agentInstanceUuid: true },
  });
  return row?.agentInstanceUuid ?? null;
}

/**
 * List an agent's durable instances, each with `online` DERIVED from its linked
 * `DaemonConnection`s (R5: liveness lives on the connection, never on the instance
 * row). An instance is `online` iff *any* of its linked connections is effectively
 * online — `status === "online"` AND `lastSeenAt` within `STALE_THRESHOLD_MS` —
 * the exact rule `toConnectionView` applies, so producer and consumer can never
 * drift. This backs the InstancePicker's "online instances only" rule: the UI
 * filters the returned list on `online === true`.
 *
 * Ordered online-first, then most-recently-updated, so the freshest reachable
 * instances surface at the top of the picker. Propagates query errors (read rule).
 */
export async function listInstancesForAgent(
  companyUuid: string,
  agentUuid: string,
): Promise<InstanceView[]> {
  const now = Date.now();
  const rows = await prisma.agentInstance.findMany({
    where: { companyUuid, agentUuid },
    // Pull just the liveness-relevant fields off each linked connection; `online`
    // is derived from them, so we never need the full connection projection here.
    include: { connections: { select: { status: true, lastSeenAt: true } } },
  });

  const views: InstanceView[] = rows.map((row) => {
    const online = row.connections.some((c) => isEffectivelyOnline(c.status, c.lastSeenAt, now));
    return {
      uuid: row.uuid,
      agentUuid: row.agentUuid,
      host: row.host,
      cwd: row.cwd,
      online,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  });

  return views.sort((a, b) => {
    if (a.online !== b.online) return a.online ? -1 : 1;
    return b.updatedAt.localeCompare(a.updatedAt);
  });
}
