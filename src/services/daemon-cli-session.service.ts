// src/services/daemon-cli-session.service.ts
// CLI session sync — server half (cli-agent-session-sync D1/D2/D4/D5).
//
// `chorus agents run` registers its foreground conversation as an ordinary DaemonSession so
// it can be read live and later continued from Chorus by the local daemon:
//   - registration creates the session (ad-hoc by default, or Idea-anchored via `ideaUuid`),
//     ONE running `cli_session` turn that receives the CLI transcript through the existing
//     `POST /api/daemon/transcript` (by exact `turnUuid`), and a server-side CLI lease;
//   - the CLI renews the lease every CLI_HEARTBEAT_INTERVAL_SEC (TTL CLI_LEASE_TTL_SEC);
//   - release ends the CLI turn, clears the lease and drains queued instructions (D4).
// While leased, every pending-turn delivery path consults `isCliLeased` and keeps human
// instructions queued. The origin binding is lazy (D5): a session whose launch host+cwd is
// not served by an online daemon connection stays unbound and binds when one registers or
// reports the cwd through directory discovery.
//
// Auth posture: agent API key only, self-scoped (`agentUuid === actorUuid`) and
// companyUuid-fenced; an unknown/foreign session is a 404 (non-disclosure), never a 403.
// No MCP tool and no new permission bit.

import { randomUUID } from "crypto";
import { prisma } from "@/lib/prisma";
import logger from "@/lib/logger";
import { canActorAccessProject } from "@/services/project-access.service";
import { STALE_THRESHOLD_MS } from "@/services/daemon-connection.service";
import {
  CLI_HEARTBEAT_INTERVAL_SEC,
  CLI_LEASE_TTL_SEC,
  CLI_SESSION_TRIGGER,
  pathContains,
} from "@/services/daemon-cli-lease";
import {
  drainQueuedTurns,
  endCliTurn,
  publishSessionActivityEvent,
  publishTranscriptEvent,
  type TurnView,
} from "@/services/daemon-session.service";

const cliLogger = logger.child({ module: "daemon-cli-session.service" });

// ===== Typed errors (mapped to status codes by the route layer) =====

/** Unknown / foreign / cross-company session → 404 non-disclosure. */
export class CliSessionNotFoundError extends Error {
  readonly code = "cli_session_not_found";
  constructor() {
    super("Daemon session not found");
    this.name = "CliSessionNotFoundError";
  }
}

/** The presented `leaseHolder` no longer holds the lease (stale run, already released) → 409. */
export class CliLeaseConflictError extends Error {
  readonly code = "cli_lease_conflict";
  constructor() {
    super("The CLI lease is not held by this leaseHolder (released, expired and drained, or superseded).");
    this.name = "CliLeaseConflictError";
  }
}

/** `ideaUuid` does not resolve in-company or the agent cannot edit its project → 400. */
export class CliInvalidIdeaError extends Error {
  readonly code = "cli_invalid_idea";
  constructor() {
    super("ideaUuid does not reference an Idea this agent can access.");
    this.name = "CliInvalidIdeaError";
  }
}

// ===== Types =====

type AgentAuth = { companyUuid: string; actorUuid: string };

export interface RegisterCliSessionInput {
  agentType: string;
  host: string;
  cwd: string;
  ideaUuid?: string | null;
  backendSessionId?: string | null;
  title?: string | null;
  // False when the CLI already knows it cannot establish the resume identity (e.g. the
  // user passed their own resume flag). Default true.
  continuable?: boolean;
}

export interface RegisterCliSessionResult {
  sessionUuid: string;
  // The Chorus business key. The CLI derives the backend resume id from it exactly like the
  // daemon does: `backendSessionKey(sessionId, agentUuid)`.
  sessionId: string;
  turnUuid: string;
  leaseHolder: string;
  leaseTtlSec: number;
  heartbeatIntervalSec: number;
  leaseExpiresAt: string;
  originBound: boolean;
  continuable: boolean;
}

export interface HeartbeatCliSessionResult {
  leaseTtlSec: number;
  heartbeatIntervalSec: number;
  leaseExpiresAt: string;
  originBound: boolean;
}

export interface ReleaseCliSessionResult {
  released: true;
  continuable: boolean;
  originBound: boolean;
  // Queued turns pinged to the origin daemon by the drain (empty when none / offline / unbound).
  deliveredTurnUuids: string[];
}

// ===== Helpers =====

function leaseExpiry(now: Date): Date {
  return new Date(now.getTime() + CLI_LEASE_TTL_SEC * 1000);
}

