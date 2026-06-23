// src/services/notification-turn.ts
// Wake-notification → DaemonSessionTurn bridge (子1 — daemon-session-conversation).
//
// `notification.service` create/createBatch is the SINGLE chokepoint where every
// wake-triggering Notification row is born — symmetric for autonomous wakes
// (task dispatch / @mention / elaboration / PM-flow transitions) and the human-typed
// instruction (子2). This module is the bridge that, for such a notification destined
// for a DAEMON agent, records the corresponding `DaemonSessionTurn` so the daemon's
// Claude conversation gains one turn per wake.
//
// It NEVER reimplements session/turn logic — it composes the daemon-session service
// (`resolveOrCreateSession` + `createPendingTurn` + `resolveDirectIdeaUuid`) and the
// connection registry (`listConnectionsForAgent`, to pin the cwd-bound origin).
//
// ONLINE-ONLY WAKE: only an ONLINE connection is wakeable. A pin only ever wakes when
// it matches an online connection; an offline/no-match pin falls through to online-first,
// and when the agent has NO online connection at all, no turn is created — the
// already-created Notification stands as the plain record (a fully-offline target is a
// notification-only event; there is NO durable queue / backfill of pending turns).
//
// FAILURE ISOLATION (repo "no silent errors" + the wake notification must always
// survive): turn creation runs AFTER the notification row already exists, and any
// throw is logged VISIBLY (never swallowed) but is NOT propagated — a lost turn must
// never abort or block the notification that was already created. The caller invokes
// this fire-and-forget; it returns the created turn (for tests / callers that want it)
// or null when no turn was created (recipient is a human, the agent has no online
// daemon, the action is not wake-triggering, or creation failed and was logged).

import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import {
  resolveOrCreateSession,
  createPendingTurn,
  resolveDirectIdeaUuid,
  type TurnTrigger,
  type TurnView,
} from "@/services/daemon-session.service";
import {
  listConnectionsForAgent,
  type ConnectionView,
} from "@/services/daemon-connection.service";
import type { LineageEntityType } from "@/services/lineage.service";

const turnLogger = logger.child({ module: "notification-turn" });

// ===== Action → trigger mapping =====
//
// The `Notification.action` values that imply the daemon should ACT are the daemon's
// wake set (`cli/prompts.mjs` WAKE_ACTIONS) intersected with what actually flows
// through `notification.service` (a persisted Notification row). Verified against the
// code, NOT memory:
//   - `notification-listener.ts` resolveNotificationType emits the prefixed action
//     forms: task_assigned, task_verified, task_reopened, idea_claimed,
//     proposal_approved, proposal_rejected, elaboration_requested,
//     elaboration_answered (plus non-wake noise: task_status_changed,
//     task_submitted_for_verify, comment_added, report_created).
//   - `mention.service.ts` creates `action: "mentioned"` directly (bypasses the
//     listener), which IS a wake action.
//   - `resource_resumed` is a SYNTHETIC control-channel dispatch (子3) — it is NEVER
//     a persisted Notification, so it cannot reach this chokepoint and is therefore
//     deliberately absent here.
//   - `human_instruction` is the UI-sent instruction (子2): the chokepoint receives a
//     Notification with that action and the free-text body in `instructionText`.
//
// The `DaemonSessionTurn.trigger` enum is the NARROW 6-value taxonomy
// (task_assigned | mentioned | elaboration | elaboration_verified | resume |
// human_instruction). This table collapses each wake action into its canonical
// trigger category so every wake-triggering notification yields exactly one turn:
//   - @mention                                   → mentioned
//   - elaboration request / answer               → elaboration
//   - elaboration verified (human-verify wake)   → elaboration_verified (distinct from
//                                                  the "answer the questions" elaboration
//                                                  trigger — this one means "write the
//                                                  proposal")
//   - human-typed instruction                    → human_instruction
//   - every other autonomous dispatch (task
//     assignment, task reopen/verify unblock,
//     idea claim, proposal approve/reject)       → task_assigned (the autonomous
//                                                  task-dispatch trigger)
//
// A `Notification.action` NOT present in this table is not wake-triggering: no turn is
// created (the daemon would not wake on it either). Exhaustive + explicit so a
// reviewer sees exactly which actions map where — no implicit fallthrough.
export const NOTIFICATION_ACTION_TO_TURN_TRIGGER: Record<string, TurnTrigger> = {
  // @mention — the explicit "I need you" signal.
  mentioned: "mentioned",
  // Elaboration round opened / answered on an idea.
  elaboration_requested: "elaboration",
  elaboration_answered: "elaboration",
  // Human verified the elaboration → wake the assigned daemon agent to WRITE THE
  // PROPOSAL. Distinct from the elaboration request/answer triggers ("answer the
  // questions") so the daemon prompt can tell the two intents apart.
  elaboration_verified: "elaboration_verified",
  // Human-typed instruction (子2 UI send box). Canonical text on the turn; the
  // notification carries a denormalized copy in `instructionText`.
  human_instruction: "human_instruction",
  // Autonomous task-style dispatches — all map to the task_assigned trigger.
  task_assigned: "task_assigned",
  task_reopened: "task_assigned",
  task_verified: "task_assigned",
  idea_claimed: "task_assigned",
  proposal_approved: "task_assigned",
  proposal_rejected: "task_assigned",
};

