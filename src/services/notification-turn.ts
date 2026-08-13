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
// ONLINE-ONLY WAKE: only an ONLINE connection is wakeable. When the agent has NO online
// connection at all, no turn is created — the already-created Notification stands as the
// plain record (a fully-offline target is a notification-only event; there is NO durable
// queue / backfill of pending turns).
//
// DIRECTED LIVE DELIVERY (fix-pinned-wake-directed-delivery, T1): a PINNED autonomous wake
// (`mentioned` with a markup pin, or an assignment wake whose Task / root Idea is pinned to
// an `agent_instance`) and the idea-anchored `elaboration_verified` wake are DIRECTED so
// only the resolved instance wakes — mirroring the `human_instruction` keystone (子2). When
// such a wake resolves to an ONLINE target connection, the turn is created against THAT
// connection's session and a `deliver_turn` control ping is emitted on its
// `control:{connectionUuid}` channel (fire-and-forget + non-fatal; the persisted turn +
// reconnect backfill are the durability net). The resolved target is also surfaced
// TRANSPORT-ONLY to the daemon (see `WakeTurnResult.targetConnectionUuid`) so non-target
// daemons suppress their broadcast copy.
//
// HARD PINS — the UNIFIED offline policy (owner choice B, pin-cwd-before-wake): EVERY pin
// is HARD. Whether the pin came from a human-typed mention `(host, cwd)` OR from an
// assignment (the Task's own `agent_instance` override, or the inherited root-Idea
// instance), an offline pin is NOTIFY-ONLY, NO WAKE — no turn, no ping, no target; the
// already-created Notification stands as the plain record (recovered on reconnect by the
// pending-turn backfill for recoverable triggers). This is a deliberate REVERSAL of #354's
// "offline pin → online-first": silently re-routing a pinned wake to a cwd the owner did
// NOT choose is the user-visible defect this preserves the fix for. There is NO SOFT
// assignment pin any more — an assignment pin NEVER degrades to the agent's online-first
// connection. (The `PinnedTarget.soft` field is RETAINED at always-`false` for a minimal
// diff — see `PinnedTarget.soft` — so the `soft:true` branch of `selectOriginConnection`
// is now unreachable dead code kept only for the field's shape; a follow-up may drop it.)
// An UN-PINNED wake is unaffected and still goes broadcast → online-first.
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
  findReusablePendingInstructionTurn,
  resolveDirectIdeaUuid,
  type TurnTrigger,
  type TurnView,
} from "@/services/daemon-session.service";
import {
  listConnectionsForAgent,
  type ConnectionView,
} from "@/services/daemon-connection.service";
import { deliverTurnPing } from "@/services/daemon-instruction.service";
import {
  resolveRootIdea,
  type LineageEntityType,
} from "@/services/lineage.service";

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
  // Human clicked Start Development → wake the assigned daemon agent to CLAIM AND
  // EXECUTE ALL REMAINING TASKS. Its OWN trigger — deliberately NOT collapsed into
  // task_assigned (that collapse was the anti-pattern behind the 0.13.0 random-cwd
  // wake defect) — so turns stay observable and the session-origin upgrade applies
  // by design.
  start_development: "start_development",
  // Human clicked Yolo → wake the assigned daemon agent to DRIVE THE WHOLE IDEA
  // TO DONE via the yolo skill. Its OWN trigger, for the same reasons as
  // start_development — never collapsed into task_assigned, so turns stay
  // observable and the session-origin upgrade applies by design.
  yolo_requested: "yolo_requested",
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
 * The AUTONOMOUS, idea-anchored triggers eligible for the idea-session-origin upgrade
 * (fix-proposal-wake-session-origin): when the connection selection is still
 * `online_first` and the wake resolves to an idea anchor, the upgrade re-points it to the
 * idea's existing `DaemonSession` origin (where that idea's conversation already lives)
 * instead of fanning out to an arbitrary online cwd.
 *
 * These are exactly the wakes the daemon raises autonomously against idea-lineage work:
 *   - `task_assigned` — the collapse target for `proposal_approved` / `proposal_rejected`
 *     (the random-cwd defect being fixed), `idea_claimed`, `task_verified`, `task_reopened`.
 *   - `elaboration` — elaboration request / answer wakes on an idea.
 *   - `elaboration_verified` — the human "Verify Elaborate" → write-the-proposal wake (the
 *     original, now-generalized, home of this upgrade).
 *
 * `mentioned` and `human_instruction` are DELIBERATELY EXCLUDED: an un-pinned `mentioned`
 * wake is contractually a broadcast → online-first (stamping no target), a pinned mention
 * is resolved as a HARD pin before this branch, and `human_instruction` resolves its own
 * exact target + `deliver_turn` ping in `daemon-instruction.service` — upgrading it here
 * would double-deliver or mis-route. Both carry their own target resolution, so the
 * heuristic session-origin upgrade must never touch them.
 */
const IDEA_SESSION_ORIGIN_UPGRADE_TRIGGERS = new Set<TurnTrigger>([
  "task_assigned",
  "elaboration",
  "elaboration_verified",
  // Start Development is a human stage-advance on an idea — the wake must land
  // where that idea's conversation already runs (elaboration decision Q2).
  "start_development",
  // Yolo is a human stage-advance on an idea — same session-origin requirement:
  // the full-auto run must continue the idea's existing conversation, not fan
  // out to an arbitrary online cwd.
  "yolo_requested",
]);

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
  projectUuid?: string | null;
  actorType?: string | null;
  actorUuid?: string | null;
  // Pinned target daemon instance carried by a `mentioned` wake (cwd-addressable
  // instances): the owner-chosen `(host, cwd)` parsed from the mention markup and
  // threaded here by mention.service. The wake resolves it to a matching ONLINE
  // connection and pins the session origin there. This is a HARD pin (a human typed an
  // exact place), so an offline mention pin stays notify-only (no wake, no re-route).
  // A `task_assigned` / `idea_claimed` wake does NOT use these — it reads its pin from
  // the assignment lineage (the Task's / root Idea's `agent_instance` assignee, also a
  // HARD pin now: notify-only when offline, never re-routed). Both undefined/null → no
  // pin (online-first, exactly as before). `pinnedHost` "" = unknown-host instance;
  // `pinnedCwd` null = unknown-path instance.
  pinnedHost?: string | null;
  pinnedCwd?: string | null;
  temporaryHost?: string | null;
  temporaryRuntimeCwd?: string | null;
  resolvedCwdSource?: string | null;
  resolvedCwdHost?: string | null;
  resolvedRuntimeCwd?: string | null;
  resolvedCwdAvailability?: "ready" | "offline" | "invalid" | null;
}

