// src/services/daemon-execution.service.ts
// Daemon Task Execution Service — persistence + reconciliation for the
// running/queued tasks a daemon connection reports, plus the owner/self-scoped
// read projection the Agent Connections page consumes.
//
// This sits on top of `daemon-connection.service` (the DaemonConnection registry
// and its exported STALE_THRESHOLD_MS) and does NOT re-model connections or
// re-derive the staleness rule. `DaemonTaskExecution` references a
// `DaemonConnection` by `connectionUuid` (weak ref, no DB FK — the execution row
// outlives the connection as history).
//
// Two reconcile entry points converge on one rule: a `running`/`queued` row that
// is no longer justified — absent from the latest snapshot (ingest path) or its
// connection effectively offline (disconnect/stale path) — transitions to the
// `ended` terminal state. Rows are never deleted: `ended` is history.

import { prisma } from "@/lib/prisma";
import { eventBus } from "@/lib/event-bus";
import { STALE_THRESHOLD_MS } from "@/services/daemon-connection.service";

// Re-export so callers that need the offline threshold import it from the
// execution service without reaching for a second constant — there is exactly
// one staleness threshold in the system and it lives in the connection registry.
export { STALE_THRESHOLD_MS };

// ===== Types =====

// The active (non-terminal) statuses a daemon reports for a task. `ended` is the
// terminal/history state and is never reported by a snapshot — it is only ever
// written by the reconcile logic (absent-from-snapshot or offline).
export const ACTIVE_EXECUTION_STATUSES = ["running", "queued"] as const;
export type ActiveExecutionStatus = (typeof ACTIVE_EXECUTION_STATUSES)[number];
export const ENDED_EXECUTION_STATUS = "ended" as const;

/**
 * One entry of an ingested snapshot — the daemon's report for a single task it is
 * currently running or has queued on a connection. `startedAt` is the daemon's
 * self-reported run start (display-only); null while merely queued.
 */
export interface SnapshotExecution {
  taskUuid: string;
  rootIdeaUuid?: string | null;
  status: ActiveExecutionStatus; // "running" | "queued" — never "ended"
  startedAt?: Date | null;
}

/**
 * Read projection of a `DaemonTaskExecution` row returned to callers of the read
 * API. Timestamps are ISO-8601 strings so the client renders elapsed/started
 * without re-touching Date objects across the wire.
 */
