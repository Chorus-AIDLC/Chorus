// src/services/daemon-execution.service.ts
// Daemon Execution Service — persistence + reconciliation for the running/queued
// RESOURCES a daemon connection reports, plus the owner/self-scoped read
// projection the Agent Connections page consumes.
//
// A "resource" is whatever entity the wake-triggering notification pointed at:
// a task, an idea (e.g. an @-mention or elaboration under an idea), a proposal,
// or a document. EVERY wake the daemon performs is reported — not only task
// dispatches — so the UI can show "this daemon is processing <resource>"
// regardless of which resource caused the work.
//
// This sits on top of `daemon-connection.service` (the DaemonConnection registry
// and its exported STALE_THRESHOLD_MS) and does NOT re-model connections or
// re-derive the staleness rule. `DaemonExecution` references a `DaemonConnection`
// by `connectionUuid` (weak ref, no DB FK — the execution row outlives the
// connection as history).
//
// Two reconcile entry points converge on one rule: a `running`/`queued` row that
// is no longer justified — absent from the latest snapshot (ingest path) or its
// connection effectively offline (disconnect/stale path) — transitions to the
// `ended` terminal state. Rows are never deleted: `ended` is history.

import { prisma } from "@/lib/prisma";
import { eventBus } from "@/lib/event-bus";
import { STALE_THRESHOLD_MS } from "@/services/daemon-connection.service";
import {
  conversationNameFromInstruction,
  getFirstInstructionBySessionUuid,
} from "@/services/daemon-session-naming";

// Re-export so callers that need the offline threshold import it from the
// execution service without reaching for a second constant — there is exactly
// one staleness threshold in the system and it lives in the connection registry.
export { STALE_THRESHOLD_MS };

// ===== Types =====

// The active (non-terminal) statuses a daemon reports for a resource. `ended` is
// the terminal/history state and is never reported by a snapshot — it is only
// ever written by the reconcile logic (absent-from-snapshot or offline).
export const ACTIVE_EXECUTION_STATUSES = ["running", "queued"] as const;
export type ActiveExecutionStatus = (typeof ACTIVE_EXECUTION_STATUSES)[number];
export const ENDED_EXECUTION_STATUS = "ended" as const;

// `interrupted` is a STICKY status (子3 — daemon-interrupt-resume): when a wake's
// subprocess is stopped (user-requested interrupt or unexpected crash), the
// execution row is marked `interrupted` (+ an `interruptedReason` discriminator).
// Snapshot reconcile and offline reconcile deliberately do NOT touch an
// `interrupted` row — the killed subprocess is gone, so it will be absent from the
// daemon's next snapshot, and the absent-from-snapshot rule would otherwise flip it
// to `ended` and hide the "interrupted, resumable" affordance. It stays
// `interrupted` until a resume re-dispatches the entity (clearing it). This lives on
// the execution row (NOT Task) because the daemon executes idea / proposal /
// document wakes too — interruption is an execution-lifecycle fact keyed by the same
// connection+entity the row already tracks, not a Task-domain state.
export const INTERRUPTED_EXECUTION_STATUS = "interrupted" as const;
// Interrupt reason discriminators (only meaningful while status == interrupted).
export const INTERRUPT_REASONS = ["user", "crash"] as const;
export type InterruptReason = (typeof INTERRUPT_REASONS)[number];

// Statuses the detail pane renders as a live/standing row: the two active statuses
// PLUS the sticky `interrupted` status (so an interrupted, resumable row keeps
// showing). `ended` history is still excluded from the read.
export const DISPLAYABLE_EXECUTION_STATUSES = [
  ...ACTIVE_EXECUTION_STATUSES,
  INTERRUPTED_EXECUTION_STATUS,
] as const;

// The wake-triggering resource kinds a daemon can report. Mirrors the Chorus
// notification `entityType` space for wake actions, PLUS `daemon_session` — the
// ad-hoc (non-idea) conversation wake, whose execution row points at a
// `DaemonSession` (NOT one of the four content tables). A non-conforming value is
// rejected at the route's zod boundary, so the service can assume validity.
export const EXECUTION_ENTITY_TYPES = [
  "task",
  "idea",
  "proposal",
  "document",
  "daemon_session",
] as const;
export type ExecutionEntityType = (typeof EXECUTION_ENTITY_TYPES)[number];

/**
 * One entry of an ingested snapshot — the daemon's report for a single resource
 * it is currently running or has queued on a connection. `startedAt` is the
 * daemon's self-reported run start (display-only); null while merely queued.
 */
export interface SnapshotExecution {
  entityType: ExecutionEntityType;
  entityUuid: string;
  rootIdeaUuid?: string | null;
  status: ActiveExecutionStatus; // "running" | "queued" — never "ended"
  startedAt?: Date | null;
}

/**
 * Read projection of a `DaemonExecution` row returned to callers of the read
 * API. Timestamps are ISO-8601 strings so the client renders elapsed/started
 * without re-touching Date objects across the wire.
 */
