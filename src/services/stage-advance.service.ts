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
//
// AGENT_OFFLINE vs INSTANCE_OFFLINE — the HARD-pin split (pin-cwd-before-wake,
// owner choice B): a BARE-agent assignee's wake goes online-first, so require_online
// only needs SOME online connection of the agent → AGENT_OFFLINE when none. An
// `agent_instance`-pinned assignee's wake is a HARD pin: it targets that exact
// `(host, cwd)` and is notify-only (never re-routed) when offline — so require_online
// must check the PINNED INSTANCE's own connection and fail with the distinguishable
// INSTANCE_OFFLINE when only that instance (not the agent) is offline. This keeps a
// stage-advance from "succeeding" while the wake it triggers silently no-ops.
export type StageAdvanceErrorCode =
  | "NOT_HUMAN"
  | "IDEA_NOT_FOUND"
  | "PRECONDITION_FAILED"
  | "AGENT_OFFLINE"
  | "INSTANCE_OFFLINE"
  | "FIXED_CWD_HOST_OFFLINE"
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
 * Effectively-online check for the `require_online` policy on a BARE `agent` assignee.
 * Reuses the single liveness rule (`status === "online"` AND `lastSeenAt` within
 * STALE_THRESHOLD_MS — the exported constant, never a restated number). ANY online
 * connection of the owning agent qualifies: a bare-agent wake goes online-first, so the
 * wake chokepoint's session-origin upgrade picks the right cwd, not this gate.
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

async function hasEffectivelyOnlineFixedCwdHost(
  companyUuid: string,
  userUuid: string,
  projectUuid: string,
  agentUuid: string,
): Promise<boolean | null> {
  const preference = await prisma.projectAgentCwdPreference.findFirst({
    where: { companyUuid, userUuid, projectUuid, agentUuid },
    select: { host: true },
  });
  if (!preference) return null;

  const staleFloor = new Date(Date.now() - STALE_THRESHOLD_MS);
  const online = await prisma.daemonConnection.findFirst({
    where: {
      agentUuid,
      host: preference.host,
      status: "online",
      lastSeenAt: { gte: staleFloor },
    },
    select: { uuid: true },
  });
  return online !== null;
}

/**
 * Effectively-online check for the `require_online` policy on an `agent_instance`-pinned
 * assignee — the HARD-pin case (pin-cwd-before-wake, owner choice B). The wake targets the
 * pinned instance's EXACT `(host, cwd)` and is notify-only (never re-routed) when that
 * place has no online connection, so require_online must verify THAT instance's own
 * connection — not merely that the agent has some online connection elsewhere. Resolves the
 * `AgentInstance.uuid` to its `(host, cwd)` place (company-scoped), then applies the same
 * liveness rule to a connection at that exact place. A stale/missing instance row → false
 * (treated as offline: the wake would find no place to land). The connection match uses the
 * registry's sentinels (host defaults to "", cwd nullable) exactly as the wake path does.
 */
async function hasEffectivelyOnlineInstance(
  companyUuid: string,
  instanceUuid: string,
): Promise<boolean> {
  const instance = await prisma.agentInstance.findFirst({
    where: { uuid: instanceUuid, companyUuid },
    select: { agentUuid: true, host: true, cwd: true },
  });
  if (!instance) return false;
  const staleFloor = new Date(Date.now() - STALE_THRESHOLD_MS);
  const online = await prisma.daemonConnection.findFirst({
    where: {
      agentUuid: instance.agentUuid,
      host: instance.host,
      cwd: instance.cwd,
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
    temporaryCwd,
  }: {
    companyUuid: string;
    ideaUuid: string;
    actorUuid: string;
    actorType: string;
    temporaryCwd?: { host: string; cwd: string } | null;
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
  const activityValue = {
    ...(await definition.precondition(ctx)),
    ...(temporaryCwd
      ? {
          temporaryHost: temporaryCwd.host,
          temporaryRuntimeCwd: temporaryCwd.cwd,
        }
      : {}),
  };

  // 4. Offline policy. "queue" never blocks on liveness; "require_online"
  // resolves the assignee and demands a live connection. The check SPLITS on the
  // assignee kind because pins are HARD (pin-cwd-before-wake, owner choice B):
  //   - `agent_instance` (a HARD pin): the wake targets that exact instance and is
  //     notify-only when offline, so we must verify THAT instance's own connection and
  //     fail with the distinguishable INSTANCE_OFFLINE — never wake a different cwd.
  //   - bare `agent`: the wake goes online-first, so ANY online connection of the agent
  //     suffices → AGENT_OFFLINE when none.
  if (definition.offlinePolicy === "require_online") {
    if (ctx.idea.assigneeType === "agent_instance" && ctx.idea.assigneeUuid) {
      if (
        !(await hasEffectivelyOnlineInstance(companyUuid, ctx.idea.assigneeUuid))
      ) {
        throw new StageAdvanceError(
          "INSTANCE_OFFLINE",
          "The Idea is pinned to a daemon instance that has no online connection"
        );
      }
    } else {
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
      const fixedHostOnline = await hasEffectivelyOnlineFixedCwdHost(
        companyUuid,
        actorUuid,
        ctx.idea.projectUuid,
        agentUuid,
      );
      if (fixedHostOnline === false) {
        throw new StageAdvanceError(
          "FIXED_CWD_HOST_OFFLINE",
          "The project's fixed cwd host has no online daemon connection"
        );
      }
      if (fixedHostOnline === null && !(await hasEffectivelyOnlineConnection(agentUuid))) {
        throw new StageAdvanceError(
          "AGENT_OFFLINE",
          "The assigned agent has no online daemon connection"
        );
      }
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