/**
 * A resolved pinned target instance: the durable "place" `(host, cwd)` an owner chose
 * for a wake (cwd-addressable instances). `host` is "" for an unknown-host instance;
 * `cwd` is null for an unknown-path (legacy null-cwd) instance — the SAME sentinels the
 * connection registry uses, so a pin matches a `ConnectionView` by strict `(host, cwd)`
 * equality (then gated on ONLINE by selectOriginConnection). A wake with no pin yields
 * `null` (not this shape).
 *
 * `soft` USED to record the pin's ORIGIN and govern a split offline policy. As of the
 * HARD-pin unification (owner choice B, pin-cwd-before-wake) EVERY pin is HARD, so this
 * field is now ALWAYS `false` at all three call sites (mention, task override, inherited
 * idea instance). It is RETAINED (rather than removed) for a minimal diff per Tech Design
 * D3 — the `soft:true` branch of `selectOriginConnection` is consequently unreachable dead
 * code that a follow-up cleanup may drop.
 *
 *  - `soft: false` (HARD, the only value produced now) — an offline pin stays NOTIFY-ONLY
 *    (no wake, no online-first re-route), so a pinned wake is never silently redirected to
 *    a cwd the owner did not choose — the deliberate #354 reversal documented in the file
 *    header, now applied uniformly to mention AND assignment pins.
 *  - `soft: true` (SOFT) — NO LONGER PRODUCED. Historically an assignment pin that degraded
 *    to online-first when offline; the degrade path is retired by the HARD-pin unification.
 */
interface PinnedTarget {
  host: string;
  cwd: string | null;
  soft: boolean;
  runtimeCwd?: string | null;
}

/**
 * Resolve an `AgentInstance` uuid to its durable `(host, cwd)` place for registry
 * matching, scoped to the company. Returns the place plus the instance's own
 * `agentUuid` (the same-agent guard reads it). Null when the instance row does not
 * exist (a stale assignment whose instance was never materialized) — the caller then
 * treats it as "no pin" and falls to online-first. The connection registry matches a
 * pin by strict `(host, cwd)` equality against these same `("" / null)` sentinels, so
 * the resolved place maps 1:1 to a `ConnectionView`.
 */
async function resolveInstancePlace(
  companyUuid: string,
  instanceUuid: string,
): Promise<{ host: string; cwd: string | null; agentUuid: string } | null> {
  const instance = await prisma.agentInstance.findFirst({
    where: { uuid: instanceUuid, companyUuid },
    select: { host: true, cwd: true, agentUuid: true },
  });
  return instance ?? null;
}

/**
 * Build a `PinnedTarget` from a `(host, cwd)` place, or null when the place carries no
 * disambiguating information (host "" AND cwd null) — that matches any unknown/legacy
 * instance, so it is treated as "no pin" and falls through to online-first rather than
 * forcing a match. Normalizes to the registry's sentinels (host "" = unknown-host, cwd
 * null = unknown-path) so the `(host, cwd)` equality in selectOriginConnection behaves
 * predictably. `soft` is threaded from the call site (the pin's origin).
 */
function makePinnedTarget(
  host: string | null | undefined,
  cwd: string | null | undefined,
  soft: boolean,
): PinnedTarget | null {
  const hasHost = host != null && host !== "";
  const hasCwd = cwd != null && cwd !== "";
  if (!hasHost && !hasCwd) return null;
  return { host: host ?? "", cwd: cwd != null && cwd !== "" ? cwd : null, soft };
}

/**
 * Resolve the wake's pinned target instance — the durable `(host, cwd)` an owner chose
 * (cwd-addressable instances) — or null when the wake carries no pin. DEC-5 (SCOPED): THIS
 * resolver NEVER infers cwd from the project; its ONLY pin sources are the explicit owner
 * choices below, resolved in PRIORITY ORDER and tagged with their origin (`soft`). The one
 * project-derived fallback — the agent-owner's fixed project cwd — is applied by the caller
 * (createTurnAndResolveTarget step 4a), BELOW the session-origin upgrade, replacing only the
 * online-first pick; see there:
 *
 *  1. mention pin (HARD, `soft:false`) — `trigger === "mentioned"`: a human typed an
 *     exact place in the mention markup, threaded onto the context
 *     (`ctx.pinnedHost`/`ctx.pinnedCwd`) by mention.service. No DB lookup: the registry
 *     match is on `(host, cwd)` directly.
 *  2. task override (HARD, `soft:false`) — the wake's TASK row is itself pinned
 *     (`assigneeType === "agent_instance"`): resolve that AgentInstance to its place.
 *     The explicit per-task override beats the inherited idea instance. HARD since the
 *     owner-choice-B unification: an offline task pin is notify-only, never re-routed.
 *  2.5 own-idea pin (HARD, `soft:false`) — when the wake's entity IS an idea, its OWN
 *     assignee pin (subject to the same-agent guard) beats an ancestor's. Symmetric
 *     with the task override: "the idea I'm acting on" wins over a root ancestor that
 *     is pinned to a different instance of the same agent. Only relevant for a
 *     multi-level idea lineage with divergent same-agent pins; for a top-level idea
 *     the own idea IS the root, so this and step 3 resolve identically.
 *  3. root-idea inheritance (HARD, `soft:false`) — resolve the wake's ROOT idea; if its
 *     assignee is an `agent_instance` AND that instance's `agentUuid` EQUALS the wake's
 *     target agent (`ctx.recipientUuid`, the SAME-AGENT GUARD), inherit the idea's
 *     instance place. A child resource targeting a DIFFERENT agent than the idea's
 *     instance does NOT inherit — it resolves against its own agent (online-first).
 *  4. else null → caller uses the unchanged online-first selection.
 *
 * Steps 2-3 apply to any non-mention wake whose entity is lineage-walkable (task /
 * document / proposal / idea). They are the mechanism behind both `task_assigned`
 * inheritance and the `idea_claimed` / `elaboration_verified` idea-instance priority:
 * an idea-anchored wake reads the idea's own assignee (step 2.5), then falls back to
 * the lineage root (step 3).
 */