export interface ExecutionView {
  uuid: string;
  agentUuid: string;
  connectionUuid: string;
  entityType: string; // task | idea | proposal | document | daemon_session
  entityUuid: string;
  rootIdeaUuid: string | null;
  status: string; // running | queued | ended | interrupted
  // Discriminator for the `interrupted` status: "user" | "crash" | null. Null for
  // any non-interrupted row. The UI uses it to show a manual "Resume" affordance
  // only for a user-interrupt (a crash auto-recovers via reconnect-backfill).
  interruptedReason: string | null;
  startedAt: string | null; // ISO-8601
  createdAt: string; // ISO-8601
  updatedAt: string; // ISO-8601
  // Display enrichment, resolved on the read/publish path so the detail pane can
  // render a resource title + a deep link without an extra round-trip per row.
  // `entityTitle` is the target resource's own title; null when it no longer
  // resolves (e.g. a deleted entity) — the UI falls back to a localized
  // placeholder. `projectUuid` is the resource's project when it has one (task /
  // idea / proposal / document all carry one), needed to build the deep link.
  // `rootIdeaTitle` is the lineage anchor's title for the session label.
  entityTitle: string | null;
  projectUuid: string | null;
  rootIdeaTitle: string | null;
}

/**
 * Payload pushed on the `execution:{connectionUuid}` EventBus channel whenever a
 * connection's running/queued set changes (snapshot reconcile or offline
 * transition). It carries the `connectionUuid` so a subscriber can filter to the
 * connection it is viewing, and the current active `executions` so the client can
 * re-render directly off the event without a follow-up read round-trip. The
 * companyUuid is carried so the SSE route can enforce multi-tenancy before
 * forwarding (consistent with the change/presence handlers, which drop events
 * from other companies).
 */
export interface ExecutionEvent {
  companyUuid: string;
  connectionUuid: string;
  executions: ExecutionView[];
}

