import { prisma } from "@/lib/prisma";
import { eventBus, controlEventName } from "@/lib/event-bus";
import {
  listConnectionsForAgent,
  type ConnectionView,
} from "@/services/daemon-connection.service";

export type ProjectAgentCwdSource =
  | "project_fixed"
  | "temporary"
  | "registered_instance"
  | "unconfigured";
export type ProjectAgentCwdAvailability = "ready" | "offline" | "invalid";
export type ProjectAgentCwdPromptPolicy = "suppress" | "none" | "select";

export interface ResolvedProjectAgentCwdTarget {
  actorUserUuid: string;
  source: ProjectAgentCwdSource;
  agentUuid: string;
  host: string | null;
  cwd: string | null;
  availability: ProjectAgentCwdAvailability;
  promptPolicy: ProjectAgentCwdPromptPolicy;
  connectionUuid: string | null;
  agentInstanceUuid: string | null;
}

export interface ProjectAgentCwdOperationTarget {
  host: string;
  cwd: string;
}

export const DIRECTORY_ERROR_CODES = [
  "HOST_OFFLINE",
  "TIMEOUT",
  "INVALID_PATH",
  "OUTSIDE_ROOT",
  "NOT_DIRECTORY",
  "ACCESS_DENIED",
  "STALE_TARGET",
  "LIMIT_EXCEEDED",
  "INTERNAL_ERROR",
] as const;

export type DirectoryErrorCode = (typeof DIRECTORY_ERROR_CODES)[number];
export type DirectoryOperation = "roots" | "list" | "validate";

export class CwdServiceError extends Error {
  constructor(
    public readonly code: DirectoryErrorCode | "NOT_FOUND" | "FORBIDDEN" | "VALIDATION_ERROR",
    message: string,
    public readonly agentUuid?: string,
  ) {
    super(message);
  }
}

const REQUEST_TTL_MS = 15_000;
const VALIDATION_FRESH_MS = 60_000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export interface ProjectAgentCwdDraftInput {
  agentUuid: string;
  validationRequestUuid: string;
}

export interface ProjectAgentCwdMutations {
  upserts: ProjectAgentCwdDraftInput[];
  clears: string[];
}

async function requireOwnedAgent(companyUuid: string, userUuid: string, agentUuid: string) {
  const agent = await prisma.agent.findFirst({
    where: { uuid: agentUuid, companyUuid, ownerUuid: userUuid },
    select: { uuid: true },
  });
  if (!agent) throw new CwdServiceError("NOT_FOUND", "Agent not found");
}

async function requireProject(companyUuid: string, projectUuid: string) {
  const project = await prisma.project.findFirst({
    where: { uuid: projectUuid, companyUuid },
    select: { uuid: true },
  });
  if (!project) throw new CwdServiceError("NOT_FOUND", "Project not found");
}

function onlineConnectionForHost(
  connections: ConnectionView[],
  host: string,
): ConnectionView | null {
  return (
    connections.find(
      (connection) =>
        connection.host === host && connection.effectiveStatus === "online",
    ) ?? null
  );
}

async function materializeAgentInstance(
  companyUuid: string,
  agentUuid: string,
  host: string,
  cwd: string,
): Promise<string> {
  const row = await prisma.agentInstance.upsert({
    where: {
      companyUuid_agentUuid_host_cwd: { companyUuid, agentUuid, host, cwd },
    },
    create: { companyUuid, agentUuid, host, cwd },
    update: { updatedAt: new Date() },
    select: { uuid: true },
  });
  return row.uuid;
}