async function findOwnSession(auth: AgentAuth, sessionUuid: string) {
  return prisma.daemonSession.findFirst({
    where: { uuid: sessionUuid, companyUuid: auth.companyUuid, agentUuid: auth.actorUuid },
    select: { uuid: true, originConnectionUuid: true, continuable: true, cliLeaseHolder: true },
  });
}

/**
 * D5: find the ONLINE daemon connection of `agentUuid` on `host` that serves `cwd`:
 *  1. its own cwd equals the launch cwd → bind with `runtimeCwd = null` (legacy cwd-bound);
 *  2. otherwise the cwd is one of the host's discovered / directed working directories —
 *     a successful directory-discovery `validate` of that path or a `roots` result containing
 *     it on that connection, an existing session of this agent directed to that cwd on that
 *     connection, or a project-fixed cwd preference for (agent, host, cwd) — → bind to that
 *     connection (or the host's first online connection for a host-level preference) with
 *     `runtimeCwd = launch cwd`.
 * Only effectively-online connections qualify (status online AND fresh lastSeenAt), with a
 * stable uuid order so concurrent calls agree. Returns null when nothing serves the cwd.
 */
export async function findServingConnection(
  companyUuid: string,
  agentUuid: string,
  host: string,
  cwd: string,
  now: Date = new Date(),
): Promise<{ connectionUuid: string; runtimeCwd: string | null } | null> {
  const connections = await prisma.daemonConnection.findMany({
    where: { companyUuid, agentUuid, host, status: "online" },
    select: { uuid: true, cwd: true, lastSeenAt: true },
    orderBy: { uuid: "asc" },
  });
  const online = connections.filter((c) => now.getTime() - c.lastSeenAt.getTime() <= STALE_THRESHOLD_MS);
  if (online.length === 0) return null;

  const exact = online.find((c) => c.cwd === cwd);
  if (exact) return { connectionUuid: exact.uuid, runtimeCwd: null };

  const onlineUuids = online.map((c) => c.uuid);
  const discovered = await prisma.daemonDirectoryRequest.findMany({
    where: {
      companyUuid, agentUuid, targetConnectionUuid: { in: onlineUuids },
      status: "success", operation: { in: ["validate", "roots"] },
    },
    select: { targetConnectionUuid: true, operation: true, result: true },
    orderBy: { completedAt: "desc" },
  });
  for (const request of discovered) {
    const result = request.result && typeof request.result === "object" && !Array.isArray(request.result)
      ? (request.result as Record<string, unknown>) : null;
    if (!result) continue;
    const served = request.operation === "validate"
      ? result.normalizedPath === cwd
      : Array.isArray(result.roots) && result.roots.some((root) => typeof root === "string" && pathContains(root, cwd));
    if (served) return { connectionUuid: request.targetConnectionUuid, runtimeCwd: cwd };
  }

  const directed = await prisma.daemonSession.findFirst({
    where: { companyUuid, agentUuid, runtimeCwd: cwd, originConnectionUuid: { in: onlineUuids } },
    select: { originConnectionUuid: true },
    orderBy: { lastTurnAt: "desc" },
  });
  if (directed?.originConnectionUuid) {
    return { connectionUuid: directed.originConnectionUuid, runtimeCwd: cwd };
  }

  const preference = await prisma.projectAgentCwdPreference.findFirst({
    where: { companyUuid, agentUuid, host, cwd },
    select: { uuid: true },
  });
  if (preference) return { connectionUuid: online[0].uuid, runtimeCwd: cwd };

  return null;
}

// ===== Register =====

/**
 * POST /api/daemon-sessions/cli — register a foreground CLI conversation (D2).
 * Creates the session (server-generated `sessionId`; `directIdeaUuid = ideaUuid ?? null`),
 * its running `cli_session` turn and the lease, binding the origin when an online
 * connection serves the launch cwd (D5). An Idea-anchored CLI session keeps its OWN
 * sessionId (never the Idea uuid) so the Idea's autonomous wakes never land on it; it is
 * grouped under the Idea through `directIdeaUuid`.
 */
