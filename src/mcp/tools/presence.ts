// src/mcp/tools/presence.ts
// MCP tool handler wrapper for automatic presence event emission.
// Wraps all registerTool handlers to detect target resources and emit presence events.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { eventBus, type PresenceEvent } from "@/lib/event-bus";
import type { AgentAuthContext } from "@/types/auth";
import { prisma } from "@/lib/prisma";

// Entity types that presence events support
const ENTITY_UUID_FIELDS: Record<string, PresenceEvent["entityType"]> = {
  taskUuid: "task",
  ideaUuid: "idea",
  proposalUuid: "proposal",
  documentUuid: "document",
};

// Polymorphic targetType values that map to entity types
const TARGET_TYPE_MAP: Record<string, PresenceEvent["entityType"]> = {
  task: "task",
  idea: "idea",
  proposal: "proposal",
  document: "document",
};

// Tool name prefixes that indicate "view" action
const VIEW_PREFIXES = ["chorus_get_", "chorus_list_", "chorus_search"];

function classifyAction(toolName: string): "view" | "mutate" {
  return VIEW_PREFIXES.some((p) => toolName.startsWith(p)) ? "view" : "mutate";
}

interface DetectedResource {
  entityType: PresenceEvent["entityType"];
  entityUuid: string;
  projectUuid?: string;
}

function detectResource(params: Record<string, unknown>): DetectedResource | null {
  // Check entity-specific UUID fields first
  for (const [field, entityType] of Object.entries(ENTITY_UUID_FIELDS)) {
    if (typeof params[field] === "string") {
      return {
        entityType,
        entityUuid: params[field] as string,
        projectUuid: typeof params.projectUuid === "string" ? params.projectUuid : undefined,
      };
    }
  }

  // Check polymorphic targetUuid + targetType pattern
  if (typeof params.targetUuid === "string" && typeof params.targetType === "string") {
    const entityType = TARGET_TYPE_MAP[params.targetType];
    if (entityType) {
      return {
        entityType,
        entityUuid: params.targetUuid as string,
        projectUuid: typeof params.projectUuid === "string" ? params.projectUuid : undefined,
      };
    }
  }

  return null;
}

// Resolve projectUuid from an entity UUID via DB lookup
async function resolveProjectUuid(
  entityType: PresenceEvent["entityType"],
  entityUuid: string,
  cache: Map<string, string>
): Promise<string | null> {
  const cacheKey = `${entityType}:${entityUuid}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  try {
    let projectUuid: string | null = null;

    switch (entityType) {
      case "task": {
        const task = await prisma.task.findFirst({
          where: { uuid: entityUuid },
          select: { project: { select: { uuid: true } } },
        });
        projectUuid = task?.project?.uuid ?? null;
        break;
      }
      case "idea": {
        const idea = await prisma.idea.findFirst({
          where: { uuid: entityUuid },
          select: { project: { select: { uuid: true } } },
        });
        projectUuid = idea?.project?.uuid ?? null;
        break;
      }
      case "proposal": {
        const proposal = await prisma.proposal.findFirst({
          where: { uuid: entityUuid },
          select: { project: { select: { uuid: true } } },
        });
        projectUuid = proposal?.project?.uuid ?? null;
        break;
      }
      case "document": {
        const doc = await prisma.document.findFirst({
          where: { uuid: entityUuid },
          select: { project: { select: { uuid: true } } },
        });
        projectUuid = doc?.project?.uuid ?? null;
        break;
      }
    }

    if (projectUuid) {
      cache.set(cacheKey, projectUuid);
    }
    return projectUuid;
  } catch (err) {
    console.warn("[Presence] Failed to resolve projectUuid:", err);
    return null;
  }
}

/** Fire-and-forget presence emission — never blocks the tool handler */
async function emitPresenceAsync(
  resource: DetectedResource,
  toolName: string,
  auth: AgentAuthContext,
  cache: Map<string, string>
): Promise<void> {
  try {
    let projectUuid = resource.projectUuid;
    if (!projectUuid) {
      projectUuid = (await resolveProjectUuid(
        resource.entityType,
        resource.entityUuid,
        cache
      )) ?? undefined;
    }

    if (projectUuid) {
      const presenceEvent: PresenceEvent = {
        companyUuid: auth.companyUuid,
        projectUuid,
        entityType: resource.entityType,
        entityUuid: resource.entityUuid,
        agentUuid: auth.actorUuid,
        agentName: auth.agentName || "Unknown Agent",
        action: classifyAction(toolName),
        timestamp: Date.now(),
      };
      eventBus.emitPresence(presenceEvent);
    }
  } catch (err) {
    console.warn("[Presence] Failed to emit presence event:", err);
  }
}

/**
 * Wraps a McpServer to automatically emit presence events for all registered tools.
 * Call this once after creating the server, before registering tools.
 * The wrapper intercepts registerTool to wrap each handler with presence emission.
 */
export function enablePresence(server: McpServer, auth: AgentAuthContext): void {
  // Session-scoped cache for projectUuid resolution
  const projectUuidCache = new Map<string, string>();

  const originalRegisterTool = server.registerTool.bind(server);

  // Override registerTool to wrap handlers
  server.registerTool = function (name: string, config: unknown, handler: unknown) {
    const originalHandler = handler as (params: Record<string, unknown>, extra: unknown) => Promise<unknown>;

    const wrappedHandler = async (params: Record<string, unknown>, extra: unknown) => {
      // Fire and forget — emit presence without blocking the tool handler
      const resource = detectResource(params);
      if (resource) {
        emitPresenceAsync(resource, name, auth, projectUuidCache);
      }

      return originalHandler(params, extra);
    };

    return originalRegisterTool(name, config as Parameters<typeof originalRegisterTool>[1], wrappedHandler as Parameters<typeof originalRegisterTool>[2]);
  } as typeof server.registerTool;
}

// Exported for testing
export { detectResource, classifyAction, resolveProjectUuid };