async function resolveValidatedPreference(params: {
  companyUuid: string;
  userUuid: string;
  agentUuid: string;
  validationRequestUuid: string;
}) {
  try {
    await requireOwnedAgent(params.companyUuid, params.userUuid, params.agentUuid);
  } catch (error) {
    if (error instanceof CwdServiceError) {
      throw new CwdServiceError(error.code, error.message, params.agentUuid);
    }
    throw error;
  }
  const validation = await prisma.daemonDirectoryRequest.findFirst({
    where: {
      uuid: params.validationRequestUuid,
      companyUuid: params.companyUuid,
      callerUserUuid: params.userUuid,
      agentUuid: params.agentUuid,
      operation: "validate",
      status: "success",
      completedAt: { gte: new Date(Date.now() - VALIDATION_FRESH_MS) },
    },
  });
  const cwd =
    validation?.result &&
    typeof validation.result === "object" &&
    !Array.isArray(validation.result) &&
    typeof (validation.result as { normalizedPath?: unknown }).normalizedPath === "string"
      ? (validation.result as { normalizedPath: string }).normalizedPath
      : null;
  if (!validation || !cwd) {
    throw new CwdServiceError(
      "STALE_TARGET",
      "Fresh successful validation required",
      params.agentUuid,
    );
  }
  const connection = await prisma.daemonConnection.findFirst({
    where: {
      uuid: validation.targetConnectionUuid,
      companyUuid: params.companyUuid,
      agentUuid: params.agentUuid,
    },
    select: { host: true },
  });
  if (!connection) {
    throw new CwdServiceError(
      "STALE_TARGET",
      "Validation target is stale",
      params.agentUuid,
    );
  }
  return { agentUuid: params.agentUuid, host: connection.host, cwd };
}

