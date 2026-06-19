// src/services/daemon-instruction.service.ts
// UI → daemon instruction injection — the SEND side (子2 — daemon-instruction-injection).
//
// This module is the thin, owner-scoped send surface that turns a human-typed free-text
// instruction into a `human_instruction` TURN on a `DaemonSession`. It COMPOSES the 子1
// DaemonSession foundation (PR #332) — it never re-models sessions, turns, the turn
// chokepoint, or the origin-online gate:
//   - `resolveOrCreateSession` / `assertContinuable` / `getVisibleSessions` /
//     `getSessionTurns` / `SessionReadOnlyError` / `STALE_THRESHOLD_MS` live in
//     `daemon-session.service` (子1) and are imported here, not duplicated.
//   - The actual TURN is created at the SINGLE notification chokepoint
//     (`notification.service.create` → `maybeCreateTurnForWakeNotification`), so a
//     human instruction and an autonomous wake are handled symmetrically — exactly the
//     "every wake is a turn" model 子1 established. This service only feeds that
//     chokepoint a `human_instruction` notification and then reads back the turn it
//     created.
//   - Connection ownership / liveness reuses `connectionBelongsToAgent` +
//     `isConnectionLive` from `daemon-execution.service`.
//
// Origin-only live delivery (子2 keystone — task f6ad4e11): AFTER the chokepoint persists
// the `pending` turn, this module emits a `deliver_turn` control ping on the session's
// ORIGIN connection's per-connection channel (`control:{originConnectionUuid}`) so the
// live wake reaches ONLY that one daemon — never the agent-wide notification fan-out that
// would also wake a non-origin daemon (which lacks the cwd-bound transcript and would spawn
// a divergent session). The ping carries ONLY `targetConnectionUuid`: no instruction text,
// no entity — the daemon's connection-scoped pending-turns sweep reads the text from the
// persisted turn. The caller already proved ownership (the visibility/online gates above),
// so the ping is dispatched DIRECTLY via the control service rather than re-HTTP. It is
// fire-and-forget and NON-fatal: the turn is already persisted (the durability net is the
// daemon's reconnect-backfill, which re-derives the turn from the turn table), so a failed
// ping must NOT fail the send — but it is logged visibly (no silent errors). No
// `targetConnectionUuid` column is added to `Notification`; no new permission bit is
// introduced.

const instructionLogger = logger.child({ module: "daemon-instruction.service" });

import { randomUUID } from "crypto";
import { prisma } from "@/lib/prisma";
import logger from "@/lib/logger";
import * as notificationService from "@/services/notification.service";
import { dispatchControl } from "@/services/daemon-control.service";
import {
  resolveOrCreateSession,
  // `assertContinuable` throws 子1's `SessionReadOnlyError` when the origin is offline;
  // that error is caught + mapped to 409 at the route layer, so it is not referenced here.
  assertContinuable,
  getVisibleSessions,
  STALE_THRESHOLD_MS,
  type SessionView,
  type TurnView,
} from "@/services/daemon-session.service";
import {
  connectionBelongsToAgent,
  isConnectionLive,
} from "@/services/daemon-execution.service";

// ===== Constants =====

/**
 * The single server-side cap on a human instruction's free-text length, in characters.
 * One named constant (no magic number scattered across routes/services) so the bound is
 * single-sourced and adjustable. Text longer than this is rejected with a 400 BEFORE any
 * turn is created. 4000 chars comfortably fits a multi-paragraph instruction while
 * bounding abuse and the denormalized copy stored on the notification row.
 */
export const MAX_INSTRUCTION_CHARS = 4000;

/**
 * The `entityType` stamped on an ad-hoc session's `human_instruction` notification. It is
 * deliberately OUTSIDE the lineage set (`task | document | proposal | idea`) so the turn
 * chokepoint performs NO lineage walk and keys the session on the notification's
 * `entityUuid` (the ad-hoc `sessionId`) directly — matching the daemon's
 * `entity:{type}:{sessionId}` anchor. Using a non-lineage type is the whole point: an
 * ad-hoc `sessionId` is a synthetic uuid that has no idea ancestor.
 */