async function resolvePinnedTarget(
  ctx: WakeNotificationContext,
  trigger: TurnTrigger,
): Promise<PinnedTarget | null> {
  // Stage-entry operations carry their actor-bearing target snapshot in the
  // activity. Consume it verbatim so preference/actor/registry changes cannot
  // alter the target between the stage action and notification delivery.
  if (ctx.resolvedCwdSource && ctx.resolvedCwdSource !== "unconfigured") {
    return {
      // An invalid fixed target is still a hard pin. The sentinel cannot match a
      // daemon host, producing the same notify-only behavior as an offline target.
      host:
        ctx.resolvedCwdAvailability === "invalid"
          ? "\u0000invalid-project-cwd"
          : (ctx.resolvedCwdHost ?? ""),
      cwd: null,
      runtimeCwd: ctx.resolvedRuntimeCwd,
      soft: false,
    };
  }

  if (ctx.temporaryHost && ctx.temporaryRuntimeCwd) {
    return {
      host: ctx.temporaryHost,
      cwd: null,
      runtimeCwd: ctx.temporaryRuntimeCwd,
      soft: false,
    };
  }

  // (1) Mention pin — HARD. A human typed an exact place; offline stays notify-only.
  if (trigger === "mentioned") {
    return makePinnedTarget(ctx.pinnedHost, ctx.pinnedCwd, false);
  }

  // Steps 2-3 are assignment lineage and only make sense for a lineage-walkable entity.
  // Every other wake (human_instruction, or a non-lineage entityType such as a comment)
  // carries no assignment pin → online-first.
  if (!LINEAGE_ENTITY_TYPES.has(ctx.entityType)) return null;

  // (2) Task override — HARD (owner choice B). The wake's own TASK row is pinned to an
  // instance. Only a wake anchored directly on a task entity has a per-task override; this
  // beats the inherited idea instance below. An offline task pin is notify-only, never
  // re-routed.
  if (ctx.entityType === "task") {
    const task = await prisma.task.findFirst({
      where: { uuid: ctx.entityUuid, companyUuid: ctx.companyUuid },
      select: {
        assigneeType: true,
        assigneeUuid: true,
        cwdHost: true,
        runtimeCwd: true,
      },
    });
    if (task?.assigneeType === "agent_instance" && task.assigneeUuid) {
      const place = await resolveInstancePlace(ctx.companyUuid, task.assigneeUuid);
      if (place) {
        // HARD (owner choice B): an assignment pin is never re-routed. An offline
        // task-override pin is notify-only, identical to a mention pin.
        const pin = task.runtimeCwd
          ? {
              host: task.cwdHost?.trim() ? task.cwdHost : place.host,
              cwd: null,
              runtimeCwd: task.runtimeCwd,
              soft: false,
            }
          : makePinnedTarget(place.host, place.cwd, false);
        if (pin) return pin;
      }
    }
  }

  // (2.5) Own-idea pin — HARD (owner choice B). When the wake's entity IS an idea, resolve ITS OWN
  // assignee pin first (its direct-idea anchor), so a directly-pinned child idea wins
  // over an ancestor pinned to a different instance of the same agent. Subject to the
  // same-agent guard. For a top-level idea the direct anchor equals the root, so this
  // simply short-circuits the identical step 3 lookup.
  if (ctx.entityType === "idea") {
    const ownIdeaUuid = await resolveDirectIdeaUuid(
      ctx.companyUuid,
      ctx.entityType as LineageEntityType,
      ctx.entityUuid,
    );
    const ownPin = await resolveIdeaInstancePin(ctx, ownIdeaUuid);
    if (ownPin) return ownPin;
  }

  // (3) Root-idea inheritance — HARD (owner choice B), gated on the SAME-AGENT GUARD. Resolve the wake's
  // root idea and read its assignee; inherit ONLY when the idea is instance-pinned AND
  // that instance belongs to the wake's TARGET agent. A cross-agent child does NOT
  // inherit (it resolves against its own agent → online-first).
  const rootIdeaUuid = await resolveRootIdeaUuidForPin(ctx);
  return resolveIdeaInstancePin(ctx, rootIdeaUuid);
}

/**
 * Autonomous-wake project cwd fallback (idea 5b8ee573 / project-cwd-anchoring). Resolve the
 * AGENT OWNER's fixed project cwd preference for `(project, agent)` into a HARD PinnedTarget,
 * or null when the agent has no owner or the owner set no preference (→ caller keeps the
 * unchanged online-first selection). This is the ONLY place the wake path derives a cwd from
 * the project — a SCOPED reversal of DEC-5 — and the caller (createTurnAndResolveTarget step
 * 4a) applies it BELOW the idea-session-origin upgrade, so a live online conversation is never
 * rerouted. The preference is stored PER USER (`@@unique([userUuid, projectUuid, agentUuid])`);
 * per the owner's elaboration decision an autonomous wake reads the AGENT OWNER's row. The
 * pin is HARD (`soft:false`): `makePinnedTarget` normalizes to the registry sentinels and
 * returns null for an empty `(host, cwd)`, so an unset/invalid preference falls through to
 * online-first rather than stalling on a garbage pin.
 */