export async function registerCliSession(
  auth: AgentAuth,
  input: RegisterCliSessionInput,
): Promise<RegisterCliSessionResult> {
  const agentUuid = auth.actorUuid;
  const ideaUuid = input.ideaUuid ?? null;
  if (ideaUuid) {
    const idea = await prisma.idea.findFirst({
      where: { uuid: ideaUuid, companyUuid: auth.companyUuid },
      select: { projectUuid: true },
    });
    const canEdit = idea != null && await canActorAccessProject(
      auth.companyUuid, { type: "agent", uuid: agentUuid }, idea.projectUuid, "editor",
    );
    if (!canEdit) throw new CliInvalidIdeaError();
  }

  const now = new Date();
  const binding = await findServingConnection(auth.companyUuid, agentUuid, input.host, input.cwd, now);
  const sessionId = randomUUID();
  const leaseHolder = randomUUID();
  const expiresAt = leaseExpiry(now);
  const continuable = input.continuable ?? true;
  const backendSessionId = input.backendSessionId ?? null;

  const { session, turn } = await prisma.$transaction(async (tx) => {
    const session = await tx.daemonSession.create({
      data: {
        companyUuid: auth.companyUuid,
        agentUuid,
        sessionId,
        directIdeaUuid: ideaUuid,
        originConnectionUuid: binding?.connectionUuid ?? null,
        runtimeCwd: binding?.runtimeCwd ?? null,
        backendSessionId,
        cliLeaseHolder: leaseHolder,
        cliLeaseExpiresAt: expiresAt,
        cliHost: input.host,
        cliCwd: input.cwd,
        continuable,
        status: "active",
        ...(input.title ? { title: input.title } : {}),
      },
      include: { agent: { select: { ownerUuid: true } } },
    });
    // D8: created RUNNING (so the UI shows activity) with no wake target / admission —
    // never delivered to a daemon, invisible to daemon turn machinery.
    const turn = await tx.daemonSessionTurn.create({
      data: {
        sessionUuid: session.uuid,
        seq: 1,
        trigger: CLI_SESSION_TRIGGER,
        status: "running",
        startedAt: now,
        backendSessionId,
      },
    });
    return { session, turn };
  });

  const turnView: TurnView = {
    uuid: turn.uuid, sessionUuid: turn.sessionUuid, backendSessionId: turn.backendSessionId, seq: turn.seq,
    trigger: turn.trigger, promptText: null, operationPayload: null, status: turn.status,
    interruptedReason: null, relayError: null, wakeError: null, usage: null, executionUuid: null,
    startedAt: now.toISOString(), endedAt: null, createdAt: turn.createdAt.toISOString(),
  };
  publishTranscriptEvent({
    companyUuid: auth.companyUuid, sessionUuid: session.uuid, trigger: "turn_created", turn: turnView, messages: [],
  });
  publishSessionActivityEvent({
    type: "session_started", companyUuid: auth.companyUuid, sessionUuid: session.uuid, activityUuid: turn.uuid,
    directIdeaUuid: session.directIdeaUuid, agentUuid, originConnectionUuid: session.originConnectionUuid,
    agentOwnerUuid: session.agent?.ownerUuid ?? null,
  });

  return {
    sessionUuid: session.uuid,
    sessionId,
    turnUuid: turn.uuid,
    leaseHolder,
    leaseTtlSec: CLI_LEASE_TTL_SEC,
    heartbeatIntervalSec: CLI_HEARTBEAT_INTERVAL_SEC,
    leaseExpiresAt: expiresAt.toISOString(),
    originBound: session.originConnectionUuid != null,
    continuable,
  };
}

// ===== Heartbeat =====

/**
 * POST /api/daemon-sessions/cli/:sessionUuid/heartbeat — renew the lease for another TTL.
 * Fenced on the holder only: an expired-but-not-yet-swept lease is still renewable (the CLI
 * was merely late); once a sweep/lazy check drained it the holder is cleared and this is a
 * 409. A late `backendSessionId` report binds the session + CLI turn identity if unset.
 */
export async function heartbeatCliSession(
  auth: AgentAuth,
  sessionUuid: string,
  input: { leaseHolder: string; backendSessionId?: string | null },
): Promise<HeartbeatCliSessionResult> {
  const now = new Date();
  const expiresAt = leaseExpiry(now);
  const renewed = await prisma.daemonSession.updateMany({
    where: {
      uuid: sessionUuid, companyUuid: auth.companyUuid, agentUuid: auth.actorUuid,
      cliLeaseHolder: input.leaseHolder,
    },
    data: { cliLeaseExpiresAt: expiresAt },
  });
  if (renewed.count === 0) {
    const session = await findOwnSession(auth, sessionUuid);
    if (!session) throw new CliSessionNotFoundError();
    throw new CliLeaseConflictError();
  }
  if (input.backendSessionId) await recordBackendSessionId(sessionUuid, input.backendSessionId);
  const session = await findOwnSession(auth, sessionUuid);
  return {
    leaseTtlSec: CLI_LEASE_TTL_SEC,
    heartbeatIntervalSec: CLI_HEARTBEAT_INTERVAL_SEC,
    leaseExpiresAt: expiresAt.toISOString(),
    originBound: session?.originConnectionUuid != null,
  };
}