// Subset of the DaemonExecution row the mapper reads. Kept structural (not the
// Prisma generated type) so the mapper is trivially unit-testable with plain
// fixtures — mirrors the daemon-connection service's DaemonConnectionRow pattern.
interface DaemonExecutionRow {
  uuid: string;
  agentUuid: string;
  connectionUuid: string;
  entityType: string;
  entityUuid: string;
  rootIdeaUuid: string | null;
  status: string;
  interruptedReason: string | null;
  startedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

// Display enrichment looked up alongside the execution rows. Keyed by
// `${entityType}:${entityUuid}` so different resource kinds never collide. Each
// entry carries the resource's own title + an optional projectUuid (for the
// link). The root-idea title is looked up separately for the session label.
// Resolved in a batch by `enrichExecutionViews`, then folded in by the mapper.
interface ExecutionEnrichment {
  entity: Map<string, { title: string; projectUuid: string | null }>;
  idea: Map<string, { title: string }>;
}

const EMPTY_ENRICHMENT: ExecutionEnrichment = {
  entity: new Map(),
  idea: new Map(),
};

function entityKey(entityType: string, entityUuid: string): string {
  return `${entityType}:${entityUuid}`;
}

// ===== Helpers =====

function toExecutionView(
  row: DaemonExecutionRow,
  enrichment: ExecutionEnrichment = EMPTY_ENRICHMENT,
): ExecutionView {
  const entity = enrichment.entity.get(entityKey(row.entityType, row.entityUuid)) ?? null;
  const idea = row.rootIdeaUuid ? enrichment.idea.get(row.rootIdeaUuid) ?? null : null;
  return {
    uuid: row.uuid,
    agentUuid: row.agentUuid,
    connectionUuid: row.connectionUuid,
    entityType: row.entityType,
    entityUuid: row.entityUuid,
    rootIdeaUuid: row.rootIdeaUuid,
    status: row.status,
    interruptedReason: row.interruptedReason,
    startedAt: row.startedAt ? row.startedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    entityTitle: entity?.title ?? null,
    projectUuid: entity?.projectUuid ?? null,
    rootIdeaTitle: idea?.title ?? null,
  };
}

// Group a set of entity uuids by their entityType, deduplicated, so each
// resource table is queried once. Only the recognized EXECUTION_ENTITY_TYPES are
// returned (an unknown type contributes nothing and degrades to a null title).
function groupEntityUuidsByType(
  rows: { entityType: string; entityUuid: string }[],
): Record<ExecutionEntityType, string[]> {
  const acc: Record<ExecutionEntityType, Set<string>> = {
    task: new Set(),
    idea: new Set(),
    proposal: new Set(),
    document: new Set(),
    daemon_session: new Set(),
  };
  for (const r of rows) {
    if ((EXECUTION_ENTITY_TYPES as readonly string[]).includes(r.entityType)) {
      acc[r.entityType as ExecutionEntityType].add(r.entityUuid);
    }
  }
  return {
    task: [...acc.task],
    idea: [...acc.idea],
    proposal: [...acc.proposal],
    document: [...acc.document],
    daemon_session: [...acc.daemon_session],
  };
}

/**
 * Batch-resolve the display enrichment for a set of execution rows: per resource
 * kind, the title + (when applicable) project of every referenced entity, plus
 * the title of every referenced root idea (for the session label). At most one
 * query per distinct entity kind + one for ideas, all companyUuid-scoped. An
 * entity that no longer resolves is simply absent from the map, and the mapper
 * falls back to null so a deleted resource degrades to a localized placeholder
 * rather than throwing.
 *
 * projectUuid mapping by kind:
 *  - task → Task.projectUuid (deep link to the task)
 *  - idea → Idea.projectUuid (deep link to the idea / its panel)
 *  - proposal → Proposal.projectUuid
 *  - document → Document.projectUuid
 *  - daemon_session → DaemonSession.title, projectUuid: null (a conversation has no
 *    project deep link — it lives in the chat modal; `execHref` returns null for the
 *    type, so the row is labeled "Conversation" without a broken resource link)
 */
async function enrichExecutionViews(
  companyUuid: string,
  rows: DaemonExecutionRow[],
): Promise<ExecutionEnrichment> {
  const byType = groupEntityUuidsByType(rows);

  const entityMap = new Map<string, { title: string; projectUuid: string | null }>();
  const ideaMap = new Map<string, { title: string }>();

  if (byType.task.length > 0) {
    const tasks = await prisma.task.findMany({
      where: { companyUuid, uuid: { in: byType.task } },
      select: { uuid: true, title: true, projectUuid: true },
    });
    for (const t of tasks) {
      entityMap.set(entityKey("task", t.uuid), { title: t.title, projectUuid: t.projectUuid });
    }
  }

  if (byType.idea.length > 0) {
    const ideas = await prisma.idea.findMany({
      where: { companyUuid, uuid: { in: byType.idea } },
      select: { uuid: true, title: true, projectUuid: true },
    });
    for (const i of ideas) {
      entityMap.set(entityKey("idea", i.uuid), { title: i.title, projectUuid: i.projectUuid });
    }
  }

  if (byType.proposal.length > 0) {
    const proposals = await prisma.proposal.findMany({
      where: { companyUuid, uuid: { in: byType.proposal } },
      select: { uuid: true, title: true, projectUuid: true },
    });
    for (const p of proposals) {
      entityMap.set(entityKey("proposal", p.uuid), {
        title: p.title,
        projectUuid: p.projectUuid,
      });
    }
  }

  if (byType.document.length > 0) {
    const documents = await prisma.document.findMany({
      where: { companyUuid, uuid: { in: byType.document } },
      select: { uuid: true, title: true, projectUuid: true },
    });
    for (const d of documents) {
      entityMap.set(entityKey("document", d.uuid), {
        title: d.title,
        projectUuid: d.projectUuid,
      });
    }
  }

  // An ad-hoc conversation row points at a DaemonSession, NOT one of the four content
  // tables, and is keyed by the session BUSINESS id (`sessionId`) — the same value the
  // daemon reports and uses as the Claude `--resume` anchor. Its display NAME mirrors the
  // chat conversation list: the session's explicit `title` if set, else its FIRST human
  // instruction (the opening message), so a conversation reads by what the human said —
  // not a generic "Conversation". projectUuid is null (no project deep link; it lives in
  // the chat modal). A session with neither degrades to "" (UI shows a localized label).
  if (byType.daemon_session.length > 0) {
    const sessions = await prisma.daemonSession.findMany({
      where: { companyUuid, sessionId: { in: byType.daemon_session } },
      select: { sessionId: true, uuid: true, title: true },
    });
    // Resolve each session's opening human_instruction (the shared single-sourced
    // batched query), so a title-less conversation is named by its first message exactly
    // like the sidebar list.
    const firstInstructionByUuid = await getFirstInstructionBySessionUuid(
      sessions.map((s) => s.uuid),
    );
    for (const s of sessions) {
      const name =
        s.title?.trim() ||
        conversationNameFromInstruction(firstInstructionByUuid.get(s.uuid)) ||
        "";
      entityMap.set(entityKey("daemon_session", s.sessionId), {
        title: name,
        projectUuid: null,
      });
    }
  }

  // Root-idea titles for the session label. Reuse any idea already fetched above
  // (an idea-kind row whose entity IS the root idea), then fetch the remainder.
  const rootIdeaUuids = [
    ...new Set(
      rows
        .map((r) => r.rootIdeaUuid)
        .filter((u): u is string => typeof u === "string" && u.length > 0),
    ),
  ];
  const missingIdeaUuids = rootIdeaUuids.filter(
    (u) => !entityMap.has(entityKey("idea", u)),
  );
  for (const u of rootIdeaUuids) {
    const already = entityMap.get(entityKey("idea", u));
    if (already) ideaMap.set(u, { title: already.title });
  }
  if (missingIdeaUuids.length > 0) {
    const ideas = await prisma.idea.findMany({
      where: { companyUuid, uuid: { in: missingIdeaUuids } },
      select: { uuid: true, title: true },
    });
    for (const i of ideas) {
      ideaMap.set(i.uuid, { title: i.title });
    }
  }

  return { entity: entityMap, idea: ideaMap };
}

// ===== Reconcile (ingest path) =====

/**
 * Snapshot-authoritative reconcile of one connection's execution rows.
 *
 * The `executions` array is treated as the COMPLETE current state for
 * `connectionUuid`:
 *  - each reported resource is upserted to its reported `running`/`queued`
 *    status (keyed on the unique `(connectionUuid, entityType, entityUuid)`), and
 *  - every existing `running`/`queued` row for that connection whose resource is
 *    NOT in the snapshot transitions to `ended`.
 *
 * This makes the operation idempotent (re-applying the same snapshot yields the
 * same persisted state — no row flips on the second apply) and self-healing (a
 * dropped or out-of-order update cannot leave a row stuck `running`: the next
 * snapshot that omits it ends it).
 *
 * companyUuid/agentUuid are stamped from the authenticated context onto every
 * upserted row (multi-tenancy: never trusted from the request body). The
 * connection's ownership is fenced by the caller (the route) before this runs.
 *
 * Returns the number of rows reconciled (upserts + ended transitions) for
 * lightweight observability.
 */
export async function reconcileSnapshot(
  companyUuid: string,
  agentUuid: string,
  connectionUuid: string,
  executions: SnapshotExecution[],
): Promise<number> {
  // 1. End every running/queued row for this connection whose resource is absent
  //    from the snapshot. Identify the kept rows by (entityType, entityUuid) and
  //    end the rest. Done first so a resource that moved off the snapshot is
  //    terminal before (and independent of) the upserts below. A row is "kept"
  //    only when BOTH its type and uuid match a reported entry — so a uuid that
  //    appears under a different type is not accidentally preserved.
  const keptKeys = new Set(executions.map((e) => entityKey(e.entityType, e.entityUuid)));
  const activeRows = await prisma.daemonExecution.findMany({
    where: {
      companyUuid,
      connectionUuid,
      status: { in: [...ACTIVE_EXECUTION_STATUSES] },
    },
    select: { id: true, entityType: true, entityUuid: true },
  });
  const endIds = activeRows
    .filter((r) => !keptKeys.has(entityKey(r.entityType, r.entityUuid)))
    .map((r) => r.id);
  let endedCount = 0;
  if (endIds.length > 0) {
    const ended = await prisma.daemonExecution.updateMany({
      where: { id: { in: endIds } },
      data: { status: ENDED_EXECUTION_STATUS },
    });
    endedCount = ended.count;
  }

  // 2. Upsert each reported resource to its reported status. The unique
  //    (connectionUuid, entityType, entityUuid) guarantees a resource appears at
  //    most once per connection — re-dispatch updates the existing row
  //    (queued → running → ended) rather than inserting a duplicate.
  for (const exec of executions) {
    await prisma.daemonExecution.upsert({
      where: {
        connectionUuid_entityType_entityUuid: {
          connectionUuid,
          entityType: exec.entityType,
          entityUuid: exec.entityUuid,
        },
      },
      create: {
        companyUuid,
        agentUuid,
        connectionUuid,
        entityType: exec.entityType,
        entityUuid: exec.entityUuid,
        rootIdeaUuid: exec.rootIdeaUuid ?? null,
        status: exec.status,
        startedAt: exec.startedAt ?? null,
      },
      update: {
        // Re-affirm companyUuid/agentUuid from the authenticated context.
        companyUuid,
        agentUuid,
        rootIdeaUuid: exec.rootIdeaUuid ?? null,
        status: exec.status,
        startedAt: exec.startedAt ?? null,
        // A reported active status means the daemon is running/queuing this entity
        // again — i.e. a resume re-dispatch superseded any prior `interrupted`
        // state. Clear the sticky reason so the row is no longer shown as
        // interrupted. (A non-resumed interrupted row is simply absent from the
        // snapshot and is left untouched by the sweep above.)
        interruptedReason: null,
      },
    });
  }

  return endedCount + executions.length;
}

// ===== Offline reconcile (disconnect / stale path) =====

/**
 * Transition all of a connection's `running`/`queued` rows to `ended` because
 * the connection is effectively offline (its SSE stream aborted, or its
 * `lastSeenAt` aged past the registry's STALE_THRESHOLD_MS). Rows are RETAINED
 * (updated, not deleted) so execution history stays queryable.
 *
 * Reuses the same terminal-state rule as the ingest reconcile (a no-longer-
 * justified active row becomes `ended`) and the registry's single staleness
 * threshold — no second timeout constant is introduced. companyUuid-scoped.
 *
 * Like the connection registry's write functions, this is fire-and-forget from
 * the SSE abort handler: it swallows + logs its own errors so a failing reconcile
 * can never throw into stream teardown. Returns the number of rows transitioned.
 */
export async function reconcileOffline(
  companyUuid: string,
  connectionUuid: string,
): Promise<number> {
  try {
    const result = await prisma.daemonExecution.updateMany({
      where: {
        companyUuid,
        connectionUuid,
        status: { in: [...ACTIVE_EXECUTION_STATUSES] },
      },
      data: { status: ENDED_EXECUTION_STATUS },
    });
    return result.count;
  } catch (err) {
    // Lazy import to avoid a hard dep at module load; mirrors the registry's
    // swallow-and-log regime for write functions on the disconnect path.
    const { default: logger } = await import("@/lib/logger");
    logger.error(
      { err, companyUuid, connectionUuid },
      "Failed to reconcile daemon execution offline",
    );
    return 0;
  }
}

// ===== Read functions =====
//
// As with the connection registry's read functions, these deliberately do NOT
// swallow-and-log to an empty list: a query failure propagates so the route
// surfaces a 500. An empty list MUST mean genuinely zero rows.

/**
 * Read-time staleness gate. The spec defines a connection as effectively offline
 * when "its stream aborts, OR its `lastSeenAt` is older than `STALE_THRESHOLD_MS`"
 * — and an offline connection SHALL show no running/queued. The abort case is
 * reconciled inline (rows flipped to `ended` on the SSE abort path), but a daemon
 * that crashes / sleeps / loses its network WITHOUT a clean abort never fires that
 * path, so its rows are still persisted `running`/`queued`. Without this gate they
 * would render as active (with an ever-incrementing elapsed timer) right beside a
 * connection card the read API already shows as "offline".
 *
 * So a row is part of the ACTIVE set only when BOTH hold:
 *  - its own status is `running`/`queued` (already filtered by the query), AND
 *  - its connection is effectively ONLINE — exactly the registry's rule:
 *    `status === "online" && now - lastSeenAt <= STALE_THRESHOLD_MS`.
 *
 * This REUSES the single `STALE_THRESHOLD_MS` (no second constant) so producer
 * (the SSE heartbeat that bumps lastSeenAt) and consumer cannot drift, mirroring
 * `daemon-connection.service`'s `toConnectionView` derivation. The rows are NOT
 * mutated — they remain persisted as history; they are merely omitted from the
 * active read. A row whose connection no longer exists is also dropped (a deleted
 * connection cannot be online). Returns the subset of `rows` whose connection is
 * currently live. companyUuid-scoped lookup; a READ that does NOT swallow.
 */
async function filterRowsByLiveConnection(
  companyUuid: string,
  rows: DaemonExecutionRow[],
): Promise<DaemonExecutionRow[]> {
  if (rows.length === 0) return rows;
  const connectionUuids = [...new Set(rows.map((r) => r.connectionUuid))];
  const connections = await prisma.daemonConnection.findMany({
    where: { companyUuid, uuid: { in: connectionUuids } },
    select: { uuid: true, status: true, lastSeenAt: true },
  });
  const now = Date.now();
  // The set of connections that are effectively ONLINE right now — same verdict
  // the connection read API renders.
  const liveConnectionUuids = new Set(
    connections
      .filter(
        (c) => c.status === "online" && now - c.lastSeenAt.getTime() <= STALE_THRESHOLD_MS,
      )
      .map((c) => c.uuid),
  );
  // A `running`/`queued` row is only meaningful while its connection is live (an
  // offline daemon isn't actually running anything). But a STICKY `interrupted` row
  // represents a stopped, human-resumable wake whose subprocess is already gone — it
  // must keep showing even after the connection drops offline, so the user can come
  // back and resume it. So keep interrupted rows regardless of connection liveness.
  return rows.filter(
    (r) =>
      r.status === INTERRUPTED_EXECUTION_STATUS || liveConnectionUuids.has(r.connectionUuid),
  );
}

/**
 * Is `connectionUuid` an effectively-ONLINE daemon connection right now (within
 * `companyUuid`)? Uses the same liveness verdict as the connection read API and
 * `filterRowsByLiveConnection`: raw `status === "online"` AND `lastSeenAt` within
 * `STALE_THRESHOLD_MS`. companyUuid-scoped; a READ that does NOT swallow.
 *
 * The resume route uses this to refuse a resume to an OFFLINE daemon: a `resume`
 * control command is a transient SSE event (not a persisted notification), so if the
 * daemon's stream is down the command is dropped and would never replay — leaving the
 * row flipped to `running` but invisible (the live-connection filter hides a
 * `running` row of an offline connection). Gating up front keeps the row `interrupted`
 * (still resumable later) and returns a clear error instead of silently losing it.
 */
export async function isConnectionLive(
  companyUuid: string,
  connectionUuid: string,
): Promise<boolean> {
  const conn = await prisma.daemonConnection.findFirst({
    where: { uuid: connectionUuid, companyUuid },
    select: { status: true, lastSeenAt: true },
  });
  if (!conn) return false;
  return conn.status === "online" && Date.now() - conn.lastSeenAt.getTime() <= STALE_THRESHOLD_MS;
}

/**
 * List the active (`running`/`queued`) execution rows visible to a caller,
 * scoped exactly like `daemon-connection.service`'s connection visibility:
 *  - a USER caller sees only execution for connections whose agent the user owns
 *    (`agent.ownerUuid === actorUuid`), and
 *  - an AGENT-KEY caller sees only its own connections' execution
 *    (`agentUuid === actorUuid`),
 * every query companyUuid-scoped. Execution for an agent owned by a different
 * user — or in a different company — is never returned. No new permission bit.
 *
 * Returns only active rows whose connection is currently effectively ONLINE
 * (`ended` history excluded by the query; rows of an offline/stale connection
 * excluded by the staleness gate), ordered running-first then most-recently-
 * updated.
 */
export async function getVisibleExecutions(
  auth: { type: string; companyUuid: string; actorUuid: string },
): Promise<ExecutionView[]> {
  // Owner-scope (user/super_admin) vs self-scope (agent key) — identical to
  // listConnectionsForOwner / listConnectionsForAgent in daemon-connection.
  const scope =
    auth.type === "agent"
      ? { agentUuid: auth.actorUuid }
      : { agent: { ownerUuid: auth.actorUuid } };

  const rows = await prisma.daemonExecution.findMany({
    where: {
      companyUuid: auth.companyUuid,
      status: { in: [...DISPLAYABLE_EXECUTION_STATUSES] },
      ...scope,
    },
  });

  const live = await filterRowsByLiveConnection(auth.companyUuid, rows);
  const enrichment = await enrichExecutionViews(auth.companyUuid, live);
  return sortExecutionViews(live.map((r) => toExecutionView(r, enrichment)));
}

/**
 * List the active execution rows for a single connection, companyUuid-scoped.
 * Used by the per-connection read (first paint of the detail pane) once the
 * connection's visibility has been established by the caller. Returns only
 * active rows whose connection is currently effectively ONLINE (a stale/offline
 * connection yields an empty active set per the offline rule), ordered
 * running-first then most-recently-updated.
 */
export async function getExecutionsForConnection(
  companyUuid: string,
  connectionUuid: string,
): Promise<ExecutionView[]> {
  const rows = await prisma.daemonExecution.findMany({
    where: {
      companyUuid,
      connectionUuid,
      status: { in: [...DISPLAYABLE_EXECUTION_STATUSES] },
    },
  });
  const live = await filterRowsByLiveConnection(companyUuid, rows);
  const enrichment = await enrichExecutionViews(companyUuid, live);
  return sortExecutionViews(live.map((r) => toExecutionView(r, enrichment)));
}

/**
 * Order the projected views running-first (so the actively-executing resource
 * leads the detail pane), then by `updatedAt` desc. Sorts a copy; does not mutate
 * the input.
 */
function sortExecutionViews(views: ExecutionView[]): ExecutionView[] {
  return [...views].sort((a, b) => {
    if (a.status !== b.status) {
      // "running" sorts before "queued"; anything else after.
      if (a.status === "running") return -1;
      if (b.status === "running") return 1;
    }
    return b.updatedAt.localeCompare(a.updatedAt);
  });
}

// ===== Authorization fence + entity validation (ingest path) =====

/**
 * Ownership fence for the ingest endpoint: does `connectionUuid` name a
 * `DaemonConnection` that belongs to `agentUuid` within `companyUuid`?
 *
 * The route uses this to return 404 (not 403) for a connection the authenticated
 * agent does not own — a 403 would confirm the connection exists, leaking another
 * agent's connection. A connection that does not exist, exists in another company,
 * or belongs to a different agent all yield the same `false`, so the negative
 * cases are indistinguishable from the caller's side.
 *
 * This is a READ; like the registry's read functions it does NOT swallow — a
 * query failure propagates so the route surfaces a 500 rather than masquerading
 * as "not found".
 */
export async function connectionBelongsToAgent(
  companyUuid: string,
  agentUuid: string,
  connectionUuid: string,
): Promise<boolean> {
  const count = await prisma.daemonConnection.count({
    where: { uuid: connectionUuid, companyUuid, agentUuid },
  });
  return count > 0;
}

/**
 * Visibility fence for the first-paint READ path, mirroring the connection
 * registry's owner/self scoping (and `getVisibleExecutions`):
 *  - an AGENT-KEY caller sees a connection only if it is its own
 *    (`agentUuid === actorUuid`), and
 *  - a USER / super_admin caller sees a connection only if its owning agent is
 *    owned by the caller (`agent.ownerUuid === actorUuid`),
 * every query companyUuid-scoped. Returns `false` for a connection that does not
 * exist, lives in another company, or belongs to an agent the caller does not
 * own — so the read route returns the same 404 in every negative case without
 * revealing another caller's connection. A READ that does NOT swallow.
 */
export async function connectionVisibleToCaller(
  auth: { type: string; companyUuid: string; actorUuid: string },
  connectionUuid: string,
): Promise<boolean> {
  const scope =
    auth.type === "agent"
      ? { agentUuid: auth.actorUuid }
      : { agent: { ownerUuid: auth.actorUuid } };
  const count = await prisma.daemonConnection.count({
    where: { uuid: connectionUuid, companyUuid: auth.companyUuid, ...scope },
  });
  return count > 0;
}

/**
 * List the uuids of the daemon connections visible to a caller, using the SAME
 * owner/self scoping as `connectionVisibleToCaller` / `getVisibleExecutions`:
 *  - an AGENT-KEY caller sees only its own connections (`agentUuid === actorUuid`),
 *  - a USER / super_admin caller sees only connections whose owning agent it owns
 *    (`agent.ownerUuid === actorUuid`),
 * every query companyUuid-scoped.
 *
 * The SSE route uses this at stream-start to decide which `execution:{uuid}`
 * EventBus channels to subscribe to for forwarding to this browser — the
 * execution channel is per-connection, so the stream subscribes to exactly the
 * set the caller is allowed to see (never another owner's, never cross-company).
 * A late-appearing connection is picked up on the next stream (the page's
 * connection-list poll + EventSource reconnect re-resolve the visible set), which
 * matches the registry's slow-changing liveness cadence. A READ that does NOT
 * swallow — a query failure propagates.
 */
export async function listVisibleConnectionUuids(
  auth: { type: string; companyUuid: string; actorUuid: string },
): Promise<string[]> {
  const scope =
    auth.type === "agent"
      ? { agentUuid: auth.actorUuid }
      : { agent: { ownerUuid: auth.actorUuid } };
  const rows = await prisma.daemonConnection.findMany({
    where: { companyUuid: auth.companyUuid, ...scope },
    select: { uuid: true },
  });
  return rows.map((r) => r.uuid);
}

/**
 * Best-effort multi-tenancy filter on a snapshot body: return only the entries
 * whose referenced entity (and, when present, root idea) resolves within
 * `companyUuid`. An entry referencing an entity that does not exist or lives in
 * another company is DROPPED — not a reason to reject the whole snapshot.
 *
 * Why filter rather than all-or-nothing reject: the snapshot is authoritative
 * for the connection, so a single dead reference (e.g. a task deleted while the
 * daemon still has it in its registry) must not wedge the entire connection's
 * updates — including the part that would legitimately end other finished rows.
 * Dropping the dead entry lets the rest reconcile normally; the dropped entry,
 * being absent from what reconcile sees, is simply not persisted (and any prior
 * row for it ends via the absent-from-snapshot rule).
 *
 * A non-null `rootIdeaUuid` that does not resolve in-company is treated as a soft
 * miss: the entry is kept but its `rootIdeaUuid` is nulled (the row still belongs
 * to a valid entity; only its grouping anchor is unknown). companyUuid-scoped
 * reads that do NOT swallow — a query failure propagates to the route as a 500.
 */
export async function filterValidExecutionEntities(
  companyUuid: string,
  executions: SnapshotExecution[],
): Promise<SnapshotExecution[]> {
  if (executions.length === 0) return [];

  const byType = groupEntityUuidsByType(executions);

  // Resolve the existing entity uuids per kind, in-company.
  const existing: Record<ExecutionEntityType, Set<string>> = {
    task: new Set(),
    idea: new Set(),
    proposal: new Set(),
    document: new Set(),
    daemon_session: new Set(),
  };

  if (byType.task.length > 0) {
    const found = await prisma.task.findMany({
      where: { companyUuid, uuid: { in: byType.task } },
      select: { uuid: true },
    });
    existing.task = new Set(found.map((r) => r.uuid));
  }
  if (byType.idea.length > 0) {
    const found = await prisma.idea.findMany({
      where: { companyUuid, uuid: { in: byType.idea } },
      select: { uuid: true },
    });
    existing.idea = new Set(found.map((r) => r.uuid));
  }
  if (byType.proposal.length > 0) {
    const found = await prisma.proposal.findMany({
      where: { companyUuid, uuid: { in: byType.proposal } },
      select: { uuid: true },
    });
    existing.proposal = new Set(found.map((r) => r.uuid));
  }
  if (byType.document.length > 0) {
    const found = await prisma.document.findMany({
      where: { companyUuid, uuid: { in: byType.document } },
      select: { uuid: true },
    });
    existing.document = new Set(found.map((r) => r.uuid));
  }
  // An ad-hoc conversation execution is validated against the DaemonSession table
  // (company-scoped), NOT the four content tables. The daemon reports the conversation
  // by its BUSINESS key (`sessionId` — the same value it uses as the Claude `--resume`
  // anchor), so we match on `sessionId`, NOT the DaemonSession primary `uuid`. A reported
  // daemon_session whose sessionId does not resolve in-company is dropped like any other
  // dead reference — without wedging the rest of the snapshot.
  if (byType.daemon_session.length > 0) {
    const found = await prisma.daemonSession.findMany({
      where: { companyUuid, sessionId: { in: byType.daemon_session } },
      select: { sessionId: true },
    });
    existing.daemon_session = new Set(found.map((r) => r.sessionId));
  }

  // Root-idea anchors that resolve in-company (kept entries with a non-resolving
  // anchor have it nulled rather than being dropped).
  const rootIdeaUuids = [
    ...new Set(
      executions
        .map((e) => e.rootIdeaUuid)
        .filter((u): u is string => typeof u === "string" && u.length > 0),
    ),
  ];
  const validRootIdeas = new Set<string>();
  if (rootIdeaUuids.length > 0) {
    const found = await prisma.idea.findMany({
      where: { companyUuid, uuid: { in: rootIdeaUuids } },
      select: { uuid: true },
    });
    for (const r of found) validRootIdeas.add(r.uuid);
  }

  const kept: SnapshotExecution[] = [];
  for (const e of executions) {
    const type = e.entityType as ExecutionEntityType;
    if (!(EXECUTION_ENTITY_TYPES as readonly string[]).includes(e.entityType)) continue;
    if (!existing[type].has(e.entityUuid)) continue; // dead/foreign entity → drop
    const rootIdeaUuid =
      e.rootIdeaUuid && validRootIdeas.has(e.rootIdeaUuid) ? e.rootIdeaUuid : null;
    kept.push({ ...e, rootIdeaUuid });
  }
  return kept;
}

// ===== Interrupt / resume (子3) =====
//
// Interrupt and resume operate on the EXECUTION row (connection + entity), not on
// the Task domain model — the daemon executes task / idea / proposal / document
// wakes, so the interrupted state must be entity-generic. The kill itself happens
// in the daemon (control channel → process-killer); these functions only record the
// resulting state transition the daemon reports back.

/** Outcome of `resumeExecution` so the route maps a precise status code. */
export type ResumeExecutionResult =
  | { ok: true }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "not_resumable"; status: string; interruptedReason: string | null };

