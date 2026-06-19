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
// FAILURE ISOLATION (repo "no silent errors" + the wake notification must always
// survive): turn creation runs AFTER the notification row already exists, and any
// throw is logged VISIBLY (never swallowed) but is NOT propagated — a lost turn must
// never abort or block the notification that was already created. The caller invokes
// this fire-and-forget; it returns the created turn (for tests / callers that want it)
// or null when no turn was created (recipient is a human, the agent has no online
// daemon, the action is not wake-triggering, or creation failed and was logged).

import logger from "@/lib/logger";
import {
  resolveOrCreateSession,
  createPendingTurn,
  resolveDirectIdeaUuid,
  type TurnTrigger,
  type TurnView,
} from "@/services/daemon-session.service";
import { listConnectionsForAgent } from "@/services/daemon-connection.service";
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
// The `DaemonSessionTurn.trigger` enum is the NARROW 5-value taxonomy
// (task_assigned | mentioned | elaboration | resume | human_instruction). This table
// collapses each wake action into its canonical trigger category so every
// wake-triggering notification yields exactly one turn:
//   - @mention                                   → mentioned
//   - elaboration request / answer               → elaboration
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
}

/**
 * For a wake-triggering notification destined for a DAEMON agent, record the matching
 * `DaemonSessionTurn`. Composes (never reimplements) the daemon-session service:
 *
 *  1. Map `action → trigger`; bail (null) if the action is not wake-triggering.
 *  2. Only agent recipients can be daemons — bail for `user` recipients.
 *  3. Resolve the agent's ONLINE origin connection (`listConnectionsForAgent`, already
 *     sorted online-first; the first `effectiveStatus === "online"` entry owns the
 *     cwd-bound transcript). No online connection ⇒ no daemon to wake ⇒ bail (null).
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
 * agent offline, or a logged failure).
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
    // (3) Resolve the agent's online origin connection (cwd-bound transcript owner).
    // listConnectionsForAgent is sorted online-first, then lastSeenAt desc, so the
    // first online entry is the freshest connection to pin the session to.
    const connections = await listConnectionsForAgent(
      ctx.companyUuid,
      ctx.recipientUuid,
    );
    const origin = connections.find((c) => c.effectiveStatus === "online");
    if (!origin) {
      // No online daemon for this agent — nothing to wake, so no turn. (Not an error:
      // a notification can target an agent with no running daemon.)
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