/**
 * The `Notification.entityType` values that the lineage resolver understands. A
 * notification can also target a `comment` (and the entityType column is free text),
 * but lineage only walks task/document/proposal/idea — so a non-lineage entityType is
 * treated as having no idea anchor (the session is then ad-hoc, keyed on the
 * notification entity uuid) rather than throwing.
 */
const LINEAGE_ENTITY_TYPES = new Set<string>(["task", "document", "proposal", "idea"]);

/**
 * Resolve the trigger for a notification action, or null when the action is not
 * wake-triggering (so the caller skips turn creation entirely).
 */
export function triggerForAction(action: string): TurnTrigger | null {
  return NOTIFICATION_ACTION_TO_TURN_TRIGGER[action] ?? null;
}

/**
 * Parameters this bridge needs from the notification chokepoint. A structural subset
 * of `NotificationCreateParams` plus the optional human-instruction body — kept narrow
 * so the bridge is trivially unit-testable with plain fixtures.
 */
export interface WakeNotificationContext {
  companyUuid: string;
  recipientType: string;
  recipientUuid: string;
  entityType: string;
  entityUuid: string;
  action: string;
  // Free-text body for a `human_instruction` notification (子2). The canonical copy
  // lives on the created turn's `promptText`; the notification row carries the
  // denormalized copy. Null/undefined for autonomous wakes.
  instructionText?: string | null;
  // Pinned target daemon instance carried by a `mentioned` wake (cwd-addressable
  // instances): the owner-chosen `(host, cwd)` parsed from the mention markup and
  // threaded here by mention.service. The wake resolves it to a matching ONLINE
  // connection and pins the session origin there. A `task_assigned` wake does NOT use
  // these — it reads its pin from the Task's `targetHost`/`targetCwd` columns (the
  // durable storage) instead. Both undefined/null → no pin (online-first, exactly as
  // before). `pinnedHost` "" = unknown-host instance; `pinnedCwd` null = unknown-path
  // instance.
  pinnedHost?: string | null;
  pinnedCwd?: string | null;
}

/**
 * A resolved pinned target instance: the durable "place" `(host, cwd)` an owner chose
 * for a wake (cwd-addressable instances). `host` is "" for an unknown-host instance;
 * `cwd` is null for an unknown-path (legacy null-cwd) instance — the SAME sentinels the
 * connection registry uses, so a pin matches a `ConnectionView` by strict `(host, cwd)`
 * equality (then gated on ONLINE by selectOriginConnection). A wake with no pin yields
 * `null` (not this shape).
 */
interface PinnedTarget {
  host: string;
  cwd: string | null;
}

/**
 * Resolve the wake's pinned target instance — the durable `(host, cwd)` an owner chose
 * (cwd-addressable instances, T5) — or null when the wake carries no pin. DEC-5: the
 * cwd is NEVER inferred from the project; the ONLY pin sources are the two explicit
 * owner choices below.
 *
 *  - `mentioned` wake: the pin travels in the mention markup and is threaded onto the
 *    context (`ctx.pinnedHost`/`ctx.pinnedCwd`) by mention.service.
 *  - `task_assigned` wake on a TASK entity: the pin is the durable storage on the Task
 *    itself — its `targetHost`/`targetCwd` columns (T1/T4). Read here against the
 *    company-scoped row; a missing row or both-null columns is "no pin".
 *
 * Every other wake (elaboration / elaboration_verified / human_instruction, or a
 * task_assigned-trigger action on a non-task entity such as idea_claimed /
 * proposal_*) carries no pinned instance, so this returns null and the caller uses the
 * unchanged online-first selection. A pin where BOTH host is "" AND cwd is null is
 * treated as "no pin" — there is nothing to disambiguate against (it matches any
 * unknown/legacy instance), so it falls through to online-first rather than narrowing.
 */
