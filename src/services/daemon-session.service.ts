// src/services/daemon-session.service.ts
// Daemon Session Service — the DURABLE conversation layer for a daemon's Claude
// session (子1 — daemon-session-conversation). Where `daemon-execution.service`
// models the *live* running/queued snapshot a connection reports (rows flip to
// `ended` when absent from the next snapshot), THIS module models a persistent
// conversation that OUTLIVES that: a `DaemonSession` keyed `(agentUuid, sessionId)`
// holds an ordered list of `DaemonSessionTurn` rows, one per wake — autonomous
// (task_assigned / mentioned / elaboration / resume) or human (human_instruction).
// Identity and history survive the holding connection going offline and the daemon
// restarting; a session is NEVER deleted merely because its connection dropped.
//
// This is the SINGLE chokepoint for two mutations — turn creation and turn status
// transitions — so it OWNS publishing the live-update SSE triggers (see "SSE
// contract" below). The route layer and the notification chokepoint call into here;
// no turn/session business logic lives in routes (service-layer convention).
//
// It reuses, never re-models:
//   - `lineage.service.resolveRootIdea` for `directIdeaUuid` resolution, and
//   - the connection registry's exported `STALE_THRESHOLD_MS` for the single
//     offline/staleness verdict used by `assertContinuable` (no second constant).
//
// Continuation is PINNED to the session's `originConnectionUuid`: a turn is only
// ever continued on the cwd/machine that holds the on-disk `claude --resume`
// transcript. An offline origin makes the session read-only (history still
// visible); it is NEVER re-routed to another connection of the same agent, because
// a resume against a different working directory would `No conversation found`.

import { prisma } from "@/lib/prisma";
import { eventBus } from "@/lib/event-bus";
import { resolveRootIdea, type LineageEntityType } from "@/services/lineage.service";
// The single offline/staleness verdict lives in the connection registry. Import it
// here (rather than restate the number) so producer (the SSE heartbeat that bumps
// lastSeenAt) and this consumer can never drift — exactly as the execution service
// re-exports it.
import { STALE_THRESHOLD_MS } from "@/services/daemon-connection.service";

// Re-export so callers that need the offline threshold can import it from the
// session service without reaching for a second constant — there is exactly one
// staleness threshold in the system and it lives in the connection registry.
export { STALE_THRESHOLD_MS };

// ===== Constants =====

// The wake kinds a turn can represent. Every wake — autonomous or human — is one
// turn, distinguished only by `trigger`. A non-conforming value is rejected at the
// route/chokepoint zod boundary, so the service can assume validity.
export const TURN_TRIGGERS = [
  "task_assigned",
  "mentioned",
  "elaboration",
  "elaboration_verified",
  "resume",
  "human_instruction",
] as const;
export type TurnTrigger = (typeof TURN_TRIGGERS)[number];

// A turn's lifecycle states, in strict forward order. The daemon advances a turn
// `pending → running → ended`; this service enforces that ordering (no skips, no
// backward transitions) in `advanceTurn`.
export const TURN_STATUSES = ["pending", "running", "ended"] as const;
export type TurnStatus = (typeof TURN_STATUSES)[number];

// The two session lifecycle states. A session is `active` until explicitly ended;
// it stays readable (its turns/transcript) regardless of state — `ended` is history,
// never a delete.
export const SESSION_STATUSES = ["active", "ended"] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

// The ONLY transcript message roles persisted. The daemon's stream-json carries
// tool-call / tool-result / thinking blocks too, but the ingest deliberately stores
// only `user`/`assistant` TEXT — bounding privacy exposure and keeping the stored
// transcript a clean human-readable conversation. A non-conforming role is dropped
// (filtered, not rejected — a tool block alongside text must not fail the whole
// upload) at the service boundary.
export const TRANSCRIPT_ROLES = ["user", "assistant"] as const;
export type TranscriptRole = (typeof TRANSCRIPT_ROLES)[number];

// Rolling-window cap: the maximum number of transcript messages RETAINED per session
// (across all of its turns). When an append pushes the session's stored count over
// this, the OLDEST messages are trimmed back to the cap — in application code, NOT a
// data-mutating migration (the spec forbids backfill/DML in migrations). A named
// constant so the bound is single-sourced and adjustable without touching call sites.
export const MAX_TRANSCRIPT_MESSAGES_PER_SESSION = 200;

// Conversation-naming helpers live in the dependency-light `daemon-session-naming`
// leaf module (so the execution service can reuse them without dragging in the
// notification/mention import graph). Re-exported here for callers that already import
// from this service.
export {
  CONVERSATION_NAME_MAX,
  conversationNameFromInstruction,
  getFirstInstructionBySessionUuid,
} from "@/services/daemon-session-naming";

// ===== Types =====

/**
 * Read projection of a `DaemonSession` row. Timestamps are ISO-8601 strings so the
 * client renders elapsed/last-active without re-touching Date objects across the
 * wire — mirrors `daemon-execution.service`'s `ExecutionView` shape.
 */
export interface SessionView {
  uuid: string;
  agentUuid: string;
  sessionId: string;
  directIdeaUuid: string | null;
  originConnectionUuid: string;
  status: string; // active | ended
  title: string | null;
  lastTurnAt: string; // ISO-8601
  createdAt: string; // ISO-8601
  updatedAt: string; // ISO-8601
}

/**
 * Read projection of a `DaemonSessionTurn` row, ordered by `seq` for a session's
 * transcript view. Timestamps are ISO-8601 strings (null while unset).
 */
export interface TurnView {
  uuid: string;
  sessionUuid: string;
  seq: number;
  trigger: string;
  promptText: string | null;
  status: string; // pending | running | ended
  executionUuid: string | null;
  startedAt: string | null; // ISO-8601
  endedAt: string | null; // ISO-8601
  createdAt: string; // ISO-8601
}

/**
 * Payload pushed on the per-session `transcript:{sessionUuid}` EventBus channel for
 * the "turn created" and "turn status changed" triggers (the transcript-append
 * trigger — a later task — reuses the SAME channel/payload shape). It carries the
 * `sessionUuid` so a subscriber can filter to the session it is viewing, a `trigger`
 * discriminator so the client knows which of the three SSE triggers fired, and the
 * affected `turn` so the client can patch exactly that row without a follow-up read.
 * The `companyUuid` is carried so the SSE route can enforce multi-tenancy before
 * forwarding (consistent with the change/presence/execution handlers, which drop
 * events from other companies).
 */
export interface TranscriptEvent {
  companyUuid: string;
  sessionUuid: string;
  // Which SSE trigger produced this event. `turn_created` and `turn_status_changed`
  // are owned by THIS service (the single chokepoint for those mutations);
  // `transcript_appended` is published by the transcript ingest endpoint (a later
  // task) on the same channel.
  trigger: "turn_created" | "turn_status_changed" | "transcript_appended";
  turn: TurnView;
  // The appended message tail. Carried ONLY on the `transcript_appended` trigger so a
  // viewer patches the affected turn's message list live without a follow-up read
  // (the round-trip the Tech Design's Risks section calls out). It REUSES the existing
  // `TranscriptMessageView` shape (`toTranscriptMessageView`) — no second message type.
  // For `turn_created` / `turn_status_changed` (no messages changed) it is an empty
  // array, so the field is always present and a consumer never branches on undefined.
  messages: TranscriptMessageView[];
}