export const AD_HOC_ENTITY_TYPE = "daemon_session";

// ===== Typed errors (mapped to status codes by the route layer) =====

/**
 * The session the caller addressed is not visible to them (does not exist, lives in
 * another company, or belongs to an agent the caller does not own) — a SINGLE
 * non-disclosure verdict the route maps to 404, never confirming the session exists.
 * Mirrors the `null` return of `getSessionTurns` / the 404 of `pending-turns/route.ts`.
 */
export class SessionNotVisibleError extends Error {
  readonly code = "session_not_visible";
  constructor() {
    super("Daemon session not found");
    this.name = "SessionNotVisibleError";
  }
}

/**
 * The chosen connection is not visible to the caller as a connection of the named agent
 * (the caller does not own the agent, the connection does not belong to the agent, or it
 * does not exist). One non-disclosure verdict the route maps to 404 — never confirming
 * another owner's/agent's connection exists.
 */
export class ConnectionNotVisibleError extends Error {
  readonly code = "connection_not_visible";
  constructor() {
    super("Connection not found");
    this.name = "ConnectionNotVisibleError";
  }
}

/** The chosen connection is offline — an ad-hoc session cannot be pinned to it (409). */
export class ConnectionOfflineError extends Error {
  readonly code = "connection_offline";
  readonly connectionUuid: string;
  constructor(connectionUuid: string) {
    super(
      "The chosen connection is offline. An instruction can only run on an online " +
        "daemon connection (claude --resume is cwd/machine-bound).",
    );
    this.name = "ConnectionOfflineError";
    this.connectionUuid = connectionUuid;
  }
}

/** Reasons the free-text instruction fails validation, so the route maps a 400. */
export type InstructionTextErrorReason = "empty" | "too_long";

/**
 * The instruction text is empty/whitespace-only or longer than `MAX_INSTRUCTION_CHARS`.
 * Thrown BEFORE any session lookup, online check, or turn creation, so a malformed
 * instruction can never create a turn. The route maps it to 400.
 */
export class InstructionTextError extends Error {
  readonly code = "invalid_instruction_text";
  readonly reason: InstructionTextErrorReason;
  constructor(reason: InstructionTextErrorReason) {
    super(
      reason === "empty"
        ? "Instruction text must not be empty."
        : `Instruction text exceeds the maximum of ${MAX_INSTRUCTION_CHARS} characters.`,
    );
    this.name = "InstructionTextError";
    this.reason = reason;
  }
}

// ===== Read projections =====

/**
 * A daemon session row plus the derived `originOnline` flag — the targeting-list shape
 * the send UI consumes. It carries NO turn/transcript bodies (that is 子3): just enough
 * metadata to render an enabled/disabled send box per session in one call.
 */
export interface SessionTargetView extends SessionView {
  /**
   * Whether the session's `originConnectionUuid` is effectively ONLINE right now — the
   * SAME verdict `assertContinuable` enforces at send time (`status === "online" && now -
   * lastSeenAt <= STALE_THRESHOLD_MS`). When false, sending is read-only (409). Derived
   * so the UI gates the send control without a second round-trip.
   */
  originOnline: boolean;
}

// ===== Helpers =====

/**
 * Validate the free-text instruction. Trims, then rejects empty/whitespace-only and
 * over-`MAX_INSTRUCTION_CHARS` (the length is measured on the TRIMMED text — leading /
 * trailing whitespace is not counted toward the cap and is not persisted). Returns the
 * trimmed, canonical text on success; throws `InstructionTextError` otherwise. Called
 * before any mutation so a bad instruction never creates a turn.
 */