async function resolvePinnedTarget(
  ctx: WakeNotificationContext,
  trigger: TurnTrigger,
): Promise<PinnedTarget | null> {
  let host: string | null | undefined;
  let cwd: string | null | undefined;

  if (trigger === "mentioned") {
    // @mention pin threaded from the mention markup by mention.service.
    host = ctx.pinnedHost;
    cwd = ctx.pinnedCwd;
  } else if (trigger === "task_assigned" && ctx.entityType === "task") {
    // Task-assignment pin: the durable storage is the Task's own columns (T1/T4). Only
    // a wake anchored on the task entity reads them — never inferred from the project.
    const task = await prisma.task.findFirst({
      where: { uuid: ctx.entityUuid, companyUuid: ctx.companyUuid },
      select: { targetHost: true, targetCwd: true },
    });
    host = task?.targetHost;
    cwd = task?.targetCwd;
  }

  // No host AND no cwd was recorded → no pin (online-first, exactly as before). A pin
  // is "present" when EITHER coordinate was recorded. Note: an unknown-host ("") +
  // unknown-path (null) pin carries no disambiguating information, so we treat it as
  // no pin and fall through to online-first rather than forcing a match.
  const hasHost = host != null && host !== "";
  const hasCwd = cwd != null && cwd !== "";
  if (!hasHost && !hasCwd) return null;

  // Normalize to the registry's sentinels: host "" = unknown-host, cwd null =
  // unknown-path. (A pin that recorded only one coordinate keeps the other at its
  // sentinel so the (host, cwd) equality below behaves predictably.)
  return { host: host ?? "", cwd: cwd != null && cwd !== "" ? cwd : null };
}

/**
 * Select the ONLINE origin connection for the wake (cwd-addressable instances):
 *
 *  - With a pin: the connection whose `(host, cwd)` EXACTLY matches the pinned place AND
 *    is ONLINE. Only an online match can be woken, so the pin wakes the daemon at that
 *    exact place when it is running. An OFFLINE match is NOT wakeable — there is no
 *    durable queue / backfill, so an offline pin is treated as "no match" and falls
 *    through to online-first below.
 *  - With a pin that matches no ONLINE connection (offline match, or the place is not
 *    registered at all), or no pin: fall back to the online-first selection
 *    (`effectiveStatus === "online"`, first entry — the list is already sorted
 *    online-first then lastSeenAt desc), exactly as an un-pinned wake.
 *
 * Returns the chosen ONLINE `ConnectionView`, or null when there is nothing to wake (no
 * online connection at all — the agent has no running daemon). A null result means the
 * caller creates NO turn; the already-created Notification stands as the plain record.
 */
function selectOriginConnection(
  connections: ConnectionView[],
  pin: PinnedTarget | null,
): ConnectionView | null {
  if (pin) {
    // Strict (host, cwd) equality against the registry's sentinels, gated on ONLINE: a
    // pin only wakes the daemon at that exact place when it is actually running. An
    // offline match is not wakeable and is ignored here (no durable queue).
    const matched = connections.find(
      (c) =>
        c.host === pin.host &&
        c.cwd === pin.cwd &&
        c.effectiveStatus === "online",
    );
    if (matched) return matched;
    // Pin matched no ONLINE connection (offline place, or not registered at all):
    // fall through to online-first, exactly as an un-pinned wake.
  }

  // No pin, or pin matched no online connection → online-first (the existing behavior).
  // The list is pre-sorted online-first, so the first online entry is the freshest
  // connection. None online → null → no turn (a notification-only event).
  return connections.find((c) => c.effectiveStatus === "online") ?? null;
}