/**
 * Mark a connection's execution row for `(entityType, entityUuid)` as `interrupted`
 * with the given reason. Called (via the daemon's report-interrupt endpoint) after
 * a wake's subprocess exits in an interrupted/crashed state:
 *   - `user`  — an authorized user-requested interrupt (manually resumable), or
 *   - `crash` — an unexpected exit (auto-recovered via reconnect-backfill).
 *
 * Scoped to companyUuid + connectionUuid (the route fences the connection's
 * ownership first). Idempotent: re-reporting the same outcome is a no-op update.
 * Returns true when a row was updated, false when no matching active row exists
 * (e.g. the wake already ended) — the route maps false to 404. companyUuid-scoped;
 * a query failure propagates (no swallow).
 */
export async function reportExecutionInterrupt(
  companyUuid: string,
  connectionUuid: string,
  entityType: string,
  entityUuid: string,
  reason: InterruptReason,
): Promise<boolean> {
  const result = await prisma.daemonExecution.updateMany({
    where: { companyUuid, connectionUuid, entityType, entityUuid },
    data: { status: INTERRUPTED_EXECUTION_STATUS, interruptedReason: reason },
  });
  return result.count > 0;
}

/**
 * Resume a user-interrupted execution: the daemon re-dispatches the wake for the
 * entity, so this transitions the sticky `interrupted` row back to `running` and
 * clears `interruptedReason`. ONLY a row that is `interrupted` with
 * `interruptedReason === "user"` is resumable — a `crash` is auto-recovered by the
 * daemon's reconnect-backfill, never manually (q7=a). companyUuid + connectionUuid
 * scoped (the route fences ownership first). Returns a discriminated result so the
 * route maps not-found → 404 and not-resumable → 400. A query failure propagates.
 *
 * NOTE: the actual re-spawn of Claude is the daemon's job (it receives a resume
 * dispatch and continues via `claude --resume`); this only records the row's
 * transition so the UI reflects it immediately. The subsequent daemon snapshot
 * re-affirms `running` and clears the reason via the reconcile upsert.
 */