async function resolveProjectOwnerCwdPin(
  companyUuid: string,
  agentUuid: string,
  projectUuid: string,
): Promise<PinnedTarget | null> {
  try {
    const agent = await prisma.agent.findFirst({
      where: { uuid: agentUuid, companyUuid },
      select: { ownerUuid: true },
    });
    if (!agent?.ownerUuid) return null;
    const preference = await prisma.projectAgentCwdPreference.findFirst({
      where: {
        companyUuid,
        userUuid: agent.ownerUuid,
        projectUuid,
        agentUuid,
      },
      select: { host: true, cwd: true },
    });
    if (!preference) return null;
    return makePinnedTarget(preference.host, preference.cwd, false);
  } catch (error) {
    // The project-owner cwd fallback is a BEST-EFFORT replacement for the online-first
    // pick. A failure resolving it must NOT drop the wake: log VISIBLY (no silent errors)
    // and degrade to the unchanged online-first selection rather than aborting the whole
    // turn via the caller's catch.
    turnLogger.warn(
      { err: error, companyUuid, agentUuid, projectUuid },
      "resolveProjectOwnerCwdPin failed; degrading to online-first",
    );
    return null;
  }
}

/**
 * Resolve an idea's own `agent_instance` assignee to a HARD PinnedTarget, applying the
 * SAME-AGENT GUARD (the idea's instance must belong to the wake's target agent). Returns
 * null when the idea uuid is null, the idea is not instance-pinned, or the guard fails —
 * a legitimate "no pin here" outcome. Shared by the own-idea (step 2.5) and root-idea
 * (step 3) resolution so both apply identical pin + guard semantics. HARD since the
 * owner-choice-B unification: an offline inherited pin is notify-only, never re-routed.
 */
async function resolveIdeaInstancePin(
  ctx: WakeNotificationContext,
  ideaUuid: string | null,
): Promise<PinnedTarget | null> {
  if (!ideaUuid) return null;
  const idea = await prisma.idea.findFirst({
    where: { uuid: ideaUuid, companyUuid: ctx.companyUuid },
    select: {
      assigneeType: true,
      assigneeUuid: true,
      cwdHost: true,
      runtimeCwd: true,
    },
  });
  if (idea?.assigneeType === "agent_instance" && idea.assigneeUuid) {
    const place = await resolveInstancePlace(ctx.companyUuid, idea.assigneeUuid);
    // SAME-AGENT GUARD: the idea's instance must belong to the wake's target agent.
    if (place && place.agentUuid === ctx.recipientUuid) {
      // HARD (owner choice B): an inherited idea-instance pin is never re-routed. An
      // offline pin is notify-only, identical to a mention pin.
      return idea.runtimeCwd
        ? {
            host: idea.cwdHost?.trim() ? idea.cwdHost : place.host,
            cwd: null,
            runtimeCwd: idea.runtimeCwd,
            soft: false,
          }
        : makePinnedTarget(place.host, place.cwd, false);
    }
  }
  return null;
}

/**
 * Resolve the ROOT idea uuid for the wake's entity via the shared lineage resolver, or
 * null when there is no idea ancestor (a quick task / standalone document / non-idea
 * proposal) — a legitimate "no pin to inherit" outcome, not an error. An `idea` entity
 * resolves to its OWN lineage root (so an idea-anchored wake reads the idea's assignee).
 * Reuses `resolveRootIdea` rather than the direct-idea anchor because inheritance is
 * rooted at the TOP of the lineage forest (DEC: the idea is the authoritative root).
 */
async function resolveRootIdeaUuidForPin(
  ctx: WakeNotificationContext,
): Promise<string | null> {
  const result = await resolveRootIdea(
    ctx.companyUuid,
    ctx.entityType as LineageEntityType,
    ctx.entityUuid,
  );
  return result.rootIdeaUuid;
}

/**
 * The outcome of resolving a wake's origin connection. `kind` records HOW the connection
 * was chosen, which governs directed live delivery downstream:
 *
 *  - `directed` — a PINNED (or idea-origin-resolved) wake matched a specific ONLINE
 *    connection. The turn is delivered to ONLY that connection (`deliver_turn` ping) and
 *    the target is surfaced transport-only so non-target daemons suppress their broadcast
 *    copy. `connection` is the resolved target.
 *  - `online_first` — an UN-PINNED wake fell to the first online connection. Behavior is
 *    byte-identical to before this change: broadcast → online-first, NO ping, NO target.
 *    `connection` is the chosen online-first connection.
 *  - `offline_pin` — a PINNED wake whose pin matched NO online connection. NOTHING is
 *    wakeable: NO turn, NO ping, NO target (notify-only). This deliberately does NOT fall
 *    back to online-first (REVERSES #354). `connection` is null.
 *  - `none` — the agent has NO online connection at all. NO turn (notification stands).
 *    `connection` is null.
 */
type OriginSelection =
  | { kind: "directed"; connection: ConnectionView }
  | { kind: "online_first"; connection: ConnectionView }
  | { kind: "offline_pin" }
  | { kind: "none" };