/**
 * For a wake-triggering notification destined for a DAEMON agent, record the matching
 * `DaemonSessionTurn`. Composes (never reimplements) the daemon-session service:
 *
 *  1. Map `action → trigger`; bail (null) if the action is not wake-triggering.
 *  2. Only agent recipients can be daemons — bail for `user` recipients.
 *  3. Resolve the wake's pinned target instance (cwd-addressable instances): the
 *     mention's `(host, cwd)` for a `mentioned` wake, the Task's `targetHost`/`targetCwd`
 *     for a `task_assigned` wake on a task, else none (DEC-5: NEVER inferred from the
 *     project). Then pick the ONLINE origin connection: the `(host, cwd)`-matching
 *     ONLINE connection when pinned, else online-first. An offline pin (or one matching
 *     no online place) is NOT wakeable — there is no durable queue — so it falls through
 *     to online-first. No online connection at all ⇒ bail (null): the agent is fully
 *     offline and the already-created Notification stands as the plain record.
 *  4. Derive the session id: the entity's `directIdeaUuid` via lineage when the
 *     entityType is lineage-walkable, else the entity uuid (ad-hoc session). This is
 *     the stable `(agentUuid, sessionId)` business key.
 *  5. `resolveOrCreateSession` (stamps origin + directIdeaUuid write-once) then
 *     `createPendingTurn` with the mapped trigger. For `human_instruction`, the turn's
 *     `promptText` is the instruction body (canonical).
 *
 * FAILURE ISOLATION: any throw from steps 3-5 is caught, logged VISIBLY, and swallowed
 * to null — a turn-creation failure MUST NOT abort or block the already-created
 * notification (the notification row exists before this runs). Returns the created
 * `TurnView`, or null when no turn was created (not wake-triggering, human recipient,
 * nothing to wake, or a logged failure).
 */
export async function maybeCreateTurnForWakeNotification(
  ctx: WakeNotificationContext,
): Promise<TurnView | null> {
  // (1) Not a wake-triggering action → no turn (and the daemon would not wake either).
  const trigger = triggerForAction(ctx.action);
  if (!trigger) return null;

  // (2) Only agents can be daemons; a human recipient never owns a daemon session.
  if (ctx.recipientType !== "agent") return null;

  try {
    // (3) Resolve the agent's connections, then select the ONLINE origin (cwd-bound
    // transcript owner) honoring any pinned target instance. listConnectionsForAgent is
    // sorted online-first, then lastSeenAt desc.
    const connections = await listConnectionsForAgent(
      ctx.companyUuid,
      ctx.recipientUuid,
    );
    // The wake's pinned (host, cwd), or null when un-pinned. DEC-5: cwd is only ever the
    // explicit pin — never inferred from the project.
    const pin = await resolvePinnedTarget(ctx, trigger);
    // Pin-aware selection: the (host, cwd)-matching ONLINE connection when pinned, else
    // online-first. Only an online connection is wakeable — an offline pin (or one with
    // no online match) falls through to online-first; none online → no turn.
    const origin = selectOriginConnection(connections, pin);
    if (!origin) {
      // Nothing to wake: the agent has no online daemon (whether or not a pin was set).
      // This is NORMAL, not an error: a notification can target a fully-offline agent.
      // The already-created Notification stands as the plain record — there is no durable
      // queue / backfill of pending turns.
      return null;
    }

    // (4) Session id = the entity's direct idea (when lineage-walkable), else the
    // entity uuid (ad-hoc). directIdeaUuid stays null for an ad-hoc session.
    let directIdeaUuid: string | null = null;
    if (LINEAGE_ENTITY_TYPES.has(ctx.entityType)) {
      directIdeaUuid = await resolveDirectIdeaUuid(
        ctx.companyUuid,
        ctx.entityType as LineageEntityType,
        ctx.entityUuid,
      );
    }
    const sessionId = directIdeaUuid ?? ctx.entityUuid;

    // (5) Resolve-or-create the session (origin + directIdeaUuid write-once on create),
    // then append the pending turn. For human_instruction the canonical free-text body
    // lives on the turn's promptText.
    const session = await resolveOrCreateSession({
      companyUuid: ctx.companyUuid,
      agentUuid: ctx.recipientUuid,
      sessionId,
      directIdeaUuid,
      originConnectionUuid: origin.uuid,
    });

    const promptText =
      trigger === "human_instruction" ? ctx.instructionText ?? null : null;

    const turn = await createPendingTurn({
      sessionUuid: session.uuid,
      trigger,
      promptText,
    });
    return turn;
  } catch (error) {
    // VISIBLE failure (repo "no silent errors"): log with full context but DO NOT
    // rethrow — the notification was already created and must not be aborted by a
    // turn-creation failure.
    turnLogger.error(
      {
        err: error,
        companyUuid: ctx.companyUuid,
        agentUuid: ctx.recipientUuid,
        action: ctx.action,
        entityType: ctx.entityType,
        entityUuid: ctx.entityUuid,
      },
      "Failed to create DaemonSessionTurn for wake notification (notification was still created)",
    );
    return null;
  }
}