export interface ExecutionView {
  uuid: string;
  agentUuid: string;
  connectionUuid: string;
  taskUuid: string;
  rootIdeaUuid: string | null;
  status: string; // running | queued | ended
  startedAt: string | null; // ISO-8601
  createdAt: string; // ISO-8601
  updatedAt: string; // ISO-8601
  // Display enrichment, resolved on the read/publish path so the detail pane can
  // render a task title + a deep link without an extra round-trip per row. Null
  // when the referenced entity no longer resolves (e.g. a deleted task) — the UI
  // falls back to a localized placeholder. `projectUuid` is the task's project,
  // needed to build the `/projects/{projectUuid}/tasks/{taskUuid}` link.
  taskTitle: string | null;
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

// Subset of the DaemonTaskExecution row the mapper reads. Kept structural (not
// the Prisma generated type) so the mapper is trivially unit-testable with plain
// fixtures — mirrors the daemon-connection service's DaemonConnectionRow pattern.
interface DaemonTaskExecutionRow {
  uuid: string;
  agentUuid: string;
  connectionUuid: string;
  taskUuid: string;
  rootIdeaUuid: string | null;
  status: string;
  startedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

// Display enrichment looked up alongside the execution rows (task title +
// project for the link, root-idea title for the session label). Resolved in a
// batch by `enrichExecutionViews`, then folded into each view by the mapper.
interface ExecutionEnrichment {
  task: Map<string, { title: string; projectUuid: string }>;
  idea: Map<string, { title: string }>;
}

const EMPTY_ENRICHMENT: ExecutionEnrichment = {
  task: new Map(),
  idea: new Map(),
};

// ===== Helpers =====

function toExecutionView(
  row: DaemonTaskExecutionRow,
  enrichment: ExecutionEnrichment = EMPTY_ENRICHMENT,
): ExecutionView {
  const task = enrichment.task.get(row.taskUuid) ?? null;
  const idea = row.rootIdeaUuid ? enrichment.idea.get(row.rootIdeaUuid) ?? null : null;
  return {
    uuid: row.uuid,
    agentUuid: row.agentUuid,
    connectionUuid: row.connectionUuid,
    taskUuid: row.taskUuid,
    rootIdeaUuid: row.rootIdeaUuid,
    status: row.status,
    startedAt: row.startedAt ? row.startedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    taskTitle: task?.title ?? null,
    projectUuid: task?.projectUuid ?? null,
    rootIdeaTitle: idea?.title ?? null,
  };
}

/**
 * Batch-resolve the display enrichment for a set of execution rows: the title +
 * project of every referenced task (for the row label and deep link) and the
 * title of every referenced root idea (for the session label). Two queries total
 * regardless of row count, both companyUuid-scoped. A task/idea that no longer
 * resolves is simply absent from the map, and the mapper falls back to null so a
 * deleted entity degrades to a localized placeholder rather than throwing.
 */
async function enrichExecutionViews(
  companyUuid: string,
  rows: DaemonTaskExecutionRow[],
): Promise<ExecutionEnrichment> {
  const taskUuids = [...new Set(rows.map((r) => r.taskUuid))];
  const ideaUuids = [
    ...new Set(
      rows
        .map((r) => r.rootIdeaUuid)
        .filter((u): u is string => typeof u === "string" && u.length > 0),
    ),
  ];

  const taskMap = new Map<string, { title: string; projectUuid: string }>();
  const ideaMap = new Map<string, { title: string }>();

  if (taskUuids.length > 0) {
    const tasks = await prisma.task.findMany({
      where: { companyUuid, uuid: { in: taskUuids } },
      select: { uuid: true, title: true, projectUuid: true },
    });
    for (const t of tasks) {
      taskMap.set(t.uuid, { title: t.title, projectUuid: t.projectUuid });
    }
  }

  if (ideaUuids.length > 0) {
    const ideas = await prisma.idea.findMany({
      where: { companyUuid, uuid: { in: ideaUuids } },
      select: { uuid: true, title: true },
    });
    for (const i of ideas) {
      ideaMap.set(i.uuid, { title: i.title });
    }
  }

  return { task: taskMap, idea: ideaMap };
}

// ===== Reconcile (ingest path) =====

/**
 * Snapshot-authoritative reconcile of one connection's execution rows.
 *
 * The `executions` array is treated as the COMPLETE current state for
 * `connectionUuid`:
 *  - each reported task is upserted to its reported `running`/`queued` status
 *    (keyed on the unique `(connectionUuid, taskUuid)`), and
 *  - every existing `running`/`queued` row for that connection whose task is
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
  // 1. End every running/queued row for this connection whose task is absent
  //    from the snapshot. Done first so a task that moved off the snapshot is
  //    terminal before (and independent of) the upserts below.
  const reportedTaskUuids = executions.map((e) => e.taskUuid);
  const ended = await prisma.daemonTaskExecution.updateMany({
    where: {
      companyUuid,
      connectionUuid,
      status: { in: [...ACTIVE_EXECUTION_STATUSES] },
      taskUuid: { notIn: reportedTaskUuids },
    },
    data: { status: ENDED_EXECUTION_STATUS },
  });

  // 2. Upsert each reported task to its reported status. The unique
  //    (connectionUuid, taskUuid) guarantees a task appears at most once per
  //    connection — re-dispatch updates the existing row (queued → running →
  //    ended) rather than inserting a duplicate.
  for (const exec of executions) {
    await prisma.daemonTaskExecution.upsert({
      where: {
        connectionUuid_taskUuid: { connectionUuid, taskUuid: exec.taskUuid },
      },
      create: {
        companyUuid,
        agentUuid,
        connectionUuid,
        taskUuid: exec.taskUuid,
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
      },
    });
  }

  return ended.count + executions.length;
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
    const result = await prisma.daemonTaskExecution.updateMany({
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
  rows: DaemonTaskExecutionRow[],
): Promise<DaemonTaskExecutionRow[]> {
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
  return rows.filter((r) => liveConnectionUuids.has(r.connectionUuid));
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

  const rows = await prisma.daemonTaskExecution.findMany({
    where: {
      companyUuid: auth.companyUuid,
      status: { in: [...ACTIVE_EXECUTION_STATUSES] },
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
  const rows = await prisma.daemonTaskExecution.findMany({
    where: {
      companyUuid,
      connectionUuid,
      status: { in: [...ACTIVE_EXECUTION_STATUSES] },
    },
  });
  const live = await filterRowsByLiveConnection(companyUuid, rows);
  const enrichment = await enrichExecutionViews(companyUuid, live);
  return sortExecutionViews(live.map((r) => toExecutionView(r, enrichment)));
}

/**
 * Order the projected views running-first (so the actively-executing task leads
 * the detail pane), then by `updatedAt` desc. Sorts a copy; does not mutate the
 * input.
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
 * Validate that every `taskUuid` (and every non-null `rootIdeaUuid`) referenced
 * by a snapshot belongs to `companyUuid`. Returns `true` when all referenced
 * entities resolve within the company, `false` if any is missing or in another
 * company. An empty snapshot is trivially valid (`true`).
 *
 * This is the multi-tenancy fence on the snapshot body: even though the
 * connection is already proven to belong to the authenticated agent, the daemon
 * still reports raw task/root-idea uuids that must be confined to the same
 * company before they are persisted onto execution rows. Deduplicates uuids so a
 * task referenced twice is counted once. A READ that does NOT swallow — a query
 * failure propagates to the route as a 500.
 */
export async function validateExecutionEntities(
  companyUuid: string,
  executions: SnapshotExecution[],
): Promise<boolean> {
  const taskUuids = [...new Set(executions.map((e) => e.taskUuid))];
  const rootIdeaUuids = [
    ...new Set(
      executions
        .map((e) => e.rootIdeaUuid)
        .filter((u): u is string => typeof u === "string" && u.length > 0),
    ),
  ];

  if (taskUuids.length > 0) {
    const taskCount = await prisma.task.count({
      where: { companyUuid, uuid: { in: taskUuids } },
    });
    if (taskCount !== taskUuids.length) return false;
  }

  if (rootIdeaUuids.length > 0) {
    const ideaCount = await prisma.idea.count({
      where: { companyUuid, uuid: { in: rootIdeaUuids } },
    });
    if (ideaCount !== rootIdeaUuids.length) return false;
  }

  return true;
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
