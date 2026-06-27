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
// SOFT vs HARD PINS (the offline policy splits on the pin's ORIGIN — resolves the
// proposal-review BLOCKER; see `PinnedTarget.soft`):
//   - HARD pin = a `mentioned` wake (a human typed an exact `(host, cwd)` in markup). An
//     offline hard pin is NOTIFY-ONLY, NO WAKE — a deliberate REVERSAL of #354's "offline
//     pin → online-first": no turn, no ping, no target; the already-created Notification
//     stands as the plain record. Silently re-routing a human-typed place to a cwd the
//     author did not choose is the user-visible defect this preserves the fix for.
//   - SOFT pin = an ASSIGNMENT wake (the Task's own `agent_instance` override, or the
//     inherited root-Idea instance). An offline soft pin DEGRADES to the agent's
//     online-first connection (R2 graceful un-pin) — the unreachable instance is treated as
//     a plain agent, so the agent still wakes; never notify-only, never a hang.
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
  // connection and pins the session origin there. This is a HARD pin (a human typed an
  // exact place), so an offline mention pin stays notify-only (no wake, no re-route).
  // A `task_assigned` / `idea_claimed` wake does NOT use these — it reads its pin from
  // the assignment lineage (the Task's / root Idea's `agent_instance` assignee, a SOFT
  // pin that degrades to online-first when offline). Both undefined/null → no pin
  // (online-first, exactly as before). `pinnedHost` "" = unknown-host instance;
  // `pinnedCwd` null = unknown-path instance.
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
 *
 * `soft` records the pin's ORIGIN, which governs the offline policy (resolves the
 * proposal-review BLOCKER — see the SOFT vs HARD box in the Tech Design):
 *
 *  - `soft: false` (HARD) — a `mentioned` wake: a human typed an exact `(host, cwd)` in
 *    the mention markup. An offline hard pin stays NOTIFY-ONLY (no wake, no online-first
 *    re-route) so a human-typed place is never silently redirected — the deliberate #354
 *    reversal documented in the file header.
 *  - `soft: true` (SOFT) — an ASSIGNMENT pin: the Task's own `agent_instance` override,
 *    or the inherited root-Idea instance. R2 says a pinned assignment to an unreachable
 *    instance DEGRADES to a plain agent — so an offline soft pin FALLS THROUGH to the
 *    existing online-first selection (the agent wakes anyway), never notify-only.
 */
interface PinnedTarget {
  host: string;
  cwd: string | null;
  soft: boolean;
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
 * (cwd-addressable instances) — or null when the wake carries no pin. DEC-5: the cwd is
 * NEVER inferred from the project; the ONLY pin sources are the explicit owner choices
 * below, resolved in PRIORITY ORDER and tagged with their origin (`soft`):
 *
 *  1. mention pin (HARD, `soft:false`) — `trigger === "mentioned"`: a human typed an
 *     exact place in the mention markup, threaded onto the context
 *     (`ctx.pinnedHost`/`ctx.pinnedCwd`) by mention.service. No DB lookup: the registry
 *     match is on `(host, cwd)` directly.
 *  2. task override (SOFT, `soft:true`) — the wake's TASK row is itself pinned
 *     (`assigneeType === "agent_instance"`): resolve that AgentInstance to its place.
 *     The explicit per-task override beats the inherited idea instance.
 *  2.5 own-idea pin (SOFT, `soft:true`) — when the wake's entity IS an idea, its OWN
 *     assignee pin (subject to the same-agent guard) beats an ancestor's. Symmetric
 *     with the task override: "the idea I'm acting on" wins over a root ancestor that
 *     is pinned to a different instance of the same agent. Only relevant for a
 *     multi-level idea lineage with divergent same-agent pins; for a top-level idea
 *     the own idea IS the root, so this and step 3 resolve identically.
 *  3. root-idea inheritance (SOFT, `soft:true`) — resolve the wake's ROOT idea; if its
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
  // (1) Mention pin — HARD. A human typed an exact place; offline stays notify-only.
  if (trigger === "mentioned") {
    return makePinnedTarget(ctx.pinnedHost, ctx.pinnedCwd, false);
  }

  // Steps 2-3 are assignment lineage and only make sense for a lineage-walkable entity.
  // Every other wake (human_instruction, or a non-lineage entityType such as a comment)
  // carries no assignment pin → online-first.
  if (!LINEAGE_ENTITY_TYPES.has(ctx.entityType)) return null;

  // (2) Task override — SOFT. The wake's own TASK row is pinned to an instance. Only a
  // wake anchored directly on a task entity has a per-task override; this beats the
  // inherited idea instance below.
  if (ctx.entityType === "task") {
    const task = await prisma.task.findFirst({
      where: { uuid: ctx.entityUuid, companyUuid: ctx.companyUuid },
      select: { assigneeType: true, assigneeUuid: true },
    });
    if (task?.assigneeType === "agent_instance" && task.assigneeUuid) {
      const place = await resolveInstancePlace(ctx.companyUuid, task.assigneeUuid);
      if (place) {
        const pin = makePinnedTarget(place.host, place.cwd, true);
        if (pin) return pin;
      }
    }
  }