export async function resumeExecution(
  companyUuid: string,
  connectionUuid: string,
  entityType: string,
  entityUuid: string,
): Promise<ResumeExecutionResult> {
  const row = await prisma.daemonExecution.findFirst({
    where: { companyUuid, connectionUuid, entityType, entityUuid },
    select: { id: true, status: true, interruptedReason: true },
  });
  if (!row) return { ok: false, reason: "not_found" };
  if (row.status !== INTERRUPTED_EXECUTION_STATUS || row.interruptedReason !== "user") {
    return {
      ok: false,
      reason: "not_resumable",
      status: row.status,
      interruptedReason: row.interruptedReason,
    };
  }
  await prisma.daemonExecution.update({
    where: { id: row.id },
    data: {
      status: "running",
      interruptedReason: null,
      startedAt: new Date(),
    },
  });
  return { ok: true };
}

// ===== SSE event publish =====
//
// One publish helper, two callers: the ingest route (after a snapshot reconcile)
// and the SSE abort path (after an offline reconcile). Both converge on the same
// `execution:{connectionUuid}` channel so the page re-renders identically whether
// the change came from a new snapshot or from the connection going offline.

/** EventBus channel name for a connection's execution-state changes. */
export function executionEventName(connectionUuid: string): string {
  return `execution:${connectionUuid}`;
}

/**
 * Publish the connection's current active (`running`/`queued`) execution set on
 * the `execution:{connectionUuid}` EventBus channel. The `eventBus.emit` override
 * fans this out over the existing Redis channel for multi-instance deployments —
 * this is purely additive to the existing notification/presence/change events and
 * does not touch them.
 *
 * Re-reads the active set from the table (rather than trusting an in-memory list)
 * so the event payload always reflects the just-persisted state, including the
 * offline path where the active set is now empty.
 *
 * Fire-and-forget safe: it swallows + logs its own errors so a failing publish
 * (used on the SSE teardown path) can never throw into stream teardown, mirroring
 * the offline reconcile's regime. Returns nothing.
 */
export async function publishExecutionChange(
  companyUuid: string,
  connectionUuid: string,
): Promise<void> {
  try {
    const executions = await getExecutionsForConnection(companyUuid, connectionUuid);
    const event: ExecutionEvent = { companyUuid, connectionUuid, executions };
    eventBus.emit(executionEventName(connectionUuid), event);
  } catch (err) {
    const { default: logger } = await import("@/lib/logger");
    logger.error(
      { err, companyUuid, connectionUuid },
      "Failed to publish daemon execution change",
    );
  }
}
