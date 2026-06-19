// src/services/daemon-control.service.ts
// Daemon Control Service — the server half of the reverse (server→daemon) control
// channel (子3 — daemon-interrupt-resume).
//
// This module owns TWO things and nothing else:
//   1. `resolveConnectionOwner` — the company-scoped, non-disclosing resolution of
//      a target connection to its owning agent + that agent's human owner, used by
//      the control endpoint to authorize the caller (owner OR task:admin). It
//      mirrors the connection-resolution / non-disclosure regime of
//      `daemon-execution.service` exactly: a connection absent within the caller's
//      company resolves to `null` so the route returns 404, never revealing
//      another company's / another owner's connection.
//   2. `dispatchControl` — the SINGLE function that encapsulates the eventBus
//      publish (q8=a). The route calls only this; the notification-stream transport
//      lives behind it, so a future dedicated bidirectional channel can swap the
//      body of this one function without touching the endpoint or its callers.
//
// A control command is deliberately NOT a wake: it is published on the additive
// per-connection `control:{connectionUuid}` channel as a `type:"control"` event the
// daemon forks to a control handler. It is never persisted as a Notification and
// never a member of the daemon's WAKE_ACTIONS — so this service NEVER touches the
// Notification table or the wake path.

import { prisma } from "@/lib/prisma";
import { eventBus, controlEventName, type ControlEvent } from "@/lib/event-bus";

// ===== Constants =====

// The control verbs accepted by the reverse channel:
//   - `interrupt` — stop a running wake's subprocess (two-stage SIGINT→kill).
//   - `resume`    — re-dispatch a user-interrupted wake; the daemon continues the
//                   same session via `claude --resume <directIdeaUuid>` (the
//                   transcript already exists on disk). Resume is entity-generic and
//                   connection-targeted, so it rides the SAME per-connection control
//                   channel as interrupt rather than a task-level notification —
//                   symmetric with interrupt, and works for idea/proposal/document
//                   wakes too, not just tasks.
//   - `deliver_turn` — (子2 — origin-only live delivery) ping the session's ORIGIN
//                   connection that a specific new `pending` `human_instruction` turn
//                   awaits, so the live wake reaches ONLY that one daemon (never the
//                   agent-wide notification fan-out) and runs ONLY that one turn. It
//                   carries `targetConnectionUuid` + `turnUuid` on the wire — NO
//                   `entityType`/`entityUuid` and NO instruction text: the daemon reads
//                   the turn (and its text) by uuid from the persisted turn. Targeting
//                   the precise turn (not a connection-wide sweep) is what stops a fresh
//                   send from dragging every other still-`pending` turn along with it.
//                   An ad-hoc session's `sessionId` is a non-lineage key that does not
//                   fit CONTROL_ENTITY_TYPES, which is the whole reason `deliver_turn`
//                   is entity-less.
// The route's zod enum is derived from this so an unknown command is rejected at the
// boundary.
export const CONTROL_COMMANDS = ["interrupt", "resume", "deliver_turn"] as const;
export type ControlCommand = (typeof CONTROL_COMMANDS)[number];

/**
 * The entity-bearing control verbs (`interrupt`/`resume`): they target a specific
 * running/resumable resource, so they carry `entityType`/`entityUuid`. `deliver_turn`
 * is deliberately NOT in this set — it is connection-only.
 */
export const ENTITY_BEARING_CONTROL_COMMANDS = ["interrupt", "resume"] as const;
export type EntityBearingControlCommand =
  (typeof ENTITY_BEARING_CONTROL_COMMANDS)[number];

// The entity kinds a control command can target — mirrors the execution registry's
// resource space (the wake-triggering resource the daemon is running).
export const CONTROL_ENTITY_TYPES = [
  "task",
  "idea",
  "proposal",
  "document",
] as const;
export type ControlEntityType = (typeof CONTROL_ENTITY_TYPES)[number];

// ===== Types =====

/**
 * The owning identity of a target connection, resolved company-scoped. `agentUuid`
 * is the connection's daemon agent; `ownerUuid` is that agent's human owner (the
 * `Agent.ownerUuid`), which may be null for an unowned/system agent — in which
 * case only a `task:admin` caller can ever be authorized.
 */
export interface ConnectionOwner {
  agentUuid: string;
  ownerUuid: string | null;
}

/**
 * Resolve a target connection to its owning agent + that agent's human owner,
 * scoped to `companyUuid`. Returns `null` when the connection does not exist
 * within the caller's company — so the route returns 404 (NOT 403) and never
 * confirms another company's / another owner's connection exists. This is the
 * SAME non-disclosure rule as `daemon-execution.service.connectionBelongsToAgent` /
 * `connectionVisibleToCaller`, applied to the control endpoint's authz step.
 *
 * A connection in another company resolves to `null` (the companyUuid filter never
 * matches it), so authorization can never cross company boundaries.
 *
 * This is a READ; like the registry's read functions it does NOT swallow — a query
 * failure propagates so the route surfaces a 500 rather than masquerading as
 * "not found".
 */