export function validateInstructionText(instructionText: string): string {
  const trimmed = (instructionText ?? "").trim();
  if (trimmed.length === 0) {
    throw new InstructionTextError("empty");
  }
  if (trimmed.length > MAX_INSTRUCTION_CHARS) {
    throw new InstructionTextError("too_long");
  }
  return trimmed;
}

/**
 * Resolve a session under the caller's owner/self visibility scope — the SAME fence
 * `getSessionTurns` applies (user/super_admin → agents they own; agent key → own
 * sessions; every query companyUuid-scoped). Returns the minimal row the send path needs
 * (its `agentUuid`, `sessionId`, `directIdeaUuid`), or `null` when not visible so the
 * caller maps to a 404 non-disclosure. A READ that does NOT swallow.
 */
async function findVisibleSession(
  auth: { type: string; companyUuid: string; actorUuid: string },
  sessionUuid: string,
): Promise<{
  agentUuid: string;
  sessionId: string;
  directIdeaUuid: string | null;
  originConnectionUuid: string;
} | null> {
  const scope =
    auth.type === "agent"
      ? { agentUuid: auth.actorUuid }
      : { agent: { ownerUuid: auth.actorUuid } };
  const session = await prisma.daemonSession.findFirst({
    where: { uuid: sessionUuid, companyUuid: auth.companyUuid, ...scope },
    // `originConnectionUuid` is selected so the send path can ping ONLY the origin
    // connection (origin-only live delivery, 子2 keystone) — never another connection
    // of the same agent.
    select: {
      agentUuid: true,
      sessionId: true,
      directIdeaUuid: true,
      originConnectionUuid: true,
    },
  });
  return session;
}

/**
 * Feed the SINGLE notification chokepoint a `human_instruction` notification so it creates
 * the `pending` turn on the INTENDED `(agentUuid, sessionId)` session, and return the EXACT
 * turn it created. The `entityType`/`entityUuid` follow the Tech Design "Session-key
 * alignment":
 *  - idea-anchored session (`directIdeaUuid != null`): `entityType:"idea"`,
 *    `entityUuid: directIdeaUuid`. The chokepoint resolves lineage on an idea uuid to an
 *    identity (`directIdeaUuid === entityUuid`), so the derived `sessionId` equals the
 *    session's own `sessionId` — the turn lands on the existing row (no second session).
 *  - ad-hoc session (`directIdeaUuid == null`): a NON-lineage `entityType`
 *    (`AD_HOC_ENTITY_TYPE`) + `entityUuid: sessionId`. The chokepoint skips lineage and
 *    keys on `entityUuid`, i.e. the ad-hoc `sessionId` — the daemon's `--resume` anchor.
 *
 * The owner-scoped notification carries the actor (the human/agent caller) for the record.
 * projectUuid/projectName/entityTitle are not load-bearing for the turn (the chokepoint
 * reads only company/recipient/entity/action/instructionText) and the instruction is NOT
 * written to the Activity stream (PRD 总纲 Q8=c) — they are stamped with neutral values.
 */
async function createInstructionTurn(params: {
  auth: { type: string; companyUuid: string; actorUuid: string };
  agentUuid: string;
  sessionUuid: string;
  sessionId: string;
  directIdeaUuid: string | null;
  instructionText: string;
}): Promise<TurnView> {
  const { auth, agentUuid, sessionUuid, sessionId, directIdeaUuid, instructionText } = params;

  const entityType = directIdeaUuid != null ? "idea" : AD_HOC_ENTITY_TYPE;
  const entityUuid = directIdeaUuid != null ? directIdeaUuid : sessionId;

  // `createReturningTurn` runs the chokepoint and hands back the EXACT turn it created — no
  // read-back by `seq desc`, so a concurrent autonomous wake landing a higher-seq turn in
  // the same window can never make us return the wrong turn's uuid.
  const { turn } = await notificationService.createReturningTurn({
    companyUuid: auth.companyUuid,
    // Owner-scoped instruction: not tied to a project board. The chokepoint does not read
    // projectUuid/projectName, and the instruction is not surfaced in the Activity stream.
    projectUuid: "",
    projectName: "",
    recipientType: "agent",
    recipientUuid: agentUuid,
    entityType,
    entityUuid,
    entityTitle: "",
    action: "human_instruction",
    message: "Human instruction",
    actorType: auth.type === "agent" ? "agent" : "user",
    actorUuid: auth.actorUuid,
    actorName: "",
    instructionText,
  });

  if (!turn) {
    // Defensive: the chokepoint returns no turn only when the agent has no online origin.
    // sendInstruction re-checks `assertContinuable` immediately before, and the ad-hoc
    // path verifies the connection is live, so in normal flow a turn always exists. If it
    // does not, surface it visibly rather than returning a fabricated/empty turn.
    throw new Error(
      `Instruction turn was not created on session ${sessionUuid} (no online origin at chokepoint).`,
    );
  }
  return turn;
}