export async function createProjectWithAgentCwds(params: {
  companyUuid: string;
  userUuid: string;
  name: string;
  description: string | null;
  groupUuid: string | null;
  agentCwds: ProjectAgentCwdDraftInput[];
}) {
  const targets = await Promise.all(
    params.agentCwds.map((draft) => resolveValidatedPreference({
      companyUuid: params.companyUuid,
      userUuid: params.userUuid,
      ...draft,
    })),
  );
  return prisma.$transaction(async (tx) => {
    const project = await tx.project.create({
      data: {
        companyUuid: params.companyUuid,
        name: params.name,
        description: params.description,
        groupUuid: params.groupUuid,
      },
      select: {
        uuid: true,
        name: true,
        description: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    for (const target of targets) {
      const instance = await tx.agentInstance.upsert({
        where: {
          companyUuid_agentUuid_host_cwd: {
            companyUuid: params.companyUuid,
            agentUuid: target.agentUuid,
            host: target.host,
            cwd: target.cwd,
          },
        },
        create: {
          companyUuid: params.companyUuid,
          agentUuid: target.agentUuid,
          host: target.host,
          cwd: target.cwd,
        },
        update: { updatedAt: new Date() },
        select: { uuid: true },
      });
      await tx.projectAgentCwdPreference.create({
        data: {
          companyUuid: params.companyUuid,
          userUuid: params.userUuid,
          projectUuid: project.uuid,
          agentUuid: target.agentUuid,
          host: target.host,
          cwd: target.cwd,
          anchorAgentInstanceUuid: instance.uuid,
        },
      });
    }
    return project;
  });
}

export async function updateProjectWithAgentCwds(params: {
  companyUuid: string;
  userUuid: string;
  projectUuid: string;
  name?: string;
  description?: string | null;
  agentCwds: ProjectAgentCwdMutations;
}) {
  await requireProject(params.companyUuid, params.projectUuid);
  const targets = await Promise.all(
    params.agentCwds.upserts.map(async (draft) => {
      try {
        return await resolveValidatedPreference({
          companyUuid: params.companyUuid,
          userUuid: params.userUuid,
          ...draft,
        });
      } catch (error) {
        if (error instanceof CwdServiceError) {
          throw new CwdServiceError(error.code, error.message, draft.agentUuid);
        }
        throw error;
      }
    }),
  );

  return prisma.$transaction(async (tx) => {
    const project = await tx.project.update({
      where: { uuid: params.projectUuid },
      data: {
        ...(params.name !== undefined ? { name: params.name } : {}),
        ...(params.description !== undefined ? { description: params.description } : {}),
      },
      select: {
        uuid: true,
        name: true,
        description: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    for (const target of targets) {
      const instance = await tx.agentInstance.upsert({
        where: {
          companyUuid_agentUuid_host_cwd: {
            companyUuid: params.companyUuid,
            agentUuid: target.agentUuid,
            host: target.host,
            cwd: target.cwd,
          },
        },
        create: {
          companyUuid: params.companyUuid,
          agentUuid: target.agentUuid,
          host: target.host,
          cwd: target.cwd,
        },
        update: { updatedAt: new Date() },
        select: { uuid: true },
      });
      await tx.projectAgentCwdPreference.upsert({
        where: {
          userUuid_projectUuid_agentUuid: {
            userUuid: params.userUuid,
            projectUuid: params.projectUuid,
            agentUuid: target.agentUuid,
          },
        },
        create: {
          companyUuid: params.companyUuid,
          userUuid: params.userUuid,
          projectUuid: params.projectUuid,
          agentUuid: target.agentUuid,
          host: target.host,
          cwd: target.cwd,
          anchorAgentInstanceUuid: instance.uuid,
        },
        update: {
          host: target.host,
          cwd: target.cwd,
          anchorAgentInstanceUuid: instance.uuid,
        },
      });
    }
    if (params.agentCwds.clears.length > 0) {
      await tx.projectAgentCwdPreference.deleteMany({
        where: {
          companyUuid: params.companyUuid,
          userUuid: params.userUuid,
          projectUuid: params.projectUuid,
          agentUuid: { in: params.agentCwds.clears },
        },
      });
    }
    return project;
  });
}

/**
 * Resolve one immutable, actor-bearing target snapshot for a project operation.
 * Callers pass this object through the operation rather than re-reading mutable
 * preferences or connection state.
 */
export async function resolveProjectAgentCwdTarget(params: {
  companyUuid: string;
  actorUserUuid: string;
  projectUuid: string;
  agentUuid: string;
  temporaryTarget?: ProjectAgentCwdOperationTarget | null;
  registeredInstanceUuid?: string | null;
  registeredSource?: ProjectAgentCwdSource | null;
  registeredHost?: string | null;
  registeredRuntimeCwd?: string | null;
}): Promise<ResolvedProjectAgentCwdTarget> {
  const [preference, connections] = await Promise.all([
    prisma.projectAgentCwdPreference.findFirst({
      where: {
        companyUuid: params.companyUuid,
        userUuid: params.actorUserUuid,
        projectUuid: params.projectUuid,
        agentUuid: params.agentUuid,
      },
      select: {
        uuid: true,
        host: true,
        cwd: true,
        anchorAgentInstanceUuid: true,
      },
    }),
    listConnectionsForAgent(params.companyUuid, params.agentUuid),
  ]);

  // A registered instance supplied by the caller is an established assignment/root
  // anchor. Once work is anchored, a later preference replacement or clear must not
  // move that Idea/session to a different cwd.
  if (params.registeredInstanceUuid) {
    const instance = await prisma.agentInstance.findFirst({
      where: {
        uuid: params.registeredInstanceUuid,
        companyUuid: params.companyUuid,
        agentUuid: params.agentUuid,
      },
      select: { uuid: true, host: true, cwd: true },
    });
    if (instance) {
      const host = params.registeredRuntimeCwd
        ? params.registeredHost ?? instance.host
        : instance.host;
      const cwd = params.registeredRuntimeCwd ?? instance.cwd;
      const connection = params.registeredRuntimeCwd
        ? onlineConnectionForHost(connections, host)
        : connections.find(
            (candidate) =>
              candidate.host === host &&
              candidate.cwd === cwd &&
              candidate.effectiveStatus === "online",
          );
      return {
        actorUserUuid: params.actorUserUuid,
        source:
          params.registeredSource === "project_fixed"
            ? "project_fixed"
            : "registered_instance",
        agentUuid: params.agentUuid,
        host,
        cwd,
        availability: connection ? "ready" : "offline",
        promptPolicy:
          params.registeredSource === "project_fixed" ? "suppress" : "none",
        connectionUuid: connection?.uuid ?? null,
        agentInstanceUuid: instance.uuid,
      };
    }
    return {
      actorUserUuid: params.actorUserUuid,
      source:
        params.registeredSource === "project_fixed"
          ? "project_fixed"
          : "registered_instance",
      agentUuid: params.agentUuid,
      host: null,
      cwd: null,
      availability: "invalid",
      promptPolicy:
        params.registeredSource === "project_fixed" ? "suppress" : "none",
      connectionUuid: null,
      agentInstanceUuid: params.registeredInstanceUuid,
    };
  }

  if (preference) {
    if (!preference.host || !preference.cwd) {
      return {
        actorUserUuid: params.actorUserUuid,
        source: "project_fixed",
        agentUuid: params.agentUuid,
        host: preference.host || null,
        cwd: preference.cwd || null,
        availability: "invalid",
        promptPolicy: "suppress",
        connectionUuid: null,
        agentInstanceUuid: preference.anchorAgentInstanceUuid,
      };
    }
    const agentInstanceUuid = await materializeAgentInstance(
      params.companyUuid,
      params.agentUuid,
      preference.host,
      preference.cwd,
    );
    if (preference.anchorAgentInstanceUuid !== agentInstanceUuid) {
      await prisma.projectAgentCwdPreference.update({
        where: { uuid: preference.uuid },
        data: { anchorAgentInstanceUuid: agentInstanceUuid },
      });
    }
    const connection = onlineConnectionForHost(connections, preference.host);
    return {
      actorUserUuid: params.actorUserUuid,
      source: "project_fixed",
      agentUuid: params.agentUuid,
      host: preference.host,
      cwd: preference.cwd,
      availability: connection ? "ready" : "offline",
      promptPolicy: "suppress",
      connectionUuid: connection?.uuid ?? null,
      agentInstanceUuid,
    };
  }

  if (params.temporaryTarget) {
    const connection = onlineConnectionForHost(
      connections,
      params.temporaryTarget.host,
    );
    return {
      actorUserUuid: params.actorUserUuid,
      source: "temporary",
      agentUuid: params.agentUuid,
      host: params.temporaryTarget.host,
      cwd: params.temporaryTarget.cwd,
      availability: connection ? "ready" : "offline",
      promptPolicy: "none",
      connectionUuid: connection?.uuid ?? null,
      agentInstanceUuid: null,
    };
  }

  const onlineFirst =
    connections.find((connection) => connection.effectiveStatus === "online") ??
    null;
  return {
    actorUserUuid: params.actorUserUuid,
    source: "unconfigured",
    agentUuid: params.agentUuid,
    host: null,
    cwd: null,
    availability: onlineFirst ? "ready" : "offline",
    promptPolicy: "select",
    connectionUuid: onlineFirst?.uuid ?? null,
    agentInstanceUuid: null,
  };
}

export async function listProjectAgentCwdPreferences(
  companyUuid: string,
  userUuid: string,
  projectUuid: string,
) {
  await requireProject(companyUuid, projectUuid);
  return listAgentCwdOptions(companyUuid, userUuid, projectUuid);
}

export async function listAvailableAgentCwdOptions(
  companyUuid: string,
  userUuid: string,
) {
  return listAgentCwdOptions(companyUuid, userUuid, null);
}

async function listAgentCwdOptions(
  companyUuid: string,
  userUuid: string,
  projectUuid: string | null,
) {
  const [agents, preferences] = await Promise.all([
    prisma.agent.findMany({
      where: { companyUuid, ownerUuid: userUuid },
      select: { uuid: true, name: true },
      orderBy: [{ name: "asc" }, { uuid: "asc" }],
    }),
    projectUuid
      ? prisma.projectAgentCwdPreference.findMany({
          where: { companyUuid, userUuid, projectUuid },
        })
      : Promise.resolve([]),
  ]);
  const connections = await prisma.daemonConnection.findMany({
    where: { companyUuid, agentUuid: { in: agents.map((agent) => agent.uuid) }, status: "online" },
    select: {
      uuid: true,
      agentUuid: true,
      agentInstanceUuid: true,
      host: true,
      cwd: true,
      lastSeenAt: true,
    },
  });
  const onlineHosts = new Set(connections.map((connection) => `${connection.agentUuid}\0${connection.host}`));
  const byAgent = new Map(preferences.map((preference) => [preference.agentUuid, preference]));
  return agents.flatMap((agent) => {
    const preference = byAgent.get(agent.uuid);
    const onlineInstances = connections
      .filter((connection) => connection.agentUuid === agent.uuid)
      .map((connection) => ({
        connectionUuid: connection.uuid,
        agentInstanceUuid: connection.agentInstanceUuid,
        host: connection.host,
        cwd: connection.cwd,
        effectiveStatus: "online" as const,
      }));
    // Unconfigured offline Agents cannot provide a usable cwd choice. Keep an
    // existing offline preference visible so the user can replace or clear it.
    if (onlineInstances.length === 0 && !preference) return [];
    return [{
      agent,
      onlineInstances,
      preference: preference
        ? {
            uuid: preference.uuid,
            host: preference.host,
            cwd: preference.cwd,
            anchorAgentInstanceUuid: preference.anchorAgentInstanceUuid,
            status: onlineHosts.has(`${agent.uuid}\0${preference.host}`) ? "valid" : "offline",
            updatedAt: preference.updatedAt,
          }
        : null,
    }];
  });
}

export async function resolveTemporaryRuntimeCwd(params: {
  companyUuid: string;
  userUuid: string;
  agentUuid: string;
  validationRequestUuid: string;
}) {
  await requireOwnedAgent(params.companyUuid, params.userUuid, params.agentUuid);
  const validation = await prisma.daemonDirectoryRequest.findFirst({
    where: {
      uuid: params.validationRequestUuid,
      companyUuid: params.companyUuid,
      callerUserUuid: params.userUuid,
      agentUuid: params.agentUuid,
      operation: "validate",
      status: "success",
      completedAt: { gte: new Date(Date.now() - VALIDATION_FRESH_MS) },
    },
  });
  const normalizedPath =
    validation?.result &&
    typeof validation.result === "object" &&
    !Array.isArray(validation.result) &&
    typeof (validation.result as { normalizedPath?: unknown }).normalizedPath === "string"
      ? (validation.result as { normalizedPath: string }).normalizedPath
      : null;
  if (!validation || !normalizedPath) {
    throw new CwdServiceError("STALE_TARGET", "Fresh successful validation required");
  }
  const connection = await prisma.daemonConnection.findFirst({
    where: {
      uuid: validation.targetConnectionUuid,
      companyUuid: params.companyUuid,
      agentUuid: params.agentUuid,
      status: "online",
    },
    select: { host: true },
  });
  if (!connection) throw new CwdServiceError("HOST_OFFLINE", "Target host is offline");
  return { host: connection.host, cwd: normalizedPath };
}

export async function createDirectoryRequest(params: {
  companyUuid: string;
  userUuid: string;
  agentUuid: string;
  targetConnectionUuid: string;
  operation: DirectoryOperation;
  prefix?: string;
  cwd?: string;
  cursor?: string;
  limit?: number;
}) {
  await cleanupDirectoryRequests();
  await requireOwnedAgent(params.companyUuid, params.userUuid, params.agentUuid);
  if (params.operation === "list" && !params.prefix) {
    throw new CwdServiceError("VALIDATION_ERROR", "prefix is required");
  }
  if (params.operation === "validate" && !params.cwd) {
    throw new CwdServiceError("VALIDATION_ERROR", "cwd is required");
  }
  const connection = await prisma.daemonConnection.findFirst({
    where: {
      uuid: params.targetConnectionUuid,
      companyUuid: params.companyUuid,
      agentUuid: params.agentUuid,
      status: "online",
    },
    select: { uuid: true, host: true, agentInstanceUuid: true },
  });
  if (!connection) throw new CwdServiceError("HOST_OFFLINE", "Target host is offline");

  const now = new Date();
  const request = await prisma.daemonDirectoryRequest.create({
    data: {
      companyUuid: params.companyUuid,
      callerUserUuid: params.userUuid,
      agentUuid: params.agentUuid,
      targetConnectionUuid: connection.uuid,
      operation: params.operation,
      prefix: params.prefix ?? null,
      cwd: params.cwd ?? null,
      cursor: params.cursor ?? null,
      limit: Math.max(1, Math.min(params.limit ?? DEFAULT_LIMIT, MAX_LIMIT)),
      deadlineAt: new Date(now.getTime() + REQUEST_TTL_MS),
    },
  });
  eventBus.emit(controlEventName(connection.uuid), {
    type: "control",
    command: "browse_directory",
    targetConnectionUuid: connection.uuid,
    requestUuid: request.uuid,
    operation: params.operation,
    prefix: params.prefix,
    cwd: params.cwd,
    cursor: params.cursor,
    limit: request.limit,
    deadlineAt: request.deadlineAt.toISOString(),
  });
  return request;
}

export async function getDirectoryRequest(companyUuid: string, userUuid: string, uuid: string) {
  const request = await prisma.daemonDirectoryRequest.findFirst({
    where: { uuid, companyUuid, callerUserUuid: userUuid },
  });
  if (!request) throw new CwdServiceError("NOT_FOUND", "Directory request not found");
  if (request.status === "pending" && request.deadlineAt <= new Date()) {
    return prisma.daemonDirectoryRequest.update({
      where: { uuid: request.uuid },
      data: { status: "error", errorCode: "TIMEOUT", completedAt: new Date() },
    });
  }
  return request;
}

export async function completeDirectoryRequest(params: {
  companyUuid: string;
  agentUuid: string;
  connectionUuid: string;
  requestUuid: string;
  status: "success" | "error";
  result?: unknown;
  errorCode?: DirectoryErrorCode;
}) {
  const request = await prisma.daemonDirectoryRequest.findFirst({
    where: {
      uuid: params.requestUuid,
      companyUuid: params.companyUuid,
      agentUuid: params.agentUuid,
      targetConnectionUuid: params.connectionUuid,
      status: "pending",
    },
  });
  if (!request) throw new CwdServiceError("NOT_FOUND", "Directory request not found");
  if (request.deadlineAt <= new Date()) {
    await prisma.daemonDirectoryRequest.update({
      where: { uuid: request.uuid },
      data: { status: "error", errorCode: "TIMEOUT", completedAt: new Date() },
    });
    throw new CwdServiceError("TIMEOUT", "Directory request timed out");
  }
  if (params.status === "error" && !params.errorCode) {
    throw new CwdServiceError("VALIDATION_ERROR", "errorCode is required");
  }
  if (params.status === "success") {
    const result = params.result;
    if (
      request.operation === "roots" &&
      (!result ||
        typeof result !== "object" ||
        Array.isArray(result) ||
        !Array.isArray((result as { roots?: unknown }).roots) ||
        (result as { roots: unknown[] }).roots.length === 0 ||
        !(result as { roots: unknown[] }).roots.every(
          (root) => typeof root === "string" && root.length > 0,
        ))
    ) {
      return prisma.daemonDirectoryRequest.update({
        where: { uuid: request.uuid },
        data: {
          status: "error",
          result: undefined,
          errorCode: "INTERNAL_ERROR",
          completedAt: new Date(),
        },
      });
    }
  }
  return prisma.daemonDirectoryRequest.update({
    where: { uuid: request.uuid },
    data: {
      status: params.status,
      result: params.status === "success" ? (params.result as object) : undefined,
      errorCode: params.status === "error" ? params.errorCode : null,
      completedAt: new Date(),
    },
  });
}

export async function saveProjectAgentCwdPreference(params: {
  companyUuid: string;
  userUuid: string;
  projectUuid: string;
  agentUuid: string;
  validationRequestUuid: string;
}) {
  await Promise.all([
    requireProject(params.companyUuid, params.projectUuid),
    requireOwnedAgent(params.companyUuid, params.userUuid, params.agentUuid),
  ]);
  const freshAfter = new Date(Date.now() - VALIDATION_FRESH_MS);
  const validation = await prisma.daemonDirectoryRequest.findFirst({
    where: {
      uuid: params.validationRequestUuid,
      companyUuid: params.companyUuid,
      callerUserUuid: params.userUuid,
      agentUuid: params.agentUuid,
      operation: "validate",
      status: "success",
      completedAt: { gte: freshAfter },
    },
  });
  if (!validation?.cwd) {
    throw new CwdServiceError("STALE_TARGET", "Fresh successful validation required");
  }
  const normalizedCwd =
    validation.result &&
    typeof validation.result === "object" &&
    !Array.isArray(validation.result) &&
    typeof (validation.result as { normalizedPath?: unknown }).normalizedPath === "string"
      ? (validation.result as { normalizedPath: string }).normalizedPath
      : null;
  if (!normalizedCwd) {
    throw new CwdServiceError("STALE_TARGET", "Validation result is missing normalized path");
  }
  const connection = await prisma.daemonConnection.findFirst({
    where: {
      uuid: validation.targetConnectionUuid,
      companyUuid: params.companyUuid,
      agentUuid: params.agentUuid,
    },
    select: { host: true },
  });
  if (!connection) throw new CwdServiceError("STALE_TARGET", "Validation target is stale");
  const anchorAgentInstanceUuid = await materializeAgentInstance(
    params.companyUuid,
    params.agentUuid,
    connection.host,
    normalizedCwd,
  );
  return prisma.projectAgentCwdPreference.upsert({
    where: {
      userUuid_projectUuid_agentUuid: {
        userUuid: params.userUuid,
        projectUuid: params.projectUuid,
        agentUuid: params.agentUuid,
      },
    },
    create: {
      companyUuid: params.companyUuid,
      userUuid: params.userUuid,
      projectUuid: params.projectUuid,
      agentUuid: params.agentUuid,
      host: connection.host,
      cwd: normalizedCwd,
      anchorAgentInstanceUuid,
    },
    update: {
      host: connection.host,
      cwd: normalizedCwd,
      anchorAgentInstanceUuid,
    },
  });
}

export async function clearProjectAgentCwdPreference(params: {
  companyUuid: string;
  userUuid: string;
  projectUuid: string;
  agentUuid: string;
}) {
  await requireProject(params.companyUuid, params.projectUuid);
  await prisma.projectAgentCwdPreference.deleteMany({
    where: {
      companyUuid: params.companyUuid,
      userUuid: params.userUuid,
      projectUuid: params.projectUuid,
      agentUuid: params.agentUuid,
    },
  });
}

export async function cleanupDirectoryRequests(now = new Date()) {
  return prisma.daemonDirectoryRequest.deleteMany({
    where: {
      OR: [
        { deadlineAt: { lt: new Date(now.getTime() - 60 * 60 * 1000) } },
        { completedAt: { lt: new Date(now.getTime() - 60 * 60 * 1000) } },
      ],
    },
  });
}