/** Write-once (null → value) backend identity on the session and its CLI turn. */
async function recordBackendSessionId(sessionUuid: string, backendSessionId: string): Promise<void> {
  await prisma.daemonSession.updateMany({
    where: { uuid: sessionUuid, backendSessionId: null },
    data: { backendSessionId },
  });
  await prisma.daemonSessionTurn.updateMany({
    where: { sessionUuid, trigger: CLI_SESSION_TRIGGER, backendSessionId: null },
    data: { backendSessionId },
  });
}

// ===== Release =====

/**
 * POST /api/daemon-sessions/cli/:sessionUuid/release — the CLI exited. Clears the lease
 * (conditional on the holder, so a stale run cannot release a newer one → 409), stores
 * `continuable:false` when reported, ends the CLI turn and immediately drains queued turns
 * to the origin daemon (D4 trigger 1). No pending turns → nothing is woken.
 */
export async function releaseCliSession(
  auth: AgentAuth,
  sessionUuid: string,
  input: { leaseHolder: string; continuable: boolean; reason?: string | null },
): Promise<ReleaseCliSessionResult> {
  const now = new Date();
  const released = await prisma.daemonSession.updateMany({
    where: {
      uuid: sessionUuid, companyUuid: auth.companyUuid, agentUuid: auth.actorUuid,
      cliLeaseHolder: input.leaseHolder,
    },
    data: {
      cliLeaseHolder: null,
      cliLeaseExpiresAt: null,
      ...(input.continuable === false ? { continuable: false } : {}),
    },
  });
  if (released.count === 0) {
    const session = await findOwnSession(auth, sessionUuid);
    if (!session) throw new CliSessionNotFoundError();
    throw new CliLeaseConflictError();
  }
  if (input.reason) {
    cliLogger.info({ sessionUuid, reason: input.reason }, "CLI session released");
  }
  await endCliTurn(sessionUuid, now);
  const deliveredTurnUuids = await drainQueuedTurns(auth.companyUuid, sessionUuid, now);
  const session = await findOwnSession(auth, sessionUuid);
  return {
    released: true,
    continuable: session?.continuable ?? input.continuable,
    originBound: session?.originConnectionUuid != null,
    deliveredTurnUuids,
  };
}

// ===== Lazy origin binding (D5) =====

/**
 * Bind every UNBOUND CLI session of the connection's agent + host whose launch cwd this
 * connection (or another online connection on the host) now serves. Called on connection
 * registration and on a directory-discovery report; each bind is conditional on the origin
 * still being null (concurrent binders agree), then queued turns are drained (a no-op while
 * the lease is live). Best-effort: logs and returns 0 on failure — never breaks the caller.
 */
export async function bindUnboundCliSessionsForConnection(
  companyUuid: string,
  connectionUuid: string,
): Promise<number> {
  try {
    const connection = await prisma.daemonConnection.findFirst({
      where: { uuid: connectionUuid, companyUuid },
      select: { agentUuid: true, host: true },
    });
    if (!connection) return 0;
    const unbound = await prisma.daemonSession.findMany({
      where: {
        companyUuid, agentUuid: connection.agentUuid, originConnectionUuid: null,
        cliHost: connection.host, cliCwd: { not: null },
      },
      select: { uuid: true, cliCwd: true },
      orderBy: { lastTurnAt: "desc" },
      take: 50,
    });
    let bound = 0;
    for (const session of unbound) {
      const target = await findServingConnection(companyUuid, connection.agentUuid, connection.host, session.cliCwd as string);
      if (!target) continue;
      const updated = await prisma.daemonSession.updateMany({
        where: { uuid: session.uuid, companyUuid, originConnectionUuid: null },
        data: { originConnectionUuid: target.connectionUuid, runtimeCwd: target.runtimeCwd },
      });
      if (updated.count === 0) continue;
      bound += 1;
      await drainQueuedTurns(companyUuid, session.uuid);
    }
    return bound;
  } catch (err) {
    cliLogger.error({ err, companyUuid, connectionUuid }, "Lazy CLI session origin binding failed");
    return 0;
  }
}