/**
 * Select the ONLINE origin connection for the wake (cwd-addressable instances), and
 * classify HOW it was chosen so the caller can drive directed live delivery:
 *
 *  - With a pin matching an ONLINE connection: the connection whose `(host, cwd)` EXACTLY
 *    matches the pinned place → `directed`. Only an online match can be woken, so the pin
 *    wakes the daemon at that exact place when it is running.
 *  - With a pin matching NO online connection → `offline_pin`: NOTHING is woken. NO durable
 *    queue, NO online-first fallback — silently re-routing a pinned wake to an unchosen cwd
 *    is the defect this preserves the fix for (the #354 REVERSAL). As of the owner-choice-B
 *    HARD-pin unification (pin-cwd-before-wake) this applies to EVERY pin — mention AND
 *    assignment — since `soft` is now always `false`. The `soft:true` fall-through branch
 *    below is RETAINED-but-UNREACHABLE dead code (no call site produces a soft pin any more);
 *    a follow-up cleanup may remove it and the `soft` field entirely.
 *  - With no pin: the online-first selection (`effectiveStatus === "online"`, first entry —
 *    the list is already sorted by stable daemon presence identity) → `online_first`.
 *    None online → `none`.
 *
 * A `directed`/`online_first` result carries the chosen ONLINE `ConnectionView`. An
 * `offline_pin`/`none` result carries no connection: the caller creates NO turn and the
 * already-created Notification stands as the plain record.
 */
function selectOriginConnection(
  connections: ConnectionView[],
  pin: PinnedTarget | null,
): OriginSelection {
  if (pin) {
    // Strict (host, cwd) equality against the registry's sentinels, gated on ONLINE: a
    // pin only wakes the daemon at that exact place when it is actually running.
    const matched = connections.find(
      (c) =>
        c.host === pin.host &&
        (pin.runtimeCwd ? true : c.cwd === pin.cwd) &&
        c.effectiveStatus === "online",
    );
    if (matched) return { kind: "directed", connection: matched };
    // Pin matched no ONLINE connection (offline place, or not registered at all) →
    // notify-only, NO wake, NO online-first fallback (the #354 reversal: a pinned wake is
    // never silently re-routed). Since the owner-choice-B HARD-pin unification every pin is
    // HARD (`soft:false`), so this branch ALWAYS fires for an offline pin. The `soft:true`
    // fall-through below is retained-but-unreachable dead code (no call site emits a soft
    // pin any more) — kept for a minimal diff per Tech Design D3.
    if (!pin.soft) {
      return { kind: "offline_pin" };
    }
    // (Unreachable) legacy SOFT-pin degrade → fall through to the online-first selection.
  }

  // No pin (or a degraded soft pin) → online-first. The list is pre-sorted
  // online-first with stable identity ties, so heartbeats do not reorder an
  // otherwise-equivalent connection set. None online → no turn.
  const onlineFirst = connections.find((c) => c.effectiveStatus === "online");
  return onlineFirst
    ? { kind: "online_first", connection: onlineFirst }
    : { kind: "none" };
}

/**
 * Resolve the directed ONLINE target for an AUTONOMOUS IDEA-ANCHORED wake: the connection
 * that OWNS the idea's existing daemon session (`DaemonSession.originConnectionUuid` for
 * the idea-anchored session), when that connection is ONLINE.
 *
 * This is the LOWER-priority "where does this idea's conversation live" heuristic — the
 * cwd where the idea's transcript already lives. It applies ONLY when the idea is NOT
 * pinned to an instance: an instance-pinned idea is resolved earlier as a HARD pin (the
 * root-idea step of `resolvePinnedTarget`), which yields a `directed` (online match) or
 * `offline_pin` (notify-only) selection and therefore SKIPS this upgrade. When no idea-anchored session
 * exists yet (the idea was elaborated entirely in the UI and the daemon was never woken on
 * it), or that origin is not currently online, this returns null → the caller falls back
 * to online-first (NO directed delivery), byte-identical to the pre-change wake.
 *
 * Shared by every trigger in `IDEA_SESSION_ORIGIN_UPGRADE_TRIGGERS` — originally the
 * `elaboration_verified` proposal-writing wake, now generalized so `proposal_approved` /
 * `proposal_rejected` / `idea_claimed` / task wakes (all mapped to `task_assigned`) and the
 * `elaboration` wakes land where the idea's conversation already runs instead of a random
 * online cwd (fix-proposal-wake-session-origin).
 *
 * `directIdeaUuid` is the idea anchor (the session business key for an idea-anchored
 * session); a null anchor (a non-idea-anchored wake, e.g. a standalone task) short-circuits
 * to null so the widened gate cannot mis-fire. `connections` is the agent's live registry,
 * already resolved by the caller. A query failure propagates to the caller's
 * failure-isolation guard.
 */
export async function resolveIdeaSessionOriginTarget(
  companyUuid: string,
  agentUuid: string,
  directIdeaUuid: string | null,
  connections: ConnectionView[],
): Promise<ConnectionView | null> {
  if (!directIdeaUuid) return null;
  // The idea-anchored session's business key is its directIdeaUuid (sessionId === idea).
  const session = await prisma.daemonSession.findFirst({
    where: { companyUuid, agentUuid, sessionId: directIdeaUuid },
    select: { originConnectionUuid: true },
  });
  if (!session) return null;
  // The origin must be ONLINE to be wakeable (no durable queue). An offline origin is
  // not directed — fall back to online-first.
  return (
    connections.find(
      (c) =>
        c.uuid === session.originConnectionUuid && c.effectiveStatus === "online",
    ) ?? null
  );
}

/**
 * The richer result of the wake-turn chokepoint: the created `DaemonSessionTurn` (or null
 * when none was created) PLUS the resolved DIRECTED target connection uuid (or null).
 *
 * `targetConnectionUuid` is non-null ONLY for a DIRECTED wake — a pinned `mentioned` /
 * `task_assigned` whose pin matched an ONLINE connection, or an `elaboration_verified`
 * whose idea-session origin is ONLINE. It is the resolved connection the `deliver_turn`
 * ping was sent to, and the value the daemon uses for broadcast suppression (TRANSPORT-
 * ONLY — see the surfacing note on `notification.service`). It is NULL for an un-pinned
 * wake (broadcast → online-first, unchanged) and for an offline-pin / no-online-target
 * wake (notify-only, no wake).
 *
 * `suppressWake` distinguishes the OFFLINE-PIN case from the un-pinned case, which would
 * OTHERWISE be indistinguishable at the daemon (both carry `targetConnectionUuid: null`).
 * It is `true` ONLY for an `offline_pin` selection — a PINNED wake whose pin matched NO
 * online connection. The daemon reads this transport-only flag off the `new_notification`
 * SSE event and suppresses the broadcast wake on EVERY connection (Q2 — notify-only, no
 * wake), realizing the design's "no daemon matches → every connection suppresses" intent
 * without depending on a non-null sentinel. It is `false` for an un-pinned wake (so the
 * broadcast wakes online-first, byte-identical to before), for a directed wake (the target
 * wakes), and for `none` (agent fully offline — nobody is connected to suppress anyway, and
 * a momentarily-no-online un-pinned wake must stay byte-identical to before).
 */