/**
 * Emit the origin-only live `deliver_turn` ping for a freshly-created instruction turn:
 * publish a `deliver_turn` control command on the SESSION'S ORIGIN connection so only that
 * one daemon is woken to run the new `pending` turn. The wire payload carries
 * `targetConnectionUuid` + the PRECISE `turnUuid` — no instruction text, no entity (the
 * daemon reads the turn, and its text, by uuid from the persisted turn). Targeting the
 * exact turn (rather than a connection-wide sweep) is what keeps a fresh send from dragging
 * every other still-`pending` turn of the connection along with it.
 *
 * Fire-and-forget + NON-fatal by contract: the turn is already persisted, so a publish
 * failure must NOT fail the send (the daemon's reconnect-backfill re-derives the turn from
 * the turn table — the durability net). Any error is caught and logged VISIBLY (no silent
 * errors), never rethrown. `dispatchControl` is synchronous (it `emit`s and returns), so a
 * throw can only come from a misconfigured event bus; we guard it anyway.
 */
function deliverTurnPing(params: {
  companyUuid: string;
  originConnectionUuid: string;
  turnUuid: string;
}): void {
  try {
    dispatchControl({
      companyUuid: params.companyUuid,
      targetConnectionUuid: params.originConnectionUuid,
      command: "deliver_turn",
      turnUuid: params.turnUuid,
    });
  } catch (err) {
    // Non-fatal: the persisted turn + reconnect-backfill guarantee durability. Log loudly.
    instructionLogger.warn(
      { err, originConnectionUuid: params.originConnectionUuid, turnUuid: params.turnUuid },
      "deliver_turn live ping failed; the turn is persisted and will be recovered by the daemon's reconnect-backfill",
    );
  }
}

// ===== Send to an existing session =====

/**
 * Send a free-text `human_instruction` to an EXISTING daemon session, owner-scoped.
 *
 * Order (each gate before any mutation):
 *  1. Validate `instructionText` (trim non-empty, ≤ `MAX_INSTRUCTION_CHARS`) → throws
 *     `InstructionTextError` (route → 400) BEFORE any lookup or turn creation.
 *  2. Resolve the session under the caller's visibility scope → `SessionNotVisibleError`
 *     (route → 404 non-disclosure) when not visible.
 *  3. Re-check the origin connection is online via `assertContinuable` (子1) → it throws
 *     `SessionReadOnlyError` (route → 409) when the origin is offline. The instruction is
 *     NEVER routed to another connection of the same agent.
 *  4. Create the `human_instruction` turn through the notification chokepoint (session-key
 *     aligned so it lands on THIS session) and return the created turn view.
 *
 * Returns `{ turn }`. Throws the typed errors above (mapped by the route). A query/write
 * failure propagates (no silent swallow).
 */
