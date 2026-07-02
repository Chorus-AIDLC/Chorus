// src/services/stage-advance.service.ts
// Generic "human one-click stage-advance" framework.
//
// A stage-advance event is a human-initiated action on an Idea that (optionally
// after a state transition) emits an activity whose sole purpose is to wake the
// Idea's assigned daemon agent to drive the next AI-DLC stage. The pattern was
// proved out by the Verify Elaborate button (`elaboration_verified`); this
// module extracts the shared upstream half so every stage button runs one code
// path: actor gate → company-scoped idea lookup → per-stage precondition →
// offline policy → optional transition → activity emit.
//
// Everything DOWNSTREAM of the activity emit (notification-listener recipient
// resolution, the notification-turn chokepoint with session-origin pinning,
// daemon prompt rendering) is the existing wake pipeline, deliberately NOT
// abstracted here. Registration surfaces stay explicit per stage:
// notification-listener.ts, notification-turn.ts, daemon-session.service.ts
// TURN_TRIGGERS, cli/event-router.mjs and cli/prompts.mjs each declare the new
// literal — the spec's parity scenarios are the drift guard, not a magic
// cross-layer registry.

import { prisma } from "@/lib/prisma";
import { eventBus } from "@/lib/event-bus";
import { activityService } from "@/services";
import { resolveAssigneeAgentUuid } from "@/lib/uuid-resolver";
import { STALE_THRESHOLD_MS } from "@/services/daemon-connection.service";

// Machine-readable failure codes so callers (server actions) can map each
// failure to a distinct i18n message instead of parsing error prose.
export type StageAdvanceErrorCode =
  | "NOT_HUMAN"
  | "IDEA_NOT_FOUND"
  | "PRECONDITION_FAILED"
  | "AGENT_OFFLINE"
  | "ASSIGNEE_NOT_AGENT";

export class StageAdvanceError extends Error {
  readonly code: StageAdvanceErrorCode;
  // Optional per-stage sub-code (e.g. "no_approved_proposal") for preconditions
  // that can fail in more than one distinguishable way.
  readonly reason?: string;

  constructor(code: StageAdvanceErrorCode, message: string, reason?: string) {
    super(message);
    this.name = "StageAdvanceError";
    this.code = code;
    this.reason = reason;
  }
}

// The Idea row every stage sees. Kept to the fields the shared pipeline and
// the existing stage preconditions need; widen deliberately if a future stage
// needs more.
export interface StageAdvanceIdea {
  uuid: string;
  companyUuid: string;
  projectUuid: string;
  status: string;
  elaborationStatus: string | null;
  assigneeType: string | null;
  assigneeUuid: string | null;
}

export interface StageAdvanceContext {
  companyUuid: string;
  ideaUuid: string;
  actorUuid: string;
  actorType: string;
  idea: StageAdvanceIdea;
}

export interface StageAdvanceDefinition {
  // Activity action string, e.g. "elaboration_verified", "start_development".
  action: string;
  // Per-stage precondition. Throw StageAdvanceError("PRECONDITION_FAILED", …,
  // reason) to reject; return an activity `value` payload to accept.
  precondition: (ctx: StageAdvanceContext) => Promise<Record<string, unknown>>;
  // Optional per-stage state mutation, run only after every gate passed.
  transition?: (ctx: StageAdvanceContext) => Promise<void>;
  // "queue": the event succeeds regardless of daemon liveness — the wake is
  //   recovered by the reconnect notification-backfill (elaboration_verified).
  // "require_online": the event is wake-only and refuses to fire into the
  //   void — the Idea's assignee agent must have an effectively-online daemon
  //   connection at call time (start_development).
  offlinePolicy: "queue" | "require_online";
}

/**
 * Effectively-online check for the `require_online` policy. Reuses the single
 * liveness rule (`status === "online"` AND `lastSeenAt` within
 * STALE_THRESHOLD_MS — the exported constant, never a restated number). Any
 * online connection of the owning agent qualifies: the wake chokepoint's
 * session-origin upgrade picks the right cwd, not this gate.
 */