export interface WakeTurnResult {
  turn: TurnView | null;
  targetConnectionUuid: string | null;
  runtimeCwd: string | null;
  suppressWake: boolean;
}

/**
 * The full wake-turn chokepoint: for a wake-triggering notification destined for a DAEMON
 * agent, record the matching `DaemonSessionTurn`, and — when the wake is DIRECTED — emit a
 * `deliver_turn` control ping to the resolved target and surface that target. Composes
 * (never reimplements) the daemon-session service:
 *
 *  1. Map `action → trigger`; bail if the action is not wake-triggering.
 *  2. Only agent recipients can be daemons — bail for `user` recipients.
 *  3. Resolve the wake's pinned target instance via assignment LINEAGE (cwd-addressable
 *     instances): the mention's `(host, cwd)` for a `mentioned` wake; else the Task's own
 *     `agent_instance` override, then the root Idea's `agent_instance` assignee under the
 *     same-agent guard; else none here (DEC-5 is now SCOPED — this lineage step never infers
 *     from the project, but step 4a below adds the agent-owner project-cwd fallback). ALL pins are
 *     HARD now (owner choice B). Select the ONLINE origin, classified by HOW it was chosen:
 *       - `directed`     — pin matched an ONLINE connection (turn delivered to ONLY it).
 *       - `online_first` — un-pinned → first online (broadcast → online-first).
 *       - `offline_pin`  — a HARD pin (mention OR assignment) matched NO online connection →
 *                          notify-only, NO turn, NO fallback (REVERSES #354).
 *       - `none`         — agent fully offline → NO turn (the notification stands).
 *  4. `elaboration_verified` / `idea_claimed`: the idea's `agent_instance` assignee (step 3)
 *     is the HIGHER-priority pin and is resolved above. ONLY when the idea has no
 *     assignee-instance (selection stayed `online_first`) does the LOWER-priority
 *     session-origin heuristic apply: if the idea has an existing ONLINE session origin,
 *     UPGRADE the selection to `directed` on that origin so the proposal-writing wake lands
 *     where the idea's conversation already lives — else stay `online_first`.
 *  4a. Project-owner cwd fallback (idea 5b8ee573): if selection is STILL `online_first` after
 *     step 4 (no instance pin, no online session-origin) for an autonomous idea-anchored /
 *     stage-advance trigger, resolve the AGENT OWNER's fixed project cwd and, when set,
 *     re-select against it as a HARD pin — replacing the arbitrary "first cwd". Offline
 *     pinned cwd → `offline_pin` (notify-only), never re-routed.
 *  5. Derive the session id: the entity's `directIdeaUuid` via lineage when the entityType
 *     is lineage-walkable, else the entity uuid (ad-hoc). For a CROSS-CWD directed mention
 *     (the resolved target differs from the idea's existing session origin), the resolved
 *     INSTANCE participates in the session business key so each `(host, cwd)` keeps its own
 *     cwd-bound transcript — NEVER re-pointing the existing session's origin (which would
 *     `No conversation found` on `--resume`).
 *  6. `resolveOrCreateSession` (origin + directIdeaUuid write-once on create) then
 *     `createPendingTurn` with the mapped trigger. For `human_instruction`, the turn's
 *     `promptText` is the instruction body (canonical); every other trigger has a null
 *     promptText (the daemon rebuilds the autonomous prompt from notification context).
 *  7. DIRECTED wake only: emit a `deliver_turn` control ping on the target connection's
 *     `control:{connectionUuid}` channel carrying the precise `turnUuid` (reuses the
 *     `human_instruction` keystone `deliverTurnPing`). Fire-and-forget + non-fatal (the
 *     persisted turn + reconnect backfill are the durability net). Surface the target.
 *
 * FAILURE ISOLATION: any throw from steps 3-7 is caught, logged VISIBLY, and swallowed —
 * a turn-creation/ping failure MUST NOT abort or block the already-created notification.
 * Returns `{ turn, targetConnectionUuid }` (turn null + target null when no turn created).
 */