export async function sendInstruction(
  auth: { type: string; companyUuid: string; actorUuid: string },
  params: { sessionUuid: string; instructionText: string },
): Promise<{ turn: TurnView }> {
  // (1) Validate text first — a bad instruction must never create a turn.
  const instructionText = validateInstructionText(params.instructionText);

  // (2) Owner-scoped visibility fence (404 non-disclosure when not visible).
  const session = await findVisibleSession(auth, params.sessionUuid);
  if (!session) {
    throw new SessionNotVisibleError();
  }

  // (3) Re-check the origin is online (read-only/409 when offline). Reuses 子1's single
  // staleness verdict; never re-routes to another connection.
  await assertContinuable(auth.companyUuid, params.sessionUuid);

  // (4) Create the turn on THIS session via the chokepoint, session-key aligned.
  const turn = await createInstructionTurn({
    auth,
    agentUuid: session.agentUuid,
    sessionUuid: params.sessionUuid,
    sessionId: session.sessionId,
    directIdeaUuid: session.directIdeaUuid,
    instructionText,
  });

  // (5) Origin-only live delivery: ping ONLY the session's origin connection so the live
  // wake reaches that one daemon and never another connection of the same agent, carrying
  // the PRECISE turnUuid so it runs ONLY this turn. Fire-and-forget + non-fatal — the
  // persisted turn + reconnect-backfill are the durability net.
  deliverTurnPing({
    companyUuid: auth.companyUuid,
    originConnectionUuid: session.originConnectionUuid,
    turnUuid: turn.uuid,
  });

  return { turn };
}

// ===== Ad-hoc create-and-send =====

/**
 * Create a NEW ad-hoc daemon session (`directIdeaUuid = null`) pinned to a caller-chosen
 * online connection of an agent the caller owns, and send its first `human_instruction`
 * turn — in one call.
 *
 * Order (each gate before any mutation):
 *  1. Validate `instructionText` → `InstructionTextError` (route → 400).
 *  2. Verify the connection belongs to the agent within the caller's visibility scope:
 *      - the connection must be one of the agent's (`connectionBelongsToAgent`), AND
 *      - for a USER/super_admin caller the agent must be owned by the caller; for an
 *        agent-key caller the agent must be itself.
 *     Any miss → `ConnectionNotVisibleError` (route → 404 non-disclosure). No session is
 *     created.
 *  3. Verify the connection is effectively ONLINE (`isConnectionLive`, the same staleness
 *     verdict) → `ConnectionOfflineError` (route → 409) when offline. No session created.
 *  4. SERVER generates a fresh `sessionId` (a uuid) — the single source of truth.
 *  5. `resolveOrCreateSession({ directIdeaUuid: null, sessionId, originConnectionUuid })`
 *     creates the ad-hoc session pinned to the chosen connection.
 *  6. Create the first `human_instruction` turn via the chokepoint (ad-hoc session-key
 *     aligned) and return `{ session, turn }`.
 *
 * Throws the typed errors above (mapped by the route). A query/write failure propagates.
 */