export async function resolveConnectionOwner(
  companyUuid: string,
  connectionUuid: string,
): Promise<ConnectionOwner | null> {
  const row = await prisma.daemonConnection.findFirst({
    where: { uuid: connectionUuid, companyUuid },
    select: {
      agentUuid: true,
      agent: { select: { ownerUuid: true } },
    },
  });
  if (!row) return null;
  return { agentUuid: row.agentUuid, ownerUuid: row.agent?.ownerUuid ?? null };
}

/**
 * Authorize a caller to control (interrupt / resume / report-interrupt for) a
 * target daemon connection, applying the shared q2=a rule used by every endpoint
 * on the reverse-control surface:
 *  - resolve the connection's owner company-scoped; absent → `not_found` (the route
 *    returns 404 non-disclosure, never confirming another company's/owner's
 *    connection), then
 *  - allow iff the caller IS that connection agent's human owner, OR the caller
 *    holds `task:admin` (a user caller passes only via ownership; an agent /
 *    super_admin passes via task:admin) → `ok`; else `forbidden` (403).
 *
 * The report-interrupt and resume routes use this helper directly; the control
 * route applies the SAME owner-or-`task:admin` rule inline against
 * `resolveConnectionOwner` (its authz-matrix tests predate this helper). `hasTaskAdmin`
 * is passed in by the caller (it already evaluated `hasPermission` against its typed
 * auth context) so this service stays free of the auth-context types.
 */
export type ControlAuthz =
  | { ok: true; target: ConnectionOwner }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "forbidden" };

export async function authorizeConnectionControl(params: {
  companyUuid: string;
  actorUuid: string;
  hasTaskAdmin: boolean;
  connectionUuid: string;
}): Promise<ControlAuthz> {
  const target = await resolveConnectionOwner(params.companyUuid, params.connectionUuid);
  if (!target) return { ok: false, reason: "not_found" };
  const isOwner = target.ownerUuid != null && params.actorUuid === target.ownerUuid;
  if (!isOwner && !params.hasTaskAdmin) return { ok: false, reason: "forbidden" };
  return { ok: true, target };
}

// ===== Control dispatch (the swap-able transport seam — q8=a) =====

/**
 * Publish a single control command to the targeted daemon connection.
 *
 * This is the ONLY publish path for the reverse control channel: the route, once
 * it has authorized the caller, calls exactly this and nothing else. The transport
 * (the `eventBus.emit` on the additive per-connection `control:{connectionUuid}`
 * channel, which the eventBus override fans out over Redis for multi-instance
 * delivery) is hidden behind this one function. A future dedicated bidirectional
 * channel replaces the body here without changing callers.
 *
 * It emits exactly once per call and returns synchronously after the emit — it does
 * NOT wait for the daemon to act on the command (fire-and-forward); the daemon
 * reports the resulting task state asynchronously via its normal MCP path.
 *
 * `companyUuid` is accepted (and validated to be the caller's company by the route
 * before this runs) so the seam can scope/multiplex per company once a dedicated
 * channel exists; the current notification-stream transport keys purely by
 * connection uuid. It is intentionally NOT spread into the wire payload (the
 * daemon's stream is already company-scoped by its auth).
 *
 * The params are a discriminated union on `command`:
 *  - `interrupt`/`resume` carry `entityType`/`entityUuid` (they target a specific
 *    running/resumable resource), and the wire event carries them too.
 *  - `deliver_turn` carries `targetConnectionUuid` + the precise `turnUuid` to run; the
 *    wire event omits the entity fields entirely (the daemon reads the turn by uuid).
 */
export type DispatchControlParams =
  | {
      companyUuid: string;
      targetConnectionUuid: string;
      command: EntityBearingControlCommand;
      entityType: ControlEntityType;
      entityUuid: string;
    }
  | {
      companyUuid: string;
      targetConnectionUuid: string;
      command: "deliver_turn";
      turnUuid: string;
    };

export function dispatchControl(params: DispatchControlParams): void {
  // `deliver_turn` is connection-only on entity, but carries the PRECISE turnUuid so the
  // daemon runs only that one turn (not a connection-wide sweep that would also drag
  // every other still-pending turn of the connection along).
  const event: ControlEvent =
    params.command === "deliver_turn"
      ? {
          type: "control",
          command: "deliver_turn",
          targetConnectionUuid: params.targetConnectionUuid,
          turnUuid: params.turnUuid,
        }
      : {
          type: "control",
          command: params.command,
          targetConnectionUuid: params.targetConnectionUuid,
          entityType: params.entityType,
          entityUuid: params.entityUuid,
        };
  eventBus.emit(controlEventName(params.targetConnectionUuid), event);
}