export async function createTurnAndResolveTarget(
  ctx: WakeNotificationContext,
): Promise<WakeTurnResult> {
  const empty: WakeTurnResult = {
    turn: null,
    targetConnectionUuid: null,
    runtimeCwd: null,
    suppressWake: false,
  };

  // (1) Not a wake-triggering action → no turn (and the daemon would not wake either).
  const trigger = triggerForAction(ctx.action);
  if (!trigger) return empty;

  // (2) Only agents can be daemons; a human recipient never owns a daemon session.
  if (ctx.recipientType !== "agent") return empty;

  try {
    // (3) Resolve the agent's connections, then select the ONLINE origin (cwd-bound
    // transcript owner) honoring any pinned target instance. listConnectionsForAgent is
    // sorted online-first with stable identity ties.
    const connections = await listConnectionsForAgent(
      ctx.companyUuid,
      ctx.recipientUuid,
    );
    // The wake's pinned (host, cwd), or null when un-pinned. DEC-5 (SCOPED): the
    // assignment-lineage resolver NEVER infers cwd from the project; the ONE project-
    // derived fallback — the agent-owner's fixed project cwd — is applied later in step 4a,
    // BELOW the session-origin upgrade, replacing only the online-first pick.
    let pin = await resolvePinnedTarget(ctx, trigger);
    // Pin-aware selection, classified by HOW the origin was chosen (drives directed
    // delivery). A PINNED wake whose pin matched no online connection is `offline_pin` →
    // notify-only with NO online-first fallback (REVERSES #354).
    let selection = selectOriginConnection(connections, pin);

    // (3a) Session id = the entity's direct idea (when lineage-walkable), else the entity
    // uuid (ad-hoc). Resolved BEFORE the elaboration_verified upgrade because that origin
    // is keyed on the idea anchor.
    let directIdeaUuid: string | null = null;
    if (LINEAGE_ENTITY_TYPES.has(ctx.entityType)) {
      directIdeaUuid = await resolveDirectIdeaUuid(
        ctx.companyUuid,
        ctx.entityType as LineageEntityType,
        ctx.entityUuid,
      );
    }

    // (4) Idea-session-origin upgrade for AUTONOMOUS idea-anchored wakes (the family in
    // IDEA_SESSION_ORIGIN_UPGRADE_TRIGGERS: task_assigned — into which proposal_approved /
    // proposal_rejected / idea_claimed / task_* collapse — plus elaboration /
    // elaboration_verified). The idea's `agent_instance` assignee is the HIGHER-priority pin
    // already resolved in step 3 (resolvePinnedTarget reads the root/own idea's assignee).
    // When the idea IS instance-pinned, selection is already `directed` (instance online) or
    // `offline_pin` (instance offline — HARD, notify-only) — either way this upgrade is
    // SKIPPED (it only fires on `online_first`), so a HARD idea pin is NEVER re-routed to the
    // session origin. ONLY when the idea has no assignee-instance does selection stay
    // `online_first`, and THEN this LOWER-priority session-origin heuristic upgrades to the
    // idea's existing ONLINE session origin (where the idea's conversation already lives),
    // fixing the proposal approve/reject random-cwd wake. No session, an offline origin, or a
    // non-idea-anchored wake (directIdeaUuid null) → stays online-first.
    // `mentioned` / `human_instruction` are excluded from the set (they own their own target).
    if (
      IDEA_SESSION_ORIGIN_UPGRADE_TRIGGERS.has(trigger) &&
      selection.kind === "online_first"
    ) {
      const ideaTarget = await resolveIdeaSessionOriginTarget(
        ctx.companyUuid,
        ctx.recipientUuid,
        directIdeaUuid,
        connections,
      );
      if (ideaTarget) {
        selection = { kind: "directed", connection: ideaTarget };
      }
    }

    // (4a) Project-owner fixed-cwd fallback (idea 5b8ee573 / project-cwd-anchoring): when
    // the wake would OTHERWISE pick a raw first-online cwd — no instance pin (resolvePinned-
    // Target) AND no online session-origin upgrade above (selection still `online_first`) —
    // honor the AGENT OWNER's fixed project cwd instead of the arbitrary "first cwd". This is
    // the ONE deliberate, SCOPED reversal of DEC-5 ("never infer cwd from project"): it runs
    // only here, on the autonomous idea-anchored / stage-advance path, gated on the same
    // trigger family as the session-origin upgrade — so it can never override an instance pin
    // or a live online conversation (the b729713b fix wins, resolved above). HARD pin (owner
    // elaboration Q3 = strict): an offline pinned cwd becomes `offline_pin` (notify-only,
    // reconnect-backfill only to the original host+cwd), never re-routed. No owner or no
    // preference → `makePinnedTarget` null → selection stays `online_first`, unchanged.
    if (
      selection.kind === "online_first" &&
      IDEA_SESSION_ORIGIN_UPGRADE_TRIGGERS.has(trigger) &&
      ctx.projectUuid
    ) {
      const projectPin = await resolveProjectOwnerCwdPin(
        ctx.companyUuid,
        ctx.recipientUuid,
        ctx.projectUuid,
      );
      if (projectPin) {
        pin = projectPin;
        selection = selectOriginConnection(connections, projectPin);
      }
    }

    // offline_pin / none → NOTHING to wake. NO turn, NO ping, NO target. The already-
    // created Notification stands as the plain record. offline_pin specifically does NOT
    // fall back to online-first (the user-visible defect being fixed).
    //
    // offline_pin vs none — the distinction that DRIVES `suppressWake`: an OFFLINE-PIN wake
    // (a real pin matched no ONLINE connection) MUST wake NO instance even though OTHER
    // instances of the agent may be online and would otherwise broadcast→online-first. Since
    // it carries `targetConnectionUuid: null` exactly like an un-pinned wake, the daemon
    // cannot tell the two apart from the target alone — so we stamp `suppressWake: true` so
    // every connection suppresses (Q2 notify-only). `none` (the agent has NO online
    // connection at all) does NOT set the flag: nobody is connected to receive the broadcast,
    // and a momentarily-no-online UN-PINNED wake must remain byte-identical to before (no new
    // suppression behavior). So only `offline_pin` suppresses agent-wide.
    if (selection.kind === "offline_pin") {
      return { turn: null, targetConnectionUuid: null, runtimeCwd: pin?.runtimeCwd ?? null, suppressWake: true };
    }
    if (selection.kind === "none") {
      return empty;
    }

    const origin = selection.connection;
    const directed = selection.kind === "directed";
    const runtimeCwd = pin?.runtimeCwd ?? null;

    // (5) Session business key — ONE conversation per idea per agent (fix idea 2ddd1d11:
    // "switching daemon cwd / agent splits the chat into two threads → can't interrupt").
    // An idea-anchored session keys on directIdeaUuid and is NEVER forked into a
    // per-instance `${idea}::${conn}` thread. For a DIRECTED idea-anchored wake whose
    // resolved online origin differs from the idea's EXISTING canonical session origin (the
    // cross-cwd case — a pinned mention, a directed human_instruction, or a task-assignment
    // pin that resolves to another cwd), RE-POINT that canonical session's
    // originConnectionUuid to the resolved origin, so the user's turn AND the daemon's later
    // transcript / turn-lifecycle reports (which re-derive the plain idea uuid from lineage)
    // land on the SAME conversation — and the running turn stays interruptible from the
    // thread the user is viewing. This is the second — and only other — deliberate,
    // companyUuid-scoped reversal of the write-once originConnectionUuid invariant, alongside
    // repointSessionOriginAndSend (daemon-instruction.service). resolveOrCreateSession does
    // NOT move originConnectionUuid on an existing row (write-once there), so the re-point
    // MUST be this explicit update.
    //
    // R1 (live old origin): the re-point is UNCONDITIONAL on a directed cross-origin wake —
    // the newest directed wake defines where the idea's one conversation lives ("follow the
    // instance", elaboration Q1=a). A turn still running on the OLD origin keeps reporting
    // correctly (turn lifecycle keys on (agentUuid, sessionId), not the origin) and stays
    // interruptible via the idea-wide interrupt match, so re-pointing never orphans it.
    //
    // Re-pointing is safe for `claude --resume`: the daemon probes the transcript per-cwd,
    // so a session re-pointed to a new cwd simply starts a fresh session there rather than
    // failing to resume; the prior turns remain as read-only history on the same row.
    const sessionId = directIdeaUuid ?? ctx.entityUuid;
    const sessionDirectIdeaUuid: string | null = directIdeaUuid;
    if (directed && directIdeaUuid) {
      const existing = await prisma.daemonSession.findFirst({
        where: {
          companyUuid: ctx.companyUuid,
          agentUuid: ctx.recipientUuid,
          sessionId: directIdeaUuid,
        },
        select: { uuid: true, originConnectionUuid: true },
      });
      if (existing && existing.originConnectionUuid !== origin.uuid) {
        // Cross-cwd directed wake: re-point the idea's canonical session to the resolved
        // online connection (instead of forking a per-instance thread), keeping the same
        // sessionId (=== directIdeaUuid) and non-null directIdeaUuid. companyUuid-scoped;
        // ownership is proven by the same-agent connection resolution above.
        await prisma.daemonSession.update({
          where: { uuid: existing.uuid, companyUuid: ctx.companyUuid },
          data: {
            originConnectionUuid: origin.uuid,
            ...(runtimeCwd ? { runtimeCwd } : {}),
          },
        });
      }
    }

    // (6) Resolve-or-create the session (origin + directIdeaUuid write-once on create),
    // then append the pending turn. For human_instruction the canonical free-text body
    // lives on the turn's promptText; every autonomous trigger has promptText = null (the
    // daemon rebuilds the autonomous prompt from notification context).
    const session = await resolveOrCreateSession({
      companyUuid: ctx.companyUuid,
      agentUuid: ctx.recipientUuid,
      sessionId,
      directIdeaUuid: sessionDirectIdeaUuid,
      originConnectionUuid: origin.uuid,
      ...(runtimeCwd ? { runtimeCwd } : {}),
    });
    const effectiveRuntimeCwd = runtimeCwd ?? session.runtimeCwd ?? null;

    const promptText =
      trigger === "human_instruction" ? ctx.instructionText ?? null : null;

    // Idempotency (fix #444 — duplicate empty turns 2/3/4): a `human_instruction` whose
    // identical text already has an UNCONSUMED (`pending`) turn on this session is a user
    // re-send (they saw no reply and hit send again). Reuse that turn instead of minting a
    // duplicate — the re-issued deliver_turn ping below still nudges the daemon. Scoped to
    // pending + human_instruction + exact text, so a distinct instruction, or a re-send
    // after the prior turn has already started (`running`), still creates a new turn.
    // Autonomous triggers (promptText === null) skip this entirely.
    let turn =
      trigger === "human_instruction" && promptText
        ? await findReusablePendingInstructionTurn(session.uuid, promptText)
        : null;
    if (!turn) {
      turn = await createPendingTurn({
        sessionUuid: session.uuid,
        trigger,
        promptText,
      });
    }

    // (7) DIRECTED wake: deliver to ONLY the resolved target via the human_instruction
    // keystone — a `deliver_turn` control ping on control:{connectionUuid} carrying the
    // precise turnUuid. Fire-and-forget + non-fatal (the persisted turn + reconnect
    // backfill are the durability net). Surface the target so non-target daemons suppress
    // their broadcast copy. An un-pinned wake emits NO ping and surfaces NO target →
    // broadcast → online-first, byte-identical to before.
    if (directed) {
      deliverTurnPing({
        companyUuid: ctx.companyUuid,
        originConnectionUuid: origin.uuid,
        turnUuid: turn.uuid,
        ...(effectiveRuntimeCwd ? { runtimeCwd: effectiveRuntimeCwd } : {}),
      });
      return {
        turn,
        targetConnectionUuid: origin.uuid,
        runtimeCwd: effectiveRuntimeCwd,
        suppressWake: false,
      };
    }

    return { turn, targetConnectionUuid: null, runtimeCwd: null, suppressWake: false };
  } catch (error) {
    // VISIBLE failure (repo "no silent errors"): log with full context but DO NOT
    // rethrow — the notification was already created and must not be aborted by a
    // turn-creation/ping failure.
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
    return empty;
  }
}

/**
 * Thin back-compat wrapper over `createTurnAndResolveTarget` returning ONLY the created
 * `TurnView` (or null). The notification chokepoint uses the richer variant to also surface
 * the directed `targetConnectionUuid`; existing callers/tests that only need the turn use
 * this. Behavior is otherwise identical (the directed `deliver_turn` ping still fires).
 */
export async function maybeCreateTurnForWakeNotification(
  ctx: WakeNotificationContext,
): Promise<TurnView | null> {
  const { turn } = await createTurnAndResolveTarget(ctx);
  return turn;
}