async function hasEffectivelyOnlineConnection(agentUuid: string): Promise<boolean> {
  const staleFloor = new Date(Date.now() - STALE_THRESHOLD_MS);
  const online = await prisma.daemonConnection.findFirst({
    where: {
      agentUuid,
      status: "online",
      lastSeenAt: { gte: staleFloor },
    },
    select: { uuid: true },
  });
  return online !== null;
}

/**
 * Execute a stage-advance event. Ordered pipeline; a failure at any step emits
 * nothing (no transition, no activity):
 *
 *  1. actor gate — humans only (user | super_admin)
 *  2. company-scoped idea lookup
 *  3. per-stage precondition
 *  4. offline policy (require_online: assignee → owning agent → online check)
 *  5. optional per-stage transition
 *  6. activity emit (targetType "idea", definition.action) + change event
 */
export async function executeStageAdvance(
  definition: StageAdvanceDefinition,
  {
    companyUuid,
    ideaUuid,
    actorUuid,
    actorType,
  }: {
    companyUuid: string;
    ideaUuid: string;
    actorUuid: string;
    actorType: string;
  }
): Promise<void> {
  // 1. Stage-advance is a human affordance. Agents keep their own paths (e.g.
  // chorus_pm_validate_elaboration) — they never call this.
  if (actorType !== "user" && actorType !== "super_admin") {
    throw new StageAdvanceError(
      "NOT_HUMAN",
      "Only users can perform a stage-advance action"
    );
  }

  // 2. Company-scoped lookup — a cross-company Idea reads as not-found, never
  // disclosed.
  const idea = await prisma.idea.findFirst({
    where: { uuid: ideaUuid, companyUuid },
  });
  if (!idea) throw new StageAdvanceError("IDEA_NOT_FOUND", "Idea not found");

  const ctx: StageAdvanceContext = {
    companyUuid,
    ideaUuid,
    actorUuid,
    actorType,
    idea: {
      uuid: idea.uuid,
      companyUuid: idea.companyUuid,
      projectUuid: idea.projectUuid,
      status: idea.status,
      elaborationStatus: idea.elaborationStatus,
      assigneeType: idea.assigneeType,
      assigneeUuid: idea.assigneeUuid,
    },
  };

  // 3. Per-stage precondition. Its return value becomes the activity payload.
  const activityValue = await definition.precondition(ctx);

  // 4. Offline policy. "queue" never blocks on liveness; "require_online"
  // resolves the assignee to its owning agent and demands a live connection.
  if (definition.offlinePolicy === "require_online") {
    const agentUuid = await resolveAssigneeAgentUuid(
      companyUuid,
      ctx.idea.assigneeType,
      ctx.idea.assigneeUuid
    );
    if (!agentUuid) {
      throw new StageAdvanceError(
        "ASSIGNEE_NOT_AGENT",
        "The Idea's assignee is not an agent — there is no daemon to wake"
      );
    }
    if (!(await hasEffectivelyOnlineConnection(agentUuid))) {
      throw new StageAdvanceError(
        "AGENT_OFFLINE",
        "The assigned agent has no online daemon connection"
      );
    }
  }

  // 5. Optional per-stage state transition.
  if (definition.transition) {
    await definition.transition(ctx);
  }

  // 6. Activity emit — this IS the wake signal; everything downstream is the
  // existing notification → turn → daemon pipeline.
  await activityService.createActivity({
    companyUuid,
    projectUuid: ctx.idea.projectUuid,
    targetType: "idea",
    targetUuid: ideaUuid,
    actorType,
    actorUuid,
    action: definition.action,
    value: activityValue,
  });

  eventBus.emitChange({
    companyUuid,
    projectUuid: ctx.idea.projectUuid,
    entityType: "idea",
    entityUuid: ideaUuid,
    action: "updated",
  });
}
