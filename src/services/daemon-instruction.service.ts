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
import { eventBus } from "@/lib/event-bus";
import * as notificationService from "@/services/notification.service";
import { dispatchControl } from "@/services/daemon-control.service";
import {
  resolveOrCreateSession,
  // `assertContinuable` throws 子1's `SessionReadOnlyError` when the origin is offline;
  // that error is caught + mapped to 409 at the route layer, so it is not referenced here.
  assertContinuable,
  getVisibleSessions,
  getFirstInstructionBySessionUuid,
  publishTranscriptEvent,
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

/**
 * The session whose origin is being RE-POINTED is currently LIVE (its origin connection is
 * online) — so re-pointing is refused (409). The re-point escape hatch exists ONLY to
 * rescue a session whose origin went offline (read-only) onto another online instance; a
 * live session has no dead-end to route around, and `sendInstruction` already delivers to
 * its online origin. Re-pointing a live session would orphan a running daemon's transcript,
 * so this is a hard guard, not a fallback.
 */
export class RepointOriginLiveError extends Error {
  readonly code = "repoint_origin_live";
  readonly originConnectionUuid: string;
  constructor(originConnectionUuid: string) {
    super(
      "This conversation's origin is still online, so it cannot be re-pointed. " +
        "Re-pointing only rescues a read-only conversation whose origin went offline; " +
        "send to the live origin instead.",
    );
    this.name = "RepointOriginLiveError";
    this.originConnectionUuid = originConnectionUuid;
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
  /**
   * The conversation's opening human instruction — the `promptText` of its earliest
   * `human_instruction` turn — used to NAME an ad-hoc conversation (a chat is titled by
   * what the human first said, not by a uuid). Null when the session has no
   * human_instruction turn yet (e.g. an idea conversation woken only by autonomous
   * triggers), in which case the UI falls back to the idea/ad-hoc label.
   */
  firstInstruction: string | null;
  /**
   * The title of the session's anchoring idea (`directIdeaUuid`), batch-resolved
   * in-company — used to NAME an idea-anchored conversation (a resource badge + this
   * title). Null for an ad-hoc session, or when the idea no longer resolves.
   */
  ideaTitle: string | null;
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
export function deliverTurnPing(params: {
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

// ===== Conversational idea dispatch (pre-create idea + idea-anchored session) =====

/**
 * The project addressed by a conversational-idea dispatch is not visible to the caller
 * (does not exist or lives in another company) — a non-disclosure verdict the route maps
 * to 404, mirroring the connection/session non-disclosure errors above.
 */
export class ProjectNotVisibleError extends Error {
  readonly code = "project_not_visible";
  constructor() {
    super("Project not found");
    this.name = "ProjectNotVisibleError";
  }
}

/**
 * The chosen connection has no linked durable AgentInstance, so the pre-created idea
 * cannot be instance-assigned. Should not happen for a live handshaked connection (the
 * handshake links the instance), but a session must never be born with a null pin —
 * mapped to 409 by the route, like the offline case (retry after the daemon re-handshakes).
 */
export class ConnectionInstanceMissingError extends Error {
  readonly code = "connection_instance_missing";
  readonly connectionUuid: string;
  constructor(connectionUuid: string) {
    super(
      "The chosen connection has no registered agent instance yet. " +
        "Wait for the daemon to finish its handshake and retry.",
    );
    this.name = "ConnectionInstanceMissingError";
    this.connectionUuid = connectionUuid;
  }
}

/** Max length of the server-derived placeholder title for a pre-created idea. */
export const PLACEHOLDER_TITLE_MAX = 60;

/**
 * Derive the placeholder title for a pre-created conversational idea: the description's
 * first non-empty line, trimmed, truncated to `PLACEHOLDER_TITLE_MAX` chars with an
 * ellipsis. Server-side (not client) so every consumer of the endpoint gets identical
 * behavior; the woken agent's first directive is to replace it with a real title.
 * Falls back to a single dash for a blank description — unreachable via the endpoint
 * (empty text is rejected first) but kept total so the helper never returns "".
 */
export function derivePlaceholderTitle(description: string): string {
  const firstLine =
    (description ?? "")
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";
  if (firstLine.length === 0) return "-";
  if (firstLine.length <= PLACEHOLDER_TITLE_MAX) return firstLine;
  return `${firstLine.slice(0, PLACEHOLDER_TITLE_MAX - 1)}…`;
}

/**
 * How the woken agent should treat a conversational-idea dispatch:
 *  - `elaborate` (default): the original single-idea contract — edit the idea, start one
 *    elaboration round, end the turn.
 *  - `decompose`: the container-decompose contract (add-container-idea-ui Block 3) — the
 *    pre-created idea is a CONTAINER; the agent clarifies decomposition scope, proposes
 *    candidate CHILD ideas as an elaboration round for the user to confirm, and only on
 *    the confirm re-wake creates them under the container.
 */
export type ConversationalIdeaMode = "elaborate" | "decompose";

/**
 * Compose the conversational-idea wake instruction (template v2 — the REVIEWED CONTRACT
 * between the conversational create-idea entry and the woken daemon agent, superseding
 * the client-side create→claim template of add-conversational-idea-entry).
 *
 * The idea is PRE-CREATED and already instance-assigned + elaborating, so both templates
 * direct EDIT (never create, never claim — a claim would fail on the existing assignee).
 *  - `elaborate` (default): edit → immediate start-elaboration → panel guidance → end turn.
 *  - `decompose`: edit the CONTAINER → keep isContainer → one lightweight scope-clarifying
 *    elaboration → propose candidate CHILDREN as a structured elaboration round (one
 *    single-select question per child, ≤15/round, never a multi-select) → end turn → on the
 *    confirm re-wake create each accepted child via chorus_pm_create_idea with
 *    parentUuid=<container>, children starting `open`, no auto-elaboration; the container's
 *    own status stays `elaborated`. The confirm re-wake rides the EXISTING
 *    `elaboration_answered` wake — no new wake/notification action is introduced.
 *
 * English (agent-facing, matching cli/prompts.mjs precedent); the user's description
 * passes through VERBATIM under the delimiter. Exported for unit tests: the template's
 * wording is code, and any change is a review-visible diff.
 */
export function composeConversationalIdeaInstruction(params: {
  ideaUuid: string;
  projectUuid: string;
  projectName?: string | null;
  descriptionText: string;
  mode?: ConversationalIdeaMode;
}): string {
  // Name is display sugar; the uuid is the machine anchor and is always present.
  const projectLabel = params.projectName?.trim()
    ? `"${params.projectName.trim()}" (projectUuid: ${params.projectUuid})`
    : `projectUuid: ${params.projectUuid}`;

  if (params.mode === "decompose") {
    return [
      `[Chorus container-decompose entry] A new CONTAINER idea has been PRE-CREATED for project ${projectLabel} from the user's description below, and it is already assigned to you (status: elaborating, isContainer: true).`,
      `  ideaUuid: ${params.ideaUuid}`,
      ``,
      `This conversation IS that container idea's root session. The user wants help DECOMPOSING it into child ideas. Do the following, in order:`,
      `1. Edit the container via chorus_edit_idea: derive a concise title from the description and polish the content (keep the user's meaning). The current title is a placeholder.`,
      `2. Ensure it stays a container: it was pre-created with isContainer=true — do NOT clear that flag (a container groups its child ideas and MUST NOT get a proposal of its own).`,
      `3. Run ONE lightweight elaboration round (chorus_pm_start_elaboration) to clarify the decomposition scope/dimension — how to slice the work into children. Keep it short; you may self-answer in headless or ask the user, then continue.`,
      `4. Propose the candidate child ideas AS A STRUCTURED ELABORATION ROUND (chorus_pm_start_elaboration) for the user to review/edit/confirm — use ONE elaboration question PER proposed child (the child's title as the question text, a short rationale as its description), single-select. Elaboration questions are single-select and a round is capped at 15 questions, so propose at most 15 candidates per round and NEVER a single multi-select question; if you need more children, propose them across additional rounds. Do NOT create any child ideas yet — this round is the preview the user accepts/edits/declines per child.`,
      `5. End the turn. The user's answers in the idea's elaboration panel will wake this same conversation (the existing elaboration-answered wake).`,
      `6. On that re-wake, create each ACCEPTED child via chorus_pm_create_idea with parentUuid=${params.ideaUuid}. Each child starts in the "open" state — do NOT auto-elaborate them. The container's OWN status stays "elaborated"; creating children does not advance or alter it.`,
      ``,
      `Reference reflex: whenever an external link is evidence for this work (a precedent issue/PR, a reference implementation, official docs, a paper/blog), attach it via references — prefer the inline references[] param at creation time over a post-hoc chorus_add_reference.`,
      ``,
      `--- User's idea description ---`,
      params.descriptionText,
    ].join("\n");
  }

  return [
    `[Chorus conversational idea entry] A new idea has been PRE-CREATED for project ${projectLabel} from the user's description below, and it is already assigned to you (status: elaborating).`,
    `  ideaUuid: ${params.ideaUuid}`,
    ``,
    `This conversation IS that idea's root session — its elaboration and lifecycle wakes will continue here. Do the following, in order:`,
    `1. Edit the idea via chorus_edit_idea: derive a concise title from the description and polish the content (keep the user's meaning; you may restructure). The current title is a placeholder.`,
    `2. Immediately start elaboration on the idea (chorus_pm_start_elaboration), following the idea skill — do NOT wait for another wake. Post a short summary of your questions in this conversation and direct the user to answer in the idea's elaboration panel.`,
    `3. End the turn. The user's panel answers will wake this same conversation.`,
    ``,
    `Reference reflex: whenever an external link is evidence for this idea (a precedent issue/PR, a reference implementation, official docs, a paper/blog), attach it via references — prefer the inline references[] param at creation time over a post-hoc chorus_add_reference.`,
    ``,
    `--- User's idea description ---`,
    params.descriptionText,
  ].join("\n");
}

/** The compact idea projection a conversational dispatch returns to the frontend. */
export interface ConversationalIdeaView {
  uuid: string;
  title: string;
  content: string | null;
  status: string;
  projectUuid: string;
  createdAt: string; // ISO-8601
}

/**
 * Conversational-idea dispatch: PRE-CREATE the Idea and its root daemon session, then
 * send the first `human_instruction` turn — in ONE transaction (add-conversational-
 * idea-root-session). The pivotal property: the session is born IDEA-ANCHORED
 * (`sessionId = directIdeaUuid = ideaUuid`), so every subsequent idea-anchored wake
 * (elaboration answers, Verify Elaborate, proposal approval, task dispatch) resolves to
 * THIS session via the existing `sessionId === directIdeaUuid` convention — zero
 * wake-chokepoint changes, no write-once relaxation.
 *
 * Order (each gate before any mutation):
 *  1. Ownership + connection fences — `callerOwnsAgent` + `connectionBelongsToAgent`
 *     collapse to ONE `ConnectionNotVisibleError` (route → 404 non-disclosure);
 *     `isConnectionLive` → `ConnectionOfflineError` (route → 409). Same posture as
 *     `createAdHocSessionWithInstruction`.
 *  2. Project visibility (company-scoped; also supplies the template's project name) →
 *     `ProjectNotVisibleError` (route → 404).
 *  3. The connection's durable `agentInstanceUuid` must resolve — the idea's instance
 *     pin must point at a real place → `ConnectionInstanceMissingError` (route → 409).
 *  4. SERVER generates the ideaUuid, composes the instruction around it, and validates
 *     the COMPOSED text (`validateInstructionText`) → `InstructionTextError` (route →
 *     400). Generating the uuid before the transaction is what lets the instruction
 *     embed it while keeping all writes atomic.
 *  5. ONE `prisma.$transaction`: create the Idea (createdBy = caller, placeholder
 *     title, VERBATIM description as content, `agent_instance` assignee, status
 *     `elaborating` — assignment-equals-claim), the DaemonSession (sessionId =
 *     directIdeaUuid = ideaUuid, origin = the chosen connection, write-once written
 *     once correctly), and the first `human_instruction` turn (seq 1, promptText =
 *     the composed instruction — canonical copy). All-or-nothing: a mid-transaction
 *     failure persists nothing (no orphan idea).
 *
 *     The turn is written DIRECTLY here, not through the notification chokepoint:
 *     `createReturningTurn` runs on the global prisma client and could neither see the
 *     uncommitted idea/session nor join the transaction — and its directed-wake path
 *     would emit a second `deliver_turn` ping (the proposal-review cautions). The
 *     dispatch itself IS the wake, so no notification row is needed; the turn table is
 *     the daemon's canonical backfill source, which this write lands in atomically.
 *  6. After commit (in order): publish the `turn_created` transcript SSE trigger (the
 *     chokepoint would have done this; the viewer must see the first turn live), emit
 *     the idea `created` change event (SSE-driven idea lists update), and fire the
 *     origin-only `deliver_turn` ping with the precise turnUuid (fire-and-forget +
 *     non-fatal — the persisted turn + reconnect-backfill are the durability net).
 *
 *     Deliberately NO "assigned" Activity is recorded: that activity fans out an
 *     `idea_claimed` notification whose wake would create a SECOND turn on this very
 *     session. The dispatch is the wake — one turn, one ping.
 *
 * Returns `{ idea, session, turn }`. Throws the typed errors above (mapped by the
 * route). A query/write failure propagates (no silent swallow).
 */
export async function createConversationalIdeaSession(
  auth: { type: string; companyUuid: string; actorUuid: string },
  params: {
    projectUuid: string;
    agentUuid: string;
    connectionUuid: string;
    descriptionText: string;
    // Selects the wake template + whether the pre-created idea is a container.
    // `elaborate` (default) is the original single-idea contract; `decompose`
    // (add-container-idea-ui Block 3) pre-creates the idea with isContainer=true and
    // dispatches the decompose instruction so the agent proposes child ideas as an
    // elaboration round. Optional so existing callers (byte-identical) stay unchanged.
    mode?: ConversationalIdeaMode;
  },
): Promise<{ idea: ConversationalIdeaView; session: SessionView; turn: TurnView }> {
  const mode: ConversationalIdeaMode = params.mode ?? "elaborate";
  // (1) Visibility + ownership fence, identical posture to the ad-hoc path: either miss
  // collapses to ONE 404 non-disclosure verdict.
  const ownsAgent = await callerOwnsAgent(auth, params.agentUuid);
  const connectionOfAgent = await connectionBelongsToAgent(
    auth.companyUuid,
    params.agentUuid,
    params.connectionUuid,
  );
  if (!ownsAgent || !connectionOfAgent) {
    throw new ConnectionNotVisibleError();
  }
  const online = await isConnectionLive(auth.companyUuid, params.connectionUuid);
  if (!online) {
    throw new ConnectionOfflineError(params.connectionUuid);
  }

  // (2) Project visibility (company-scoped) + the template's display name.
  const project = await prisma.project.findFirst({
    where: { uuid: params.projectUuid, companyUuid: auth.companyUuid },
    select: { uuid: true, name: true },
  });
  if (!project) {
    throw new ProjectNotVisibleError();
  }

  // (3) The durable instance behind the chosen connection — the idea's pin target. A
  // live connection normally always has one (linked at handshake); never bind to null.
  const connection = await prisma.daemonConnection.findFirst({
    where: { uuid: params.connectionUuid, companyUuid: auth.companyUuid },
    select: { agentInstanceUuid: true },
  });
  if (!connection?.agentInstanceUuid) {
    throw new ConnectionInstanceMissingError(params.connectionUuid);
  }
  const instanceUuid = connection.agentInstanceUuid;

  // (4) Server-generated ideaUuid FIRST, so the composed instruction can embed it while
  // the idea write stays inside the transaction. Reject empty descriptions before
  // composing (the template alone would otherwise pass the non-empty check), then
  // validate the COMPOSED length against the single MAX_INSTRUCTION_CHARS cap.
  const descriptionText = params.descriptionText?.trim() ?? "";
  if (descriptionText.length === 0) {
    throw new InstructionTextError("empty");
  }
  const ideaUuid = randomUUID();
  const instructionText = validateInstructionText(
    composeConversationalIdeaInstruction({
      ideaUuid,
      projectUuid: project.uuid,
      projectName: project.name,
      descriptionText,
      mode,
    }),
  );

  // (5) All-or-nothing: idea + idea-anchored session + first turn in one transaction.
  const { ideaRow, sessionRow, turnRow } = await prisma.$transaction(async (tx) => {
    const ideaRow = await tx.idea.create({
      data: {
        uuid: ideaUuid,
        companyUuid: auth.companyUuid,
        projectUuid: project.uuid,
        title: derivePlaceholderTitle(descriptionText),
        content: descriptionText,
        // Decompose mode pre-creates a CONTAINER (add-container-idea-ui Block 3): the
        // woken agent proposes child ideas under it and must not give it a proposal of
        // its own. `elaborate` mode leaves it a normal idea (isContainer stays false).
        isContainer: mode === "decompose",
        // Assignment-equals-claim (r2q4=a): instance-assigned + elaborating from birth,
        // so the agent_instance pin routes wakes to the chosen cwd from day one and the
        // woken agent edits (never claims).
        status: "elaborating",
        assigneeType: "agent_instance",
        assigneeUuid: instanceUuid,
        assignedAt: new Date(),
        assignedByUuid: auth.actorUuid,
        createdByUuid: auth.actorUuid,
      },
      select: {
        uuid: true,
        title: true,
        content: true,
        status: true,
        projectUuid: true,
        createdAt: true,
      },
    });

    // Idea-anchored from birth: sessionId === directIdeaUuid === ideaUuid. The
    // write-once origin/directIdeaUuid fields are written once, correctly, on create —
    // `resolveOrCreateSession` is not used because it runs on the global client.
    const sessionRow = await tx.daemonSession.create({
      data: {
        companyUuid: auth.companyUuid,
        agentUuid: params.agentUuid,
        sessionId: ideaUuid,
        directIdeaUuid: ideaUuid,
        originConnectionUuid: params.connectionUuid,
        status: "active",
      },
    });

    // First turn, seq 1 on the freshly-created session (no concurrent writer can exist
    // before commit). promptText carries the canonical composed instruction.
    const turnRow = await tx.daemonSessionTurn.create({
      data: {
        sessionUuid: sessionRow.uuid,
        seq: 1,
        trigger: "human_instruction",
        promptText: instructionText,
        status: "pending",
      },
    });

    return { ideaRow, sessionRow, turnRow };
  });

  const session: SessionView = {
    uuid: sessionRow.uuid,
    agentUuid: sessionRow.agentUuid,
    sessionId: sessionRow.sessionId,
    directIdeaUuid: sessionRow.directIdeaUuid,
    originConnectionUuid: sessionRow.originConnectionUuid,
    status: sessionRow.status,
    title: sessionRow.title,
    lastTurnAt: sessionRow.lastTurnAt.toISOString(),
    // A freshly-created session has no reported turns yet → zero rollup (daemon-token-usage).
    totalInputTokens: sessionRow.totalInputTokens,
    totalOutputTokens: sessionRow.totalOutputTokens,
    createdAt: sessionRow.createdAt.toISOString(),
    updatedAt: sessionRow.updatedAt.toISOString(),
  };
  const turn: TurnView = {
    uuid: turnRow.uuid,
    sessionUuid: turnRow.sessionUuid,
    seq: turnRow.seq,
    trigger: turnRow.trigger,
    promptText: turnRow.promptText,
    status: turnRow.status,
    interruptedReason: turnRow.interruptedReason,
    relayError: turnRow.relayError,
    // A just-created `pending` turn has not run yet → no usage (daemon-token-usage).
    usage: null,
    executionUuid: turnRow.executionUuid,
    startedAt: turnRow.startedAt ? turnRow.startedAt.toISOString() : null,
    endedAt: turnRow.endedAt ? turnRow.endedAt.toISOString() : null,
    createdAt: turnRow.createdAt.toISOString(),
  };
  const idea: ConversationalIdeaView = {
    uuid: ideaRow.uuid,
    title: ideaRow.title,
    content: ideaRow.content,
    status: ideaRow.status,
    projectUuid: ideaRow.projectUuid,
    createdAt: ideaRow.createdAt.toISOString(),
  };

  // (6) Post-commit side effects, none of which may undo the committed writes:
  // transcript SSE (the chokepoint's turn_created trigger, emitted here because the turn
  // bypassed createPendingTurn), the idea `created` change event (idea lists refresh),
  // and the precise origin-only wake ping (fire-and-forget + non-fatal).
  publishTranscriptEvent({
    companyUuid: auth.companyUuid,
    sessionUuid: session.uuid,
    trigger: "turn_created",
    turn,
    messages: [],
  });
  eventBus.emitChange({
    companyUuid: auth.companyUuid,
    projectUuid: project.uuid,
    entityType: "idea",
    entityUuid: idea.uuid,
    action: "created",
  });
  deliverTurnPing({
    companyUuid: auth.companyUuid,
    originConnectionUuid: params.connectionUuid,
    turnUuid: turn.uuid,
  });

  return { idea, session, turn };
}

// ===== Re-point an offline session's origin onto a chosen online instance =====

/**
 * RE-POINT a read-only (origin-offline) daemon session onto a caller-chosen ONLINE
 * connection of the SAME agent, then send a fresh `human_instruction` turn there — keeping
 * the SAME `DaemonSession` (same `uuid`, same `sessionId`, same `directIdeaUuid`). This is
 * the corrected "Continue on an online directory" escape hatch (T12): it does NOT mint a new
 * ad-hoc session (the T11 mistake, which lost the conversation's identity). The session's
 * Claude session id is preserved, so when the daemon spawns on the new cwd it finds no
 * transcript there and starts a FRESH transcript under the SAME id (`claude --session-id
 * <sameId>`) — a cold start, no context injection. The prior turns remain as Chorus-visible
 * read-only history.
 *
 * Order (each gate before any mutation):
 *  1. Validate `instructionText` (trim non-empty, ≤ `MAX_INSTRUCTION_CHARS`) →
 *     `InstructionTextError` (route → 400) BEFORE any lookup or write.
 *  2. Resolve the session under the caller's visibility scope → `SessionNotVisibleError`
 *     (route → 404 non-disclosure) when not visible/owned.
 *  3. Assert the session's CURRENT origin is OFFLINE — re-point is ONLY for a read-only
 *     session. A live origin is refused with `RepointOriginLiveError` (route → 409): a live
 *     session has no dead-end to route around (use `sendInstruction` on its online origin).
 *     Reuses the SAME staleness verdict (`isConnectionLive`).
 *  4. Assert the target `connectionUuid` belongs to the SAME agent as the session AND is
 *     ONLINE: same-agent miss → `ConnectionNotVisibleError` (route → 404 non-disclosure),
 *     offline → `ConnectionOfflineError` (route → 409). Reuses `connectionBelongsToAgent` +
 *     `isConnectionLive`.
 *  5. UPDATE `DaemonSession.originConnectionUuid` to the target. *** THIS is the single,
 *     deliberate place the 'originConnectionUuid is write-once / never re-routed' invariant
 *     (resolveOrCreateSession + assertContinuable) is reversed — and ONLY under this explicit
 *     user action. The autonomous wake path (notification-turn) never re-points. *** The
 *     UPDATE is companyUuid-scoped (the visibility fence above already proved ownership) so a
 *     cross-company write is impossible.
 *  6. Create the `human_instruction` turn through the SAME chokepoint `sendInstruction`/the
 *     ad-hoc path use, bound to the SAME session (same `uuid`/`sessionId`/`directIdeaUuid`),
 *     then deliver it to the NEW origin connection.
 *
 * Returns `{ session, turn }` — the SAME session (now re-pointed, so its derived
 * `originOnline` is true) plus the created turn. Throws the typed errors above (mapped by the
 * route). A query/write failure propagates (no silent swallow).
 */
export async function repointSessionOriginAndSend(
  auth: { type: string; companyUuid: string; actorUuid: string },
  params: { sessionUuid: string; connectionUuid: string; instructionText: string },
): Promise<{ session: SessionView; turn: TurnView }> {
  // (1) Validate text first — a bad instruction must never re-point or create a turn.
  const instructionText = validateInstructionText(params.instructionText);

  // (2) Owner-scoped visibility fence (404 non-disclosure when not visible/owned).
  const session = await findVisibleSession(auth, params.sessionUuid);
  if (!session) {
    throw new SessionNotVisibleError();
  }

  // (3) The CURRENT origin must be OFFLINE — re-point is only for a read-only session. A live
  // origin has no dead-end to route around, so refuse (409) rather than orphan a running run.
  const currentOriginLive = await isConnectionLive(
    auth.companyUuid,
    session.originConnectionUuid,
  );
  if (currentOriginLive) {
    throw new RepointOriginLiveError(session.originConnectionUuid);
  }

  // (4) The TARGET connection must belong to the SAME agent as the session AND be online.
  // Same-agent miss collapses to ONE 404 non-disclosure (an unowned/foreign/absent
  // connection is indistinguishable); an offline target is a 409.
  const connectionOfAgent = await connectionBelongsToAgent(
    auth.companyUuid,
    session.agentUuid,
    params.connectionUuid,
  );
  if (!connectionOfAgent) {
    throw new ConnectionNotVisibleError();
  }
  const targetOnline = await isConnectionLive(auth.companyUuid, params.connectionUuid);
  if (!targetOnline) {
    throw new ConnectionOfflineError(params.connectionUuid);
  }

  // (5) Re-point the origin. *** SINGLE DELIBERATE REVERSAL of the write-once
  // `originConnectionUuid` invariant (resolveOrCreateSession stamps it once and never moves
  // it; assertContinuable refuses to route a continuation anywhere else). This explicit
  // user action is the ONLY path that moves it — the autonomous wake / resolve paths stay
  // write-once. companyUuid-scoped (ownership already proven above) so no cross-company
  // write is possible. The SAME sessionId/uuid/directIdeaUuid are untouched. ***
  await prisma.daemonSession.update({
    where: { uuid: params.sessionUuid, companyUuid: auth.companyUuid },
    data: { originConnectionUuid: params.connectionUuid },
  });

  // (6) Create the turn on the SAME session via the chokepoint (same sessionId/directIdeaUuid
  // → it lands on this very row, no new session), then deliver to the NEW origin connection.
  const turn = await createInstructionTurn({
    auth,
    agentUuid: session.agentUuid,
    sessionUuid: params.sessionUuid,
    sessionId: session.sessionId,
    directIdeaUuid: session.directIdeaUuid,
    instructionText,
  });

  // (7) Origin-only live delivery: ping ONLY the NEW origin connection (verified online in
  // (4)), carrying the PRECISE turnUuid so it runs ONLY this turn. Fire-and-forget +
  // non-fatal — the persisted turn + reconnect-backfill are the durability net.
  deliverTurnPing({
    companyUuid: auth.companyUuid,
    originConnectionUuid: params.connectionUuid,
    turnUuid: turn.uuid,
  });

  // Read back the re-pointed session so the caller (the UI) sees the new origin reflected —
  // the SAME session uuid/sessionId, now pointing at the online connection. Mapped to the
  // wire `SessionView` shape (ISO timestamps) inline rather than reaching for the session
  // service's private mapper.
  const updated = await prisma.daemonSession.findUnique({
    where: { uuid: params.sessionUuid },
  });
  if (!updated) {
    // The row was just updated above; a missing one means a torn write — surface it rather
    // than fabricate a stale view (no silent errors).
    throw new Error(
      `repointSessionOriginAndSend: session ${params.sessionUuid} missing after re-point`,
    );
  }

  const sessionView: SessionView = {
    uuid: updated.uuid,
    agentUuid: updated.agentUuid,
    sessionId: updated.sessionId,
    directIdeaUuid: updated.directIdeaUuid,
    originConnectionUuid: updated.originConnectionUuid,
    status: updated.status,
    title: updated.title,
    lastTurnAt: updated.lastTurnAt.toISOString(),
    totalInputTokens: updated.totalInputTokens,
    totalOutputTokens: updated.totalOutputTokens,
    createdAt: updated.createdAt.toISOString(),
    updatedAt: updated.updatedAt.toISOString(),
  };

  return { session: sessionView, turn };
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

  // Naming enrichment, both batched (one query each) and run IN PARALLEL since they are
  // independent — halving the added latency on this 15s-polled endpoint:
  //  - firstInstruction: the earliest `human_instruction` per session (shared helper),
  //    so an ad-hoc conversation is named by what the human first said.
  //  - ideaTitle: the anchoring idea's title, so an idea-anchored conversation is named
  //    by its resource (badge + title) instead of a uuid.
  const ideaUuids = [
    ...new Set(sessions.map((s) => s.directIdeaUuid).filter((u): u is string => !!u)),
  ];
  // Fire both independent reads, then await together (parallel, halved added latency).
  const firstInstructionPromise = getFirstInstructionBySessionUuid(
    sessions.map((s) => s.uuid),
  );
  const ideasPromise: Promise<{ uuid: string; title: string }[]> =
    ideaUuids.length > 0
      ? prisma.idea.findMany({
          where: { companyUuid: auth.companyUuid, uuid: { in: ideaUuids } },
          select: { uuid: true, title: true },
        })
      : Promise.resolve([]);
  const firstInstructionBySession = await firstInstructionPromise;
  const ideas = await ideasPromise;
  const ideaTitleByUuid = new Map(ideas.map((i) => [i.uuid, i.title]));

  return sessions.map((s) => ({
    ...s,
    originOnline: onlineConnectionUuids.has(s.originConnectionUuid),
    firstInstruction: firstInstructionBySession.get(s.uuid) ?? null,
    ideaTitle: s.directIdeaUuid ? ideaTitleByUuid.get(s.directIdeaUuid) ?? null : null,
  }));
}