  // (2.5) Own-idea pin — SOFT. When the wake's entity IS an idea, resolve ITS OWN
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

  // (3) Root-idea inheritance — SOFT, gated on the SAME-AGENT GUARD. Resolve the wake's
  // root idea and read its assignee; inherit ONLY when the idea is instance-pinned AND
  // that instance belongs to the wake's TARGET agent. A cross-agent child does NOT
  // inherit (it resolves against its own agent → online-first).
  const rootIdeaUuid = await resolveRootIdeaUuidForPin(ctx);
  return resolveIdeaInstancePin(ctx, rootIdeaUuid);
}

/**
 * Resolve an idea's own `agent_instance` assignee to a SOFT PinnedTarget, applying the
 * SAME-AGENT GUARD (the idea's instance must belong to the wake's target agent). Returns
 * null when the idea uuid is null, the idea is not instance-pinned, or the guard fails —
 * a legitimate "no pin here" outcome. Shared by the own-idea (step 2.5) and root-idea
 * (step 3) resolution so both apply identical pin + guard semantics.
 */
async function resolveIdeaInstancePin(
  ctx: WakeNotificationContext,
  ideaUuid: string | null,
): Promise<PinnedTarget | null> {
  if (!ideaUuid) return null;
  const idea = await prisma.idea.findFirst({
    where: { uuid: ideaUuid, companyUuid: ctx.companyUuid },
    select: { assigneeType: true, assigneeUuid: true },
  });
  if (idea?.assigneeType === "agent_instance" && idea.assigneeUuid) {
    const place = await resolveInstancePlace(ctx.companyUuid, idea.assigneeUuid);
    // SAME-AGENT GUARD: the idea's instance must belong to the wake's target agent.
    if (place && place.agentUuid === ctx.recipientUuid) {
      return makePinnedTarget(place.host, place.cwd, true);
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
 *    wakes the daemon at that exact place when it is running. (HARD and SOFT pins behave
 *    identically when the pin IS reachable — they diverge only when it is not.)
 *  - With a pin matching NO online connection — the policy SPLITS on the pin's origin
 *    (`soft`), resolving the proposal-review BLOCKER:
 *      • HARD pin (`soft:false`, a mention) → `offline_pin`: NOTHING is woken. NO durable
 *        queue, NO online-first fallback — silently re-routing a human-typed place to an
 *        unchosen cwd is the defect this preserves the fix for (the #354 REVERSAL).
 *      • SOFT pin (`soft:true`, an assignment / inherited idea instance) → DEGRADE to the
 *        online-first selection below (R2 graceful un-pin): the unreachable instance is
 *        treated as a plain agent, so the agent's online-first connection wakes. Never
 *        notify-only, never a hang.
 *  - With no pin: the online-first selection (`effectiveStatus === "online"`, first entry —
 *    the list is already sorted online-first then lastSeenAt desc) → `online_first`,
 *    exactly as before this change. None online → `none`.
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
        c.cwd === pin.cwd &&
        c.effectiveStatus === "online",
    );
    if (matched) return { kind: "directed", connection: matched };
    // Pin matched no ONLINE connection (offline place, or not registered at all). The
    // offline policy SPLITS on the pin's origin:
    //   - HARD (mention) → notify-only, NO wake, NO online-first fallback (the #354
    //     reversal: a human-typed place is never silently re-routed).
    //   - SOFT (assignment / inherited idea instance) → fall through to online-first
    //     below (R2: an unreachable assignment pin degrades to a plain agent).
    if (!pin.soft) {
      return { kind: "offline_pin" };
    }
    // SOFT-pin degrade → fall through to the online-first selection.
  }

  // No pin (or a degraded soft pin) → online-first (the existing behavior). The list is
  // pre-sorted online-first, so the first online entry is the freshest connection. None
  // online → no turn.
  const onlineFirst = connections.find((c) => c.effectiveStatus === "online");
  return onlineFirst
    ? { kind: "online_first", connection: onlineFirst }
    : { kind: "none" };
}

/**
 * Resolve the directed ONLINE target for an `elaboration_verified` wake: the connection
 * that OWNS the idea's existing daemon session (`DaemonSession.originConnectionUuid` for
 * the idea-anchored session), when that connection is ONLINE.
 *
 * This is the LOWER-priority "where does this idea's conversation live" heuristic — the
 * cwd where the idea's transcript already lives. It applies ONLY when the idea is NOT
 * pinned to an instance: an instance-pinned idea is resolved earlier as a SOFT pin (the
 * root-idea step of `resolvePinnedTarget`), which yields a `directed` (or degraded
 * online-first) selection and therefore SKIPS this upgrade. When no idea-anchored session
 * exists yet (the idea was elaborated entirely in the UI and the daemon was never woken on
 * it), or that origin is not currently online, this returns null → the caller falls back
 * to online-first (NO directed delivery), exactly as the pre-change proposal-writing wake.
 *
 * `directIdeaUuid` is the idea anchor (the session business key for an idea-anchored
 * session). `connections` is the agent's live registry, already resolved by the caller.
 * A query failure propagates to the caller's failure-isolation guard.
 */
async function resolveElaborationVerifiedTarget(
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
 *     instances): the mention's `(host, cwd)` for a `mentioned` wake (HARD); else the
 *     Task's own `agent_instance` override, then the root Idea's `agent_instance` assignee
 *     under the same-agent guard (both SOFT); else none (DEC-5: NEVER inferred from the
 *     project). Select the ONLINE origin, classified by HOW it was chosen:
 *       - `directed`     — pin matched an ONLINE connection (turn delivered to ONLY it).
 *       - `online_first` — un-pinned (or a SOFT pin that degraded because its instance is
 *                          offline) → first online (broadcast → online-first).
 *       - `offline_pin`  — a HARD (mention) pin matched NO online connection → notify-only,
 *                          NO turn, NO fallback (REVERSES #354). A SOFT pin NEVER lands here.
 *       - `none`         — agent fully offline → NO turn (the notification stands).
 *  4. `elaboration_verified` / `idea_claimed`: the idea's `agent_instance` assignee (step 3)
 *     is the HIGHER-priority soft pin and is resolved above. ONLY when the idea has no
 *     assignee-instance (selection stayed `online_first`) does the LOWER-priority
 *     session-origin heuristic apply: if the idea has an existing ONLINE session origin,
 *     UPGRADE the selection to `directed` on that origin so the proposal-writing wake lands
 *     where the idea's conversation already lives — else stay `online_first`.
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
    // sorted online-first, then lastSeenAt desc.
    const connections = await listConnectionsForAgent(
      ctx.companyUuid,
      ctx.recipientUuid,
    );
    // The wake's pinned (host, cwd), or null when un-pinned. DEC-5: cwd is only ever the
    // explicit pin — never inferred from the project.
    const pin = await resolvePinnedTarget(ctx, trigger);
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

    // (4) elaboration_verified: the idea's `agent_instance` assignee is the HIGHER-priority
    // soft pin already resolved in step 3 (resolvePinnedTarget reads the root idea's
    // assignee). When the idea IS instance-pinned and that instance is online, selection is
    // already `directed` — this upgrade is SKIPPED (the instance wins). ONLY when the idea
    // has no assignee-instance (or its soft pin degraded because the instance is offline)
    // does selection stay `online_first`, and THEN the LOWER-priority session-origin
    // heuristic upgrades to the idea's existing ONLINE session origin (where the idea's
    // conversation already lives). No session, or an offline origin → stays online-first.
    if (trigger === "elaboration_verified" && selection.kind === "online_first") {
      const ideaTarget = await resolveElaborationVerifiedTarget(
        ctx.companyUuid,
        ctx.recipientUuid,
        directIdeaUuid,
        connections,
      );
      if (ideaTarget) {
        selection = { kind: "directed", connection: ideaTarget };
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
      return { turn: null, targetConnectionUuid: null, suppressWake: true };
    }
    if (selection.kind === "none") {
      return empty;
    }

    const origin = selection.connection;
    const directed = selection.kind === "directed";

    // (5) Session business key. For a DIRECTED mention/task whose resolved target differs
    // from the idea's EXISTING session origin (a cross-cwd directed wake), the resolved
    // INSTANCE participates in the key so each (host, cwd) keeps its OWN cwd-bound
    // transcript — never re-pointing the existing session's origin. An idea-anchored
    // session normally keys on directIdeaUuid; here we suffix the resolved connection so
    // the per-instance session is distinct, and stamp directIdeaUuid = null so this
    // per-instance conversation is treated as its own thread (the idea's canonical session
    // keeps its directIdeaUuid intact).
    let sessionId = directIdeaUuid ?? ctx.entityUuid;
    let sessionDirectIdeaUuid: string | null = directIdeaUuid;
    if (directed && directIdeaUuid) {
      const existing = await prisma.daemonSession.findFirst({
        where: {
          companyUuid: ctx.companyUuid,
          agentUuid: ctx.recipientUuid,
          sessionId: directIdeaUuid,
        },
        select: { originConnectionUuid: true },
      });
      if (existing && existing.originConnectionUuid !== origin.uuid) {
        // Cross-cwd directed wake: the idea's canonical session lives on a DIFFERENT
        // connection. Open a per-instance session keyed on (idea, resolved connection) so
        // the resolved cwd gets its own transcript instead of re-pointing the existing one.
        sessionId = `${directIdeaUuid}::${origin.uuid}`;
        sessionDirectIdeaUuid = null;
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
    });

    const promptText =
      trigger === "human_instruction" ? ctx.instructionText ?? null : null;

    const turn = await createPendingTurn({
      sessionUuid: session.uuid,
      trigger,
      promptText,
    });

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
      });
      return { turn, targetConnectionUuid: origin.uuid, suppressWake: false };
    }

    return { turn, targetConnectionUuid: null, suppressWake: false };
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