export async function createAdHocSessionWithInstruction(
  auth: { type: string; companyUuid: string; actorUuid: string },
  params: { agentUuid: string; connectionUuid: string; instructionText: string },
): Promise<{ session: SessionView; turn: TurnView }> {
  // (1) Validate text first.
  const instructionText = validateInstructionText(params.instructionText);

  // (2) Visibility + ownership fence: the connection belongs to the agent AND the caller
  // owns/own the agent. Either miss collapses to ONE 404 non-disclosure verdict so an
  // unowned agent and an absent/foreign connection are indistinguishable.
  const ownsAgent = await callerOwnsAgent(auth, params.agentUuid);
  const connectionOfAgent = await connectionBelongsToAgent(
    auth.companyUuid,
    params.agentUuid,
    params.connectionUuid,
  );
  if (!ownsAgent || !connectionOfAgent) {
    throw new ConnectionNotVisibleError();
  }

  // (3) The connection must be online (read-only/409 when offline). No session yet.
  const online = await isConnectionLive(auth.companyUuid, params.connectionUuid);
  if (!online) {
    throw new ConnectionOfflineError(params.connectionUuid);
  }

  // (4) Server is the SOLE generator of the ad-hoc sessionId.
  const sessionId = randomUUID();

  // (5) Create the ad-hoc session pinned to the chosen connection (origin + null direct
  // idea write-once on create).
  const session = await resolveOrCreateSession({
    companyUuid: auth.companyUuid,
    agentUuid: params.agentUuid,
    sessionId,
    directIdeaUuid: null,
    originConnectionUuid: params.connectionUuid,
  });

  // (6) First turn via the chokepoint, ad-hoc session-key aligned.
  const turn = await createInstructionTurn({
    auth,
    agentUuid: params.agentUuid,
    sessionUuid: session.uuid,
    sessionId,
    directIdeaUuid: null,
    instructionText,
  });

  // (7) Origin-only live delivery: ping ONLY the chosen (origin) connection, carrying the
  // PRECISE turnUuid so it runs ONLY this first turn. For an ad-hoc session the origin IS
  // the caller-chosen connection (verified online above). Fire-and-forget + non-fatal —
  // the persisted turn + reconnect-backfill are the durability net.
  deliverTurnPing({
    companyUuid: auth.companyUuid,
    originConnectionUuid: params.connectionUuid,
    turnUuid: turn.uuid,
  });

  return { session, turn };
}

/**
 * Does the caller own / is the caller the named agent, within their company?
 *  - an AGENT-KEY caller may only target ITSELF (`agentUuid === actorUuid`), and
 *  - a USER / super_admin caller may only target an agent they OWN
 *    (`Agent.ownerUuid === actorUuid`),
 * companyUuid-scoped. A READ that does NOT swallow.
 */
async function callerOwnsAgent(
  auth: { type: string; companyUuid: string; actorUuid: string },
  agentUuid: string,
): Promise<boolean> {
  if (auth.type === "agent") {
    return agentUuid === auth.actorUuid;
  }
  const count = await prisma.agent.count({
    where: { uuid: agentUuid, companyUuid: auth.companyUuid, ownerUuid: auth.actorUuid },
  });
  return count > 0;
}

// ===== Owner-scoped targeting list =====

/**
 * List the caller's owner-scoped, company-fenced daemon sessions (via 子1's
 * `getVisibleSessions`), each enriched with a derived `originOnline` flag, for the send
 * UI's targeting picker. NO turn/transcript bodies (that is 子3).
 *
 * `originOnline` is computed with the SAME staleness verdict `assertContinuable` enforces
 * (`status === "online" && now - lastSeenAt <= STALE_THRESHOLD_MS`) — single-sourced via
 * the re-exported `STALE_THRESHOLD_MS`, never a second rule. Connection liveness is
 * batched: the distinct origin connection uuids are resolved in one query, so the list is
 * O(1) extra round-trips regardless of session count. A connection that no longer resolves
 * (deleted) is treated as offline. A READ that does NOT swallow.
 */
export async function getVisibleSessionsWithOrigin(
  auth: { type: string; companyUuid: string; actorUuid: string },
): Promise<SessionTargetView[]> {
  const sessions = await getVisibleSessions(auth);
  if (sessions.length === 0) return [];

  const connectionUuids = [...new Set(sessions.map((s) => s.originConnectionUuid))];
  const connections = await prisma.daemonConnection.findMany({
    where: { companyUuid: auth.companyUuid, uuid: { in: connectionUuids } },
    select: { uuid: true, status: true, lastSeenAt: true },
  });
  const now = Date.now();
  const onlineConnectionUuids = new Set(
    connections
      .filter(
        (c) => c.status === "online" && now - c.lastSeenAt.getTime() <= STALE_THRESHOLD_MS,
      )
      .map((c) => c.uuid),
  );

  return sessions.map((s) => ({
    ...s,
    originOnline: onlineConnectionUuids.has(s.originConnectionUuid),
  }));
}