// Subset of the DaemonSession row the mapper reads. Kept structural (not the Prisma
// generated type) so the mapper is trivially unit-testable with plain fixtures —
// mirrors the connection/execution services' row-interface pattern.
interface DaemonSessionRow {
  uuid: string;
  agentUuid: string;
  sessionId: string;
  directIdeaUuid: string | null;
  originConnectionUuid: string;
  status: string;
  title: string | null;
  lastTurnAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

interface DaemonSessionTurnRow {
  uuid: string;
  sessionUuid: string;
  seq: number;
  trigger: string;
  promptText: string | null;
  status: string;
  executionUuid: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
  createdAt: Date;
}

// ===== Helpers =====

function toSessionView(row: DaemonSessionRow): SessionView {
  return {
    uuid: row.uuid,
    agentUuid: row.agentUuid,
    sessionId: row.sessionId,
    directIdeaUuid: row.directIdeaUuid,
    originConnectionUuid: row.originConnectionUuid,
    status: row.status,
    title: row.title,
    lastTurnAt: row.lastTurnAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toTurnView(row: DaemonSessionTurnRow): TurnView {
  return {
    uuid: row.uuid,
    sessionUuid: row.sessionUuid,
    seq: row.seq,
    trigger: row.trigger,
    promptText: row.promptText,
    status: row.status,
    executionUuid: row.executionUuid,
    startedAt: row.startedAt ? row.startedAt.toISOString() : null,
    endedAt: row.endedAt ? row.endedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

// Owner-scope (user / super_admin) vs self-scope (agent key) — identical to
// `daemon-execution.service.getVisibleExecutions` / `connectionVisibleToCaller`:
//  - an AGENT-KEY caller sees only its own sessions (`agentUuid === actorUuid`),
//  - a USER / super_admin caller sees only sessions of agents it owns
//    (`agent.ownerUuid === actorUuid`),
// every query additionally companyUuid-scoped by the caller. No new permission bit.
function ownerScope(auth: {
  type: string;
  actorUuid: string;
}): { agentUuid: string } | { agent: { ownerUuid: string } } {
  return auth.type === "agent"
    ? { agentUuid: auth.actorUuid }
    : { agent: { ownerUuid: auth.actorUuid } };
}

// ===== SSE event publish =====
//
// One channel per conversation: `transcript:{sessionUuid}`. The spec's "SSE contract
// — three triggers, one channel" routes ALL live updates for a session here. This
// service owns triggers (1) turn created and (2) turn status changed; the transcript
// ingest endpoint (a later task) publishes trigger (3) append on the SAME channel
// using the SAME `transcriptEventName` helper and `TranscriptEvent` payload shape.

/** EventBus channel name for a daemon session's transcript/turn live updates. */
export function transcriptEventName(sessionUuid: string): string {
  return `transcript:${sessionUuid}`;
}

/**
 * Publish a transcript/turn event on the `transcript:{sessionUuid}` channel. The
 * `eventBus.emit` override fans this out over the existing Redis channel for
 * multi-instance deployments — purely additive to the existing notification /
 * presence / execution / control events, touching none of them.
 *
 * This is the internal publish used by `createPendingTurn` (trigger `turn_created`)
 * and `advanceTurn` (trigger `turn_status_changed`). Unlike the execution service's
 * fire-and-forget teardown publish, these fire on the request/mutation path: an emit
 * is synchronous and does not touch the DB, so there is nothing to swallow — a
 * failure in the in-memory emit would be a programming error, not a transient teardown
 * race.
 */
function publishTranscriptEvent(event: TranscriptEvent): void {
  eventBus.emit(transcriptEventName(event.sessionUuid), event);
}

// ===== Resolve / create session =====

/**
 * Resolve-or-create the `DaemonSession` for `(agentUuid, sessionId)`, the stable
 * conversation business key. `sessionId` is the `directIdeaUuid` for an idea-anchored
 * session or a server-generated uuid for an ad-hoc session; it is supplied by the
 * caller (the notification chokepoint), which is also where lineage is resolved.
 *
 * Upsert semantics on the `@@unique([agentUuid, sessionId])`:
 *  - CREATE stamps `originConnectionUuid` (the connection/cwd that owns the on-disk
 *    transcript) and `directIdeaUuid` (nullable) ONCE, at creation. Both are FIXED
 *    thereafter: a later wake on the same `(agent, session)` reuses the existing row
 *    and does NOT move the origin connection (continuation is cwd-bound) nor re-derive
 *    the direct idea.
 *  - UPDATE (the row already exists) re-affirms only `companyUuid` from the
 *    authenticated context (multi-tenancy: never trusted from the request body). It
 *    deliberately does NOT touch `originConnectionUuid` / `directIdeaUuid` — those are
 *    write-once. `lastTurnAt` is bumped by `createPendingTurn` (the turn write), not
 *    here, so a resolve without a turn does not falsely advance the conversation clock.
 *
 * `directIdeaUuid` may be passed pre-resolved by the caller; when omitted (or null) and
 * the session is being created, this still records null (ad-hoc). The companyUuid is
 * stamped on the row. A query failure propagates (a write that does NOT swallow — the
 * session must exist before a turn is appended to it).
 */
export async function resolveOrCreateSession(params: {
  companyUuid: string;
  agentUuid: string;
  sessionId: string;
  directIdeaUuid?: string | null;
  originConnectionUuid: string;
}): Promise<SessionView> {
  const row = await prisma.daemonSession.upsert({
    where: {
      agentUuid_sessionId: {
        agentUuid: params.agentUuid,
        sessionId: params.sessionId,
      },
    },
    create: {
      companyUuid: params.companyUuid,
      agentUuid: params.agentUuid,
      sessionId: params.sessionId,
      directIdeaUuid: params.directIdeaUuid ?? null,
      originConnectionUuid: params.originConnectionUuid,
      status: "active",
    },
    update: {
      // Re-affirm companyUuid from the authenticated context. originConnectionUuid
      // and directIdeaUuid are write-once — intentionally NOT updated here.
      companyUuid: params.companyUuid,
    },
  });
  return toSessionView(row);
}

/**
 * Resolve the `directIdeaUuid` for an entity via the shared lineage resolver, so the
 * notification chokepoint can derive a session's idea anchor without re-implementing
 * the multi-hop walk. Returns the direct idea uuid (the FIRST idea node on the
 * lineage), or null when the entity has no idea ancestor (a success, not an error —
 * the session is then ad-hoc and keyed on a server-generated uuid by the caller).
 * companyUuid-scoped via the lineage getters; a query failure propagates.
 */
export async function resolveDirectIdeaUuid(
  companyUuid: string,
  entityType: LineageEntityType,
  entityUuid: string,
): Promise<string | null> {
  const result = await resolveRootIdea(companyUuid, entityType, entityUuid);
  return result.directIdeaUuid;
}

// ===== Turn lifecycle =====

/**
 * Create a `pending` turn on a session — the SINGLE turn-creation chokepoint. Called
 * by the notification chokepoint (every wake) and by the instruction send path.
 *
 *  - Assigns a MONOTONIC per-session `seq`: max(existing seq) + 1, starting at 1 for
 *    the first turn. Computed from the table so it survives restarts (the
 *    `@@unique([sessionUuid, seq])` is the integrity backstop).
 *  - Sets `status = "pending"`, records `trigger` and (for `human_instruction`) the
 *    free-text `promptText` (null for autonomous triggers — the canonical instruction
 *    text lives HERE, the notification only carries a denormalized copy).
 *  - Bumps the session's `lastTurnAt` so the conversation list orders by recency.
 *  - PUBLISHES the `turn_created` SSE trigger on `transcript:{sessionUuid}` so any
 *    caller emits without remembering to (a 子3 viewer sees the new turn appear live).
 *
 * The session is looked up to obtain its companyUuid (for the event) and to fail
 * clearly if the sessionUuid does not resolve — a turn cannot exist without its
 * session. A query/write failure propagates (no silent swallow): a lost turn would
 * lose a wake.
 */
export async function createPendingTurn(params: {
  sessionUuid: string;
  trigger: TurnTrigger;
  promptText?: string | null;
  executionUuid?: string | null;
}): Promise<TurnView> {
  // The session must exist and carries the companyUuid the SSE event needs. (The
  // caller — the notification chokepoint — has just resolved/created it.)
  const session = await prisma.daemonSession.findUnique({
    where: { uuid: params.sessionUuid },
    select: { uuid: true, companyUuid: true },
  });
  if (!session) {
    throw new Error(`DaemonSession ${params.sessionUuid} not found`);
  }

  // Monotonic per-session seq = max(existing) + 1; 1 for the first turn. Ordering by
  // seq desc + take 1 reads the current max cheaply off the (sessionUuid, seq) unique.
  //
  // The read-then-write is NOT atomic, so two concurrent creates for the SAME session
  // (e.g. a task-assign and an @mention notification landing together, from separate
  // request handlers) can both read the same max and try the same seq. The
  // `@@unique([sessionUuid, seq])` rejects the loser with P2002 — we retry (re-reading
  // the max) instead of letting that turn be silently dropped. Bounded retries keep a
  // genuinely persistent failure from looping. Same session serializes its own wakes in
  // the daemon WakeQueue, so contention here is rare and resolves in one extra attempt.
  let row: Awaited<ReturnType<typeof prisma.daemonSessionTurn.create>> | null = null;
  const MAX_SEQ_ATTEMPTS = 5;
  for (let attempt = 0; attempt < MAX_SEQ_ATTEMPTS; attempt++) {
    const last = await prisma.daemonSessionTurn.findFirst({
      where: { sessionUuid: params.sessionUuid },
      orderBy: { seq: "desc" },
      select: { seq: true },
    });
    const seq = (last?.seq ?? 0) + 1;
    try {
      row = await prisma.daemonSessionTurn.create({
        data: {
          sessionUuid: params.sessionUuid,
          seq,
          trigger: params.trigger,
          promptText: params.promptText ?? null,
          status: "pending",
          executionUuid: params.executionUuid ?? null,
        },
      });
      break;
    } catch (e) {
      // P2002 = unique-constraint violation on (sessionUuid, seq): another create won
      // the race for this seq. Re-read the max and retry. Any other error propagates.
      const isSeqConflict =
        typeof e === "object" &&
        e !== null &&
        "code" in e &&
        (e as { code: string }).code === "P2002";
      if (isSeqConflict && attempt < MAX_SEQ_ATTEMPTS - 1) continue;
      throw e;
    }
  }
  if (!row) {
    // Exhausted retries — surface visibly (no silent drop), the caller's bridge logs it.
    throw new Error(
      `createPendingTurn: could not allocate a unique seq for session ${params.sessionUuid} after ${MAX_SEQ_ATTEMPTS} attempts`,
    );
  }

  // Bump the conversation clock so the session list orders by most-recent turn.
  await prisma.daemonSession.update({
    where: { uuid: params.sessionUuid },
    data: { lastTurnAt: new Date() },
  });

  const view = toTurnView(row);
  // Trigger (1): turn created. Owned here because this IS the single turn-creation
  // chokepoint — emit happens for every caller.
  publishTranscriptEvent({
    companyUuid: session.companyUuid,
    sessionUuid: params.sessionUuid,
    trigger: "turn_created",
    turn: view,
    // No messages changed on a turn-create — keep the field present (always-array
    // contract) so consumers never branch on undefined.
    messages: [],
  });
  return view;
}

/** Outcome of an attempted turn status transition, so the route maps a precise code. */
export type AdvanceTurnResult =
  | { ok: true; turn: TurnView }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "invalid_transition"; from: string; to: string };

// The single legal forward edge for each status. Enforces strict
// pending → running → ended with no skips and no backward moves. A status with no
// outgoing edge (`ended`) is terminal. Re-applying the SAME status is also rejected
// (an idempotent no-op would otherwise hide a double-report bug and re-emit SSE).
const NEXT_TURN_STATUS: Record<TurnStatus, TurnStatus | null> = {
  pending: "running",
  running: "ended",
  ended: null,
};

/**
 * Advance a turn through its lifecycle — the SINGLE turn-status chokepoint. Enforces
 * strict `pending → running → ended`: only the one legal forward edge from the turn's
 * current status is allowed; a skip (`pending → ended`), a backward move
 * (`running → pending`), or re-applying the same status is rejected as
 * `invalid_transition` and writes nothing. A turn that does not exist is `not_found`.
 *
 * On a legal transition it:
 *  - sets the new `status`, and optionally records `startedAt` (the daemon's spawn
 *    time, typically on → running), `endedAt` (subprocess exit, on → ended), and the
 *    weak `executionUuid` link to the live `DaemonExecution` row (recorded without
 *    altering execution-state reconcile semantics), and
 *  - PUBLISHES the `turn_status_changed` SSE trigger on `transcript:{sessionUuid}` so
 *    a viewer sees the turn flip pending → running → ended live, for any caller.
 *
 * A query/write failure propagates (no silent swallow). The session lookup supplies
 * the companyUuid the SSE event carries.
 */
export async function advanceTurn(
  turnUuid: string,
  status: TurnStatus,
  opts: { startedAt?: Date | null; endedAt?: Date | null; executionUuid?: string | null } = {},
): Promise<AdvanceTurnResult> {
  const turn = await prisma.daemonSessionTurn.findUnique({
    where: { uuid: turnUuid },
    select: { uuid: true, sessionUuid: true, status: true },
  });
  if (!turn) return { ok: false, reason: "not_found" };

  // The turn's persisted status must be a known lifecycle value to have a legal edge;
  // a foreign value (should never happen) has no outgoing edge → invalid_transition.
  const current = turn.status as TurnStatus;
  const legalNext = NEXT_TURN_STATUS[current] ?? null;
  if (status !== legalNext) {
    return { ok: false, reason: "invalid_transition", from: turn.status, to: status };
  }

  // Only the fields relevant to a transition are written; absent opts leave the
  // column untouched (so a → running transition need not clear endedAt, etc.).
  const data: {
    status: TurnStatus;
    startedAt?: Date | null;
    endedAt?: Date | null;
    executionUuid?: string | null;
  } = { status };
  if (opts.startedAt !== undefined) data.startedAt = opts.startedAt;
  if (opts.endedAt !== undefined) data.endedAt = opts.endedAt;
  if (opts.executionUuid !== undefined) data.executionUuid = opts.executionUuid;

  const updated = await prisma.daemonSessionTurn.update({
    where: { uuid: turnUuid },
    data,
  });

  // The session carries the companyUuid the SSE event needs. The turn was just updated
  // via its session FK, so the session always resolves; a missing one means a torn
  // write/data corruption — throw rather than emit a tenant-less event (companyUuid: "")
  // that a future 子3 SSE consumer's multi-tenancy fence could mishandle.
  const session = await prisma.daemonSession.findUnique({
    where: { uuid: turn.sessionUuid },
    select: { companyUuid: true },
  });
  if (!session) {
    throw new Error(
      `advanceTurn: session ${turn.sessionUuid} missing for just-updated turn ${turnUuid}`,
    );
  }

  const view = toTurnView(updated);
  // Trigger (2): turn status changed. Owned here because this IS the single
  // status-transition chokepoint — emit happens for every caller, every transition.
  publishTranscriptEvent({
    companyUuid: session.companyUuid,
    sessionUuid: turn.sessionUuid,
    trigger: "turn_status_changed",
    turn: view,
    // No messages changed on a status transition — empty tail (always-array contract).
    messages: [],
  });
  return { ok: true, turn: view };
}

// ===== Owner-scoped reads =====
//
// As with the connection/execution registries' read functions, these deliberately do
// NOT swallow-and-log to an empty list: a query failure propagates so the route
// surfaces a 500. An empty list MUST mean genuinely zero rows, not a hidden error.

/**
 * List the daemon sessions visible to a caller, scoped EXACTLY like
 * `daemon-execution.service.getVisibleExecutions`:
 *  - a USER / super_admin caller sees only sessions of agents it owns
 *    (`agent.ownerUuid === actorUuid`), and
 *  - an AGENT-KEY caller sees only its own sessions (`agentUuid === actorUuid`),
 * every query companyUuid-scoped. Sessions of an agent owned by a different user — or
 * in a different company — are never returned. No new permission bit.
 *
 * Ordered most-recent-conversation first (`lastTurnAt` desc). A READ that does NOT
 * swallow — a query failure propagates.
 */
export async function getVisibleSessions(auth: {
  type: string;
  companyUuid: string;
  actorUuid: string;
}): Promise<SessionView[]> {
  const rows = await prisma.daemonSession.findMany({
    where: { companyUuid: auth.companyUuid, ...ownerScope(auth) },
    orderBy: { lastTurnAt: "desc" },
  });
  return rows.map(toSessionView);
}

/**
 * List the turns of a single session, ordered by `seq`, applying the SAME owner/self
 * + companyUuid visibility fence as `getVisibleSessions`. The session is first
 * resolved under the caller's visibility scope; a session that does not exist, lives
 * in another company, or belongs to an agent the caller does not own all yield the
 * SAME `null` — so the read route returns one 404 in every negative case without
 * revealing another caller's session exists (non-disclosure, exactly like
 * `daemon-execution.service.connectionVisibleToCaller`).
 *
 * Returns `null` when the session is not visible (the route maps to 404), or the
 * ordered turn views (possibly empty) when it is. A READ that does NOT swallow.
 */
export async function getSessionTurns(
  auth: { type: string; companyUuid: string; actorUuid: string },
  sessionUuid: string,
): Promise<TurnView[] | null> {
  const session = await prisma.daemonSession.findFirst({
    where: { uuid: sessionUuid, companyUuid: auth.companyUuid, ...ownerScope(auth) },
    select: { uuid: true },
  });
  if (!session) return null; // not visible → 404 non-disclosure

  const turns = await prisma.daemonSessionTurn.findMany({
    where: { sessionUuid },
    orderBy: { seq: "asc" },
  });
  return turns.map(toTurnView);
}

/**
 * Lightweight visibility fence for the SSE transcript subscription: is `sessionUuid`
 * visible to this caller under the SAME owner/self + companyUuid scope as
 * `getSessionTurns` / `getSessionDetail`? Returns `true` only when the session exists,
 * is in the caller's company, AND belongs to an agent the caller may see (its own, for
 * an agent key; an owned agent's, for a user / super_admin). Returns `false` for a
 * non-existent / cross-company / non-owned session — the SAME negative verdict in every
 * case, so the SSE route can silently decline to subscribe without ever confirming a
 * session exists (non-disclosure, exactly like `getSessionTurns` returning `null`).
 *
 * Selects only `uuid` — it is a cheap existence-under-scope check, NOT a transcript load
 * (the route gates on visibility before subscribing; it never reads turns/messages just
 * to decide whether to forward live events). A READ that does NOT swallow — a query
 * failure propagates so the route surfaces a 500 before opening the stream.
 */
export async function isSessionVisibleToCaller(
  auth: { type: string; companyUuid: string; actorUuid: string },
  sessionUuid: string,
): Promise<boolean> {
  const session = await prisma.daemonSession.findFirst({
    where: { uuid: sessionUuid, companyUuid: auth.companyUuid, ...ownerScope(auth) },
    select: { uuid: true },
  });
  return session != null;
}

/**
 * A turn view carrying its retained `user`/`assistant` transcript messages, ordered
 * by `seq` within the turn. The per-message shape REUSES the existing
 * `TranscriptMessageView` (the ingest projection) — there is no second message type.
 * A turn whose messages were all trimmed by the rolling window appears here with an
 * empty `messages` array (still a turn, just no retained transcript).
 */
export interface TurnWithMessagesView extends TurnView {
  messages: TranscriptMessageView[];
}

// Default page size for the transcript read — measured in TURNS (the structural unit
// the chat renders as bands). A coding-agent session can be woken many times, so the
// transcript is paged newest-first and "load earlier" walks backward by `seq`; per-
// message volume is independently bounded by MAX_TRANSCRIPT_MESSAGES_PER_SESSION.
export const DEFAULT_TRANSCRIPT_TURN_PAGE = 30;

/**
 * Read projection for the single-session transcript route: the session plus a PAGE of
 * its ordered turns (each carrying its retained transcript messages), newest-first
 * windowed but returned in ascending `seq` order for top-to-bottom rendering. `hasMore`
 * is true when older turns exist before this page; `oldestSeq` is the `seq` of the
 * earliest turn in this page — the cursor a client passes as `beforeSeq` to load the
 * previous page. Both are null/false for an empty session.
 */
export interface SessionDetailView {
  session: SessionView;
  turns: TurnWithMessagesView[];
  hasMore: boolean;
  oldestSeq: number | null;
}

/**
 * Read a single session WITH its turns-and-messages, applying the SAME owner/self +
 * companyUuid visibility fence as `getSessionTurns` / `getVisibleSessions`. The
 * session is first resolved under the caller's visibility scope; a session that does
 * not exist, lives in another company, or belongs to an agent the caller does not own
 * all yield the SAME `null` — so the read route returns one 404 in every negative case
 * without revealing another caller's session exists (non-disclosure, exactly like
 * `getSessionTurns`).
 *
 * On a visible session it loads the turns ordered by `seq`, then loads ALL their
 * transcript messages in ONE batched query (`where: { turnUuid: { in: [...] } }`,
 * ordered by `(turnUuid, seq)`) and folds the messages into their turns IN MEMORY —
 * no N+1, exactly one extra query regardless of turn count (and zero when the session
 * has no turns). The per-message projection reuses `toTranscriptMessageView` (the
 * ingest path's mapper) and the `TranscriptMessageView` shape — no new message type.
 * Messages trimmed by the rolling-window cap are simply absent; a turn whose messages
 * were all trimmed still appears with an empty `messages` array.
 *
 * Returns `null` when the session is not visible (the route maps to 404), or the
 * `{ session, turns }` detail when it is. A READ that does NOT swallow — a query
 * failure propagates so the route surfaces a 500 (never a degraded empty transcript).
 */
export async function getSessionDetail(
  auth: { type: string; companyUuid: string; actorUuid: string },
  sessionUuid: string,
  // Pagination (newest-first window over TURNS): `limit` caps how many turns this page
  // returns (default DEFAULT_TRANSCRIPT_TURN_PAGE); `beforeSeq` loads the page of turns
  // strictly OLDER than that seq (the "load earlier" cursor). Omitting `beforeSeq` loads
  // the most recent page. A non-positive/oversized `limit` is clamped to a sane range.
  opts: { limit?: number; beforeSeq?: number | null } = {},
): Promise<SessionDetailView | null> {
  const sessionRow = await prisma.daemonSession.findFirst({
    where: { uuid: sessionUuid, companyUuid: auth.companyUuid, ...ownerScope(auth) },
  });
  if (!sessionRow) return null; // not visible → 404 non-disclosure

  // Clamp the page size: at least 1, at most 200 turns per page (a hard ceiling so a
  // hostile `limit` can't ask for an unbounded scan).
  const limit = Math.min(
    Math.max(1, Math.floor(opts.limit ?? DEFAULT_TRANSCRIPT_TURN_PAGE)),
    200,
  );
  const beforeSeq =
    typeof opts.beforeSeq === "number" && Number.isFinite(opts.beforeSeq)
      ? opts.beforeSeq
      : null;

  // Fetch the NEWEST `limit` turns at or before the cursor: order by seq DESC, take
  // `limit + 1` so the extra row tells us whether an OLDER page exists (hasMore) without
  // a separate count query. Then reverse to ascending for top-to-bottom rendering.
  const pageDesc = await prisma.daemonSessionTurn.findMany({
    where: {
      sessionUuid,
      ...(beforeSeq !== null ? { seq: { lt: beforeSeq } } : {}),
    },
    orderBy: { seq: "desc" },
    take: limit + 1,
  });
  const hasMore = pageDesc.length > limit;
  const pageTurns = (hasMore ? pageDesc.slice(0, limit) : pageDesc).reverse(); // ascending

  // Load this page's turns' messages in ONE batched query, then fold in memory — no
  // N+1. An empty page needs no message query at all.
  const turnUuids = pageTurns.map((t) => t.uuid);
  const messages =
    turnUuids.length > 0
      ? await prisma.daemonTranscriptMessage.findMany({
          where: { turnUuid: { in: turnUuids } },
          orderBy: [{ turnUuid: "asc" }, { seq: "asc" }],
        })
      : [];

  // Bucket the messages by their turnUuid so each turn gets exactly its own messages
  // in seq order (the query already ordered by (turnUuid, seq), so each bucket is in
  // seq order as appended). A turn with no retained messages keeps an empty array.
  const messagesByTurn = new Map<string, TranscriptMessageView[]>();
  for (const m of messages) {
    const view = toTranscriptMessageView(m);
    const bucket = messagesByTurn.get(view.turnUuid);
    if (bucket) bucket.push(view);
    else messagesByTurn.set(view.turnUuid, [view]);
  }

  const turnsWithMessages: TurnWithMessagesView[] = pageTurns.map((t) => ({
    ...toTurnView(t),
    messages: messagesByTurn.get(t.uuid) ?? [],
  }));

  return {
    session: toSessionView(sessionRow),
    turns: turnsWithMessages,
    hasMore,
    oldestSeq: turnsWithMessages.length > 0 ? turnsWithMessages[0].seq : null,
  };
}

// ===== Continuation pinning =====

/** Outcome of `assertContinuable` so the caller maps a precise status code. */
export type ContinuableResult =
  | { ok: true; originConnectionUuid: string }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "origin_offline"; originConnectionUuid: string };

/**
 * The read-only error thrown when a session's origin connection is offline. A
 * continuation (a new turn dispatched to the session) requires `claude --resume
 * <sessionId>` in the SAME cwd on the SAME machine — i.e. the session's
 * `originConnectionUuid` must be effectively ONLINE. When it is not, the session is
 * READ-ONLY (its history stays visible) and the turn is NEVER routed to another
 * connection of the same agent. Callers (子2's send box) surface this as a disabled
 * input; the message is intentionally clear about why.
 */
export class SessionReadOnlyError extends Error {
  readonly code = "session_read_only";
  readonly originConnectionUuid: string;
  constructor(originConnectionUuid: string) {
    super(
      "This session is read-only: its origin connection is offline. " +
        "A daemon session can only be continued on the connection that holds its " +
        "on-disk transcript (claude --resume is cwd/machine-bound), so it is never " +
        "routed to another connection.",
    );
    this.name = "SessionReadOnlyError";
    this.originConnectionUuid = originConnectionUuid;
  }
}

/**
 * Assert that a session can be CONTINUED — i.e. a new turn may be dispatched to it.
 * Resolves the session's FIXED `originConnectionUuid` and checks that connection is
 * effectively ONLINE using the SAME verdict the connection read API renders:
 * `status === "online" && now - lastSeenAt <= STALE_THRESHOLD_MS` (the registry's
 * single staleness threshold, reused — NOT a new constant). It NEVER considers any
 * other connection of the same agent: continuation is pinned to the origin, full stop.
 *
 * Throws `SessionReadOnlyError` when the origin is offline/stale (the caller renders a
 * read-only / origin-offline error and does not route elsewhere). Throws a plain
 * not-found Error when the session does not resolve in-company. companyUuid-scoped; a
 * READ that does NOT swallow.
 *
 * Returns the resolved `originConnectionUuid` on success so the dispatch path targets
 * exactly that connection (and only that one).
 */
export async function assertContinuable(
  companyUuid: string,
  sessionUuid: string,
): Promise<string> {
  const session = await prisma.daemonSession.findFirst({
    where: { uuid: sessionUuid, companyUuid },
    select: { originConnectionUuid: true },
  });
  if (!session) {
    throw new Error(`DaemonSession ${sessionUuid} not found`);
  }

  const conn = await prisma.daemonConnection.findFirst({
    where: { uuid: session.originConnectionUuid, companyUuid },
    select: { status: true, lastSeenAt: true },
  });
  const online =
    conn != null &&
    conn.status === "online" &&
    Date.now() - conn.lastSeenAt.getTime() <= STALE_THRESHOLD_MS;
  if (!online) {
    // Read-only: origin offline. NEVER route to another connection.
    throw new SessionReadOnlyError(session.originConnectionUuid);
  }
  return session.originConnectionUuid;
}

// ===== Transcript ingest (append, text-only, rolling-window) =====
//
// The per-turn transcript relay. Where `daemon-execution.service.reconcileSnapshot`
// treats its body as the AUTHORITATIVE full state (rows flip to `ended` when absent),
// transcript ingest has APPEND semantics: each call ADDS messages to a turn and never
// removes a message because it was absent from this call. The only removal is the
// rolling-window trim (oldest-first) once the session's retained count exceeds
// `MAX_TRANSCRIPT_MESSAGES_PER_SESSION` — done here in application code, not a
// migration. Only `user`/`assistant` text survives the filter; tool-call /
// tool-result / thinking content is dropped (not stored). After a successful append it
// publishes the `transcript_appended` trigger on the SAME `transcript:{sessionUuid}`
// channel the turn-create/turn-status-change triggers use (one channel per
// conversation), additive to the existing notification/presence/execution events.

/**
 * A single inbound transcript message from the daemon. `role` is constrained to the
 * persisted roles at the route's zod boundary; any other role (tool/thinking) is
 * filtered out by the service rather than reaching this type. `text` is the plain
 * message body — empty/blank text is dropped (no empty rows persisted).
 */
export interface InboundTranscriptMessage {
  role: TranscriptRole;
  text: string;
}

/**
 * Read projection of a persisted `DaemonTranscriptMessage`, ordered within a turn by
 * `seq`. Returned to a viewer (子3) and echoed back from the ingest so the caller can
 * confirm what landed. `createdAt` is an ISO-8601 string across the wire.
 */
export interface TranscriptMessageView {
  uuid: string;
  turnUuid: string;
  role: string; // user | assistant
  text: string;
  seq: number;
  createdAt: string; // ISO-8601
}

interface DaemonTranscriptMessageRow {
  uuid: string;
  turnUuid: string;
  role: string;
  text: string;
  seq: number;
  createdAt: Date;
}

function toTranscriptMessageView(row: DaemonTranscriptMessageRow): TranscriptMessageView {
  return {
    uuid: row.uuid,
    turnUuid: row.turnUuid,
    role: row.role,
    text: row.text,
    seq: row.seq,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Outcome of an attempted transcript append, so the route maps a precise status code.
 * `not_found` is the SINGLE negative verdict for every non-disclosure case — the turn
 * does not exist, the session does not exist, or either belongs to a different
 * agent/company — so the route returns one 404 without revealing another agent's
 * session/turn exists (mirrors `daemon-execution.service.connectionBelongsToAgent`).
 */
export type AppendTranscriptResult =
  | { ok: true; appended: number; stored: number; messages: TranscriptMessageView[] }
  | { ok: false; reason: "not_found" };

// Keep only persistable messages: a recognized `user`/`assistant` role AND non-blank
// text. Tool-call / tool-result / thinking entries (any other role) are dropped, as is
// an empty/whitespace-only body — text-only, no empty rows. The route's zod schema
// already constrains `role`, but this is the service-level backstop so the filtering
// invariant holds regardless of caller.
function filterPersistableMessages(
  messages: InboundTranscriptMessage[],
): InboundTranscriptMessage[] {
  return messages.filter(
    (m) =>
      (TRANSCRIPT_ROLES as readonly string[]).includes(m.role) &&
      typeof m.text === "string" &&
      m.text.trim().length > 0,
  );
}

/**
 * Append transcript messages to one turn of a session the authenticated agent owns.
 *
 * Resolution: EXACTLY one of `turnUuid` / `sessionId` identifies the target turn —
 *  - `turnUuid` appends to that specific turn (the daemon's normal path: it knows the
 *    turn it is executing), after verifying the turn's session belongs to the agent
 *    within its company; or
 *  - `sessionId` (the conversation business key — `directIdeaUuid` or the ad-hoc uuid,
 *    NOT the session's `uuid`) resolves the agent's `(agentUuid, sessionId)` session
 *    and appends to its most-recent turn (highest `seq`).
 * Every negative case (unknown turn/session, foreign agent, cross-company, or a session
 * with no turn yet) yields the SAME `not_found` so the route is non-disclosing.
 *
 * Append semantics: messages are filtered to `user`/`assistant` text, then inserted
 * with a monotonic per-turn `seq` (max existing + 1, in order). Nothing is removed for
 * being absent from this call.
 *
 * Rolling-window trim: after insert, if the SESSION's total retained message count
 * exceeds `MAX_TRANSCRIPT_MESSAGES_PER_SESSION`, the oldest messages (across the
 * session's turns, ordered by createdAt then seq) are deleted back to the cap — in
 * application code. No migration mutates data.
 *
 * On success it publishes the `transcript_appended` trigger on
 * `transcript:{sessionUuid}` carrying the turn view, so a 子3 viewer patches that turn
 * live. A query/write failure propagates (no silent swallow): a lost transcript append
 * loses conversation history. An all-filtered (no persistable messages) call is a
 * success that appends 0 and does NOT emit (no change to show).
 */
export async function appendTranscriptMessages(params: {
  companyUuid: string;
  agentUuid: string;
  turnUuid?: string | null;
  sessionId?: string | null;
  messages: InboundTranscriptMessage[];
}): Promise<AppendTranscriptResult> {
  // Resolve the target turn under the caller's ownership scope. Both paths fence on
  // the authenticated company + agent so a turn/session of another agent (or another
  // company) is indistinguishable from a non-existent one.
  let turn: { uuid: string; sessionUuid: string } | null = null;

  if (params.turnUuid) {
    // turnUuid path: the turn must exist AND its session must belong to this agent in
    // this company. A single owner-scoped query over the relation enforces both.
    const row = await prisma.daemonSessionTurn.findFirst({
      where: {
        uuid: params.turnUuid,
        session: { agentUuid: params.agentUuid, companyUuid: params.companyUuid },
      },
      select: { uuid: true, sessionUuid: true },
    });
    turn = row;
  } else if (params.sessionId) {
    // sessionId path: resolve the agent's own session by the (agentUuid, sessionId)
    // business key, then target its most-recent turn.
    const session = await prisma.daemonSession.findFirst({
      where: {
        agentUuid: params.agentUuid,
        companyUuid: params.companyUuid,
        sessionId: params.sessionId,
      },
      select: { uuid: true },
    });
    if (session) {
      // Attach transcript to the turn actively producing output — the `running` turn —
      // rather than the highest-seq turn. Under the per-session WakeQueue at most one
      // turn runs at a time, so this is unambiguous; targeting most-recent seq could
      // mis-attach a running turn's output to a newer `pending` turn created mid-run
      // (the transcript variant of the advanceTurnForWake fix). Fall back to the most-
      // recent turn when none is `running` (e.g. a late flush just after the turn ended),
      // so trailing lines still land on the turn they belong to.
      const running = await prisma.daemonSessionTurn.findFirst({
        where: { sessionUuid: session.uuid, status: "running" },
        orderBy: { seq: "asc" },
        select: { uuid: true, sessionUuid: true },
      });
      turn =
        running ??
        (await prisma.daemonSessionTurn.findFirst({
          where: { sessionUuid: session.uuid },
          orderBy: { seq: "desc" },
          select: { uuid: true, sessionUuid: true },
        }));
    }
  }

  if (!turn) return { ok: false, reason: "not_found" }; // non-disclosure 404

  const sessionUuid = turn.sessionUuid;

  // Text-only filter: drop tool/thinking and empty bodies. An all-dropped upload is a
  // valid no-op append (success, 0 appended) — it must not 4xx.
  const persistable = filterPersistableMessages(params.messages);

  let appendedViews: TranscriptMessageView[] = [];
  if (persistable.length > 0) {
    // Monotonic per-turn seq = max(existing) + 1, then increment per message so a
    // multi-message batch keeps insertion order within the turn.
    const last = await prisma.daemonTranscriptMessage.findFirst({
      where: { turnUuid: turn.uuid },
      orderBy: { seq: "desc" },
      select: { seq: true },
    });
    let nextSeq = (last?.seq ?? 0) + 1;

    const created: DaemonTranscriptMessageRow[] = [];
    for (const msg of persistable) {
      const row = await prisma.daemonTranscriptMessage.create({
        data: {
          turnUuid: turn.uuid,
          role: msg.role,
          text: msg.text,
          seq: nextSeq,
        },
      });
      created.push(row);
      nextSeq += 1;
    }
    appendedViews = created.map(toTranscriptMessageView);

    // Rolling-window trim, in application code (no migration). Count the session's
    // retained messages across all its turns; if over the cap, delete the oldest
    // (createdAt asc, then seq asc as a stable tiebreak) back down to the cap.
    await trimSessionTranscript(sessionUuid);
  }

  const stored = await prisma.daemonTranscriptMessage.count({
    where: { turn: { sessionUuid } },
  });

  // Publish trigger (3): transcript appended — only when something actually changed,
  // so a no-op (all-filtered) call does not wake viewers for nothing.
  if (appendedViews.length > 0) {
    const turnRow = await prisma.daemonSessionTurn.findUnique({
      where: { uuid: turn.uuid },
    });
    const session = await prisma.daemonSession.findUnique({
      where: { uuid: sessionUuid },
      select: { companyUuid: true },
    });
    if (turnRow) {
      publishTranscriptEvent({
        companyUuid: session?.companyUuid ?? params.companyUuid,
        sessionUuid,
        trigger: "transcript_appended",
        turn: toTurnView(turnRow),
        // Carry the appended message tail on the wire so a viewer patches the turn's
        // message list live without re-fetching the open session (the round-trip the
        // Tech Design's Risks section prefers to avoid). These are the SAME
        // `TranscriptMessageView`s already produced above (`toTranscriptMessageView`) —
        // no new message shape, and identical to what the read route returns.
        messages: appendedViews,
      });
    }
  }

  return { ok: true, appended: appendedViews.length, stored, messages: appendedViews };
}

/**
 * Trim a session's transcript to the rolling-window cap. Counts the messages retained
 * across ALL of the session's turns; if the count exceeds
 * `MAX_TRANSCRIPT_MESSAGES_PER_SESSION`, deletes the oldest overflow (ordered by
 * createdAt asc, then seq asc for a stable tiebreak within the same timestamp) so the
 * retained count returns to exactly the cap. Application-code trim — there is NO
 * data-mutating migration. A no-op when already within the cap. companyUuid-agnostic
 * (the session uuid already scopes it); a query/write failure propagates.
 */
async function trimSessionTranscript(sessionUuid: string): Promise<void> {
  const total = await prisma.daemonTranscriptMessage.count({
    where: { turn: { sessionUuid } },
  });
  const overflow = total - MAX_TRANSCRIPT_MESSAGES_PER_SESSION;
  if (overflow <= 0) return;

  // Oldest `overflow` messages across the session's turns. Tiebreak on the globally-
  // monotonic autoincrement `id`, NOT the per-turn `seq` (which resets to 1 each turn):
  // two messages in different turns can share a `createdAt` millisecond, and a per-turn
  // seq tiebreak could then delete a newer turn's message before an older turn's. `id`
  // is insertion-monotonic across the whole table, making oldest-first deterministic.
  const oldest = await prisma.daemonTranscriptMessage.findMany({
    where: { turn: { sessionUuid } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: overflow,
    select: { uuid: true },
  });
  if (oldest.length === 0) return;
  await prisma.daemonTranscriptMessage.deleteMany({
    where: { uuid: { in: oldest.map((m) => m.uuid) } },
  });
}

// ===== Daemon-driven turn advance (by session business key) =====
//
// The daemon advances a turn's lifecycle (`pending → running → ended`) over a REST
// write surface — it does NOT know the server-side `turnUuid`. Instead it identifies
// the turn the SAME way the transcript ingest's `sessionId` path does: by the agent's
// `(agentUuid, sessionId)` session business key (`sessionId` = the `directIdeaUuid`
// for an idea-anchored session, or the entity uuid for an ad-hoc one — exactly the
// deterministic Claude session anchor the daemon already computes in `waker.wake`).
// The most-recent turn (highest `seq`) of that session is the one being executed.
//
// This composes (never reimplements) `advanceTurn`, so the strict
// `pending → running → ended` ordering and the `turn_status_changed` SSE publish are
// enforced in the single chokepoint. The only addition here is RESOLUTION — finding
// the right turn from a business key the daemon owns — plus stamping the weak
// `executionUuid` link (resolved from the live `DaemonExecution` row for
// `(connection, entity)`) when the caller supplies an entity, so the conversation turn
// and the execution snapshot row are linked without the daemon needing to learn the
// server-generated execution uuid.

/**
 * Outcome of a daemon-driven turn advance, so the route maps a precise status code.
 * `not_found` is the SINGLE non-disclosure verdict (no session for this agent, or the
 * session has no turn yet) — the route returns one 404 without revealing whether
 * another agent's session exists, mirroring the transcript ingest.
 */
export type AdvanceTurnForWakeResult =
  | { ok: true; turn: TurnView }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "invalid_transition"; from: string; to: string };

/**
 * Advance the most-recent turn of the agent's `(agentUuid, sessionId)` session to
 * `status`, scoped to the authenticated agent within its company. Resolution mirrors
 * `appendTranscriptMessages`' sessionId path (own session → its highest-`seq` turn);
 * a session that does not resolve for this agent, or that has no turn yet, yields
 * `not_found` (non-disclosure). The transition itself goes through `advanceTurn`, so
 * an illegal transition surfaces as `invalid_transition` (the route maps it to a 409)
 * rather than silently succeeding.
 *
 * When `entityType`/`entityUuid` are supplied AND the live `DaemonExecution` row for
 * `(companyUuid, connectionUuid, entity)` resolves, its uuid is stamped onto the turn
 * as the weak `executionUuid` link — recorded WITHOUT touching execution-state
 * reconcile semantics. `startedAt`/`endedAt` default to the transition time for the
 * `running`/`ended` edges respectively (the daemon's spawn/exit moment) unless the
 * caller passes explicit timestamps. A query/write failure propagates (no swallow):
 * a lost transition would strand a turn's lifecycle.
 */
export async function advanceTurnForWake(params: {
  companyUuid: string;
  agentUuid: string;
  connectionUuid: string;
  sessionId: string;
  status: TurnStatus;
  entityType?: string | null;
  entityUuid?: string | null;
  startedAt?: Date | null;
  endedAt?: Date | null;
}): Promise<AdvanceTurnForWakeResult> {
  // Resolve the agent's OWN session by its business key (company + agent fenced).
  const session = await prisma.daemonSession.findFirst({
    where: {
      agentUuid: params.agentUuid,
      companyUuid: params.companyUuid,
      sessionId: params.sessionId,
    },
    select: { uuid: true },
  });
  if (!session) return { ok: false, reason: "not_found" }; // non-disclosure 404

  // Resolve the turn being executed by STATUS, not by most-recent seq. The daemon only
  // ever drives `running` (on spawn) and `ended` (on subprocess exit), and same-session
  // wakes are strictly serialized in the daemon's per-(agent,session) WakeQueue — so at
  // most one turn is mid-flight at a time. Targeting "most-recent seq" was wrong: if a
  // second wake created a newer `pending` turn while the current one was still running,
  // the running turn's `→ended` would mis-target the newer pending turn (rejected as an
  // invalid transition), stranding the real turn `running` forever. Status-based FIFO
  // resolution fixes that without the daemon needing to learn the server turn uuid:
  //   • → running : the OLDEST still-`pending` turn (the next queued wake to start).
  //   • → ended   : the `running` turn (the one whose subprocess just exited).
  // For any other target status, fall back to the oldest turn in the prior state.
  const fromStatus =
    params.status === "running" ? "pending" : params.status === "ended" ? "running" : null;
  const turn = await prisma.daemonSessionTurn.findFirst({
    where: {
      sessionUuid: session.uuid,
      ...(fromStatus ? { status: fromStatus } : {}),
    },
    // Oldest-first so a `→running` advance picks up the next queued turn in FIFO order.
    orderBy: { seq: "asc" },
    select: { uuid: true },
  });
  if (!turn) return { ok: false, reason: "not_found" };

  // Weak executionUuid link: resolve the live DaemonExecution row for this
  // connection + entity (when the caller named one). Recorded on the turn without
  // altering execution-state reconcile semantics. A missing row is fine — the link is
  // optional and a queued/ended execution may simply not be present.
  let executionUuid: string | null | undefined;
  if (params.entityType && params.entityUuid) {
    const execution = await prisma.daemonExecution.findFirst({
      where: {
        companyUuid: params.companyUuid,
        connectionUuid: params.connectionUuid,
        entityType: params.entityType,
        entityUuid: params.entityUuid,
      },
      select: { uuid: true },
    });
    executionUuid = execution?.uuid ?? null;
  }

  // Default the lifecycle timestamps to the transition moment for the matching edge,
  // unless the caller passed explicit ones.
  const now = new Date();
  const startedAt =
    params.startedAt !== undefined
      ? params.startedAt
      : params.status === "running"
        ? now
        : undefined;
  const endedAt =
    params.endedAt !== undefined
      ? params.endedAt
      : params.status === "ended"
        ? now
        : undefined;

  const result = await advanceTurn(turn.uuid, params.status, {
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(endedAt !== undefined ? { endedAt } : {}),
    ...(executionUuid !== undefined ? { executionUuid } : {}),
  });

  if (result.ok) return { ok: true, turn: result.turn };
  if (result.reason === "not_found") return { ok: false, reason: "not_found" };
  return { ok: false, reason: "invalid_transition", from: result.from, to: result.to };
}

// ===== Backfill read: unstarted (pending) turns for a connection's sessions =====

/**
 * A pending turn surfaced to the daemon's reconnect-backfill, with just enough to
 * RE-DERIVE the wake from the turn table (the canonical source) rather than from a
 * possibly-lost notification ping. Carries the session's business key + idea anchor so
 * the daemon can re-key the wake on the same `(agent, session)` lane the live path
 * uses, plus the `trigger`/`promptText` so a `human_instruction` re-runs with its
 * canonical free-text body.
 */
export interface PendingTurnView {
  turnUuid: string;
  sessionUuid: string;
  sessionId: string;
  directIdeaUuid: string | null;
  seq: number;
  trigger: string;
  promptText: string | null;
}

/**
 * List the UNSTARTED (`status = "pending"`) turns of every session whose origin is the
 * given connection, for the authenticated agent within its company. This is the
 * reconnect-backfill source of truth: a lost delivery ping never loses an instruction,
 * because the turn was persisted at the notification chokepoint before/at notification
 * creation and is re-derived HERE from the turn table — NOT from notifications.
 *
 * Scoped to the caller's OWN sessions (`agentUuid === actorUuid`) AND pinned to the
 * sessions this connection OWNS (`originConnectionUuid === connectionUuid`) — exactly
 * the origin-pinning the continuation rule enforces: a daemon only ever re-runs turns
 * for sessions whose on-disk transcript lives on its cwd/machine. Ordered oldest-first
 * (`session.createdAt`, then turn `seq`) so a re-run respects arrival order. A READ
 * that does NOT swallow — a query failure propagates.
 */
export async function getPendingTurnsForConnection(params: {
  companyUuid: string;
  agentUuid: string;
  connectionUuid: string;
}): Promise<PendingTurnView[]> {
  const rows = await prisma.daemonSessionTurn.findMany({
    where: {
      status: "pending",
      session: {
        companyUuid: params.companyUuid,
        agentUuid: params.agentUuid,
        originConnectionUuid: params.connectionUuid,
      },
    },
    orderBy: [{ session: { createdAt: "asc" } }, { seq: "asc" }],
    select: {
      uuid: true,
      sessionUuid: true,
      seq: true,
      trigger: true,
      promptText: true,
      session: { select: { sessionId: true, directIdeaUuid: true } },
    },
  });

  return rows.map((r) => ({
    turnUuid: r.uuid,
    sessionUuid: r.sessionUuid,
    sessionId: r.session.sessionId,
    directIdeaUuid: r.session.directIdeaUuid,
    seq: r.seq,
    trigger: r.trigger,
    promptText: r.promptText,
  }));
}
