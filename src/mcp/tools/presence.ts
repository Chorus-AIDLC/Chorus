// src/mcp/tools/presence.ts
// Central project-access gate and presence wrapper for every registered tool.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { eventBus, type PresenceEvent } from "@/lib/event-bus";
import {
  ProjectAccessDeniedError,
  ProjectNotFoundError,
  resolveEntityProjectUuid,
} from "@/services/project-access.service";
import { GroupNotFoundError } from "@/services/project-group-access.service";
import { getToolProjectAccessPolicy } from "./permission-map";
import { authorizeToolProjectAccess, McpResourceNotFoundError } from "./project-access";
import type { AgentAuthContext } from "@/types/auth";
import logger from "@/lib/logger";

const presenceLogger = logger.child({ module: "presence" });

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
  subEntityType?: string;
  subEntityUuid?: string;
}

function detectResource(params: Record<string, unknown>, toolName: string): DetectedResource | null {
  // Detect optional sub-entity (e.g., draftUuid within a proposal)
  const draftUuid = typeof params.draftUuid === "string" ? params.draftUuid : undefined;
  // Detect comment tools for sub-entity "comment"
  const isCommentTool = toolName.includes("comment");

  // Check entity-specific UUID fields first
  for (const [field, entityType] of Object.entries(ENTITY_UUID_FIELDS)) {
    if (typeof params[field] === "string") {
      return {
        entityType,
        entityUuid: params[field] as string,
        projectUuid: typeof params.projectUuid === "string" ? params.projectUuid : undefined,
        ...(draftUuid && entityType === "proposal" ? { subEntityType: "draft", subEntityUuid: draftUuid } : {}),
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
        ...(isCommentTool ? { subEntityType: "comment" } : {}),
      };
    }
  }

  return null;
}

// Resolve projectUuid from an entity UUID via DB lookup (company-scoped)
async function resolveProjectUuid(
  companyUuid: string,
  entityType: PresenceEvent["entityType"],
  entityUuid: string,
  cache: Map<string, string>
): Promise<string | null> {
  const cacheKey = `${companyUuid}:${entityType}:${entityUuid}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const projectUuid = await resolveEntityProjectUuid(companyUuid, entityType, entityUuid);
  if (projectUuid) {
    cache.set(cacheKey, projectUuid);
  }
  return projectUuid;
}

/** Only called with a project resolved and authorized by the central gate. */
function emitPresence(
  resource: DetectedResource & { projectUuid: string },
  toolName: string,
  auth: AgentAuthContext,
): void {
  try {
      const presenceEvent: PresenceEvent = {
        companyUuid: auth.companyUuid,
        projectUuid: resource.projectUuid,
        entityType: resource.entityType,
        entityUuid: resource.entityUuid,
        ...(resource.subEntityType ? {
          subEntityType: resource.subEntityType,
          ...(resource.subEntityUuid ? { subEntityUuid: resource.subEntityUuid } : {}),
        } : {}),
        agentUuid: auth.actorUuid,
        agentName: auth.agentName || "Unknown Agent",
        action: classifyAction(toolName),
        timestamp: Date.now(),
      };
      eventBus.emitPresence(presenceEvent);
  } catch (err) {
    presenceLogger.warn({ err }, "Failed to emit presence event");
  }
}

/**
 * Wraps a McpServer to authorize calls before handlers and presence emission.
 * Call this once after creating the server, before registering tools.
 * The wrapper intercepts registerTool to wrap each handler with presence emission.
 */
export function enablePresence(server: McpServer, auth: AgentAuthContext): void {
  const originalRegisterTool = server.registerTool.bind(server);

  // Override registerTool to wrap handlers
  server.registerTool = function (name: string, config: unknown, handler: unknown) {
    const policy = getToolProjectAccessPolicy(name);
    const originalHandler = handler as (params: Record<string, unknown>, extra: unknown) => Promise<unknown>;

    const wrappedHandler = async (params: Record<string, unknown>, extra: unknown) => {
      let authorized;
      try {
        authorized = await authorizeToolProjectAccess(name, params, auth, policy);
      } catch (error) {
        if (error instanceof McpResourceNotFoundError ||
            error instanceof ProjectNotFoundError ||
            error instanceof GroupNotFoundError ||
            error instanceof ProjectAccessDeniedError) {
          return { content: [{ type: "text", text: error.message }], isError: true };
        }
        // Unexpected authorization failures propagate through the SDK's
        // CallToolResult error path. Never continue into the handler.
        throw error;
      }

      const resource = detectResource(params, name);
      if (resource) {
        const resolved = authorized.find((r) =>
          r.entityType === resource.entityType && r.entityUuid === resource.entityUuid);
        if (resolved) emitPresence({ ...resource, projectUuid: resolved.projectUuid }, name, auth);
      } else {
        // Reference edits and session-only calls resolve their parent entities.
        const parent = authorized.find((r) => Object.values(ENTITY_UUID_FIELDS).includes(r.entityType as PresenceEvent["entityType"]));
        if (parent) emitPresence({
          ...parent,
          entityType: parent.entityType as PresenceEvent["entityType"],
        }, name, auth);
      }

      return originalHandler(params, extra);
    };

    return originalRegisterTool(name, config as Parameters<typeof originalRegisterTool>[1], wrappedHandler as Parameters<typeof originalRegisterTool>[2]);
  } as typeof server.registerTool;
}

// Exported for testing
export { detectResource, classifyAction, resolveProjectUuid };
