// src/mcp/tools/tool-logger.ts
// Central MCP tool-call logging wrapper.
// Intercepts all registerTool handlers to log business rejections (warn)
// and successful calls (debug). Must be called BEFORE enablePresence in server.ts
// so it wraps the outermost layer and captures the final result.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AgentAuthContext } from "@/types/auth";
import { prisma } from "@/lib/prisma";
import logger from "@/lib/logger";
import { detectResource, resolveProjectUuid } from "./presence";

const toolLogger = logger.child({ module: "mcp-tool" });

const MAX_STRING_LENGTH = 500;
const TRUNCATE_EDGE = 250;

/** Truncate long string values in params to prevent log bloat. */
function truncateParams(params: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string" && value.length > MAX_STRING_LENGTH) {
      result[key] = `${value.slice(0, TRUNCATE_EDGE)}...${value.slice(-TRUNCATE_EDGE)}`;
    } else {
      result[key] = value;
    }
  }
  return result;
}

/** Extract error text from an MCP tool result with isError: true. */
function extractErrorText(result: unknown): string | undefined {
  if (
    typeof result === "object" &&
    result !== null &&
    "content" in result &&
    Array.isArray((result as { content: unknown[] }).content)
  ) {
    const texts = (result as { content: Array<{ type: string; text?: string }> }).content
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text);
    return texts.length > 0 ? texts.join(" ") : undefined;
  }
  return undefined;
}

/** Safely compute byte size of a JSON-serializable value (returns 0 on failure). */
function safeJsonSize(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

/** Extract sessionUuid from tool params, if present as a string. */
function extractSessionUuid(params: Record<string, unknown>): string | null {
  return typeof params.sessionUuid === "string" ? params.sessionUuid : null;
}

interface PersistParams {
  auth: AgentAuthContext;
  toolName: string;
  params: Record<string, unknown>;
  result: unknown;
  durationMs: number;
  isError: boolean;
  errorText: string | null;
  projectUuidCache: Map<string, string>;
}

/**
 * Fire-and-forget persistence of a ToolUsageEvent row.
 * Must never throw — callers rely on this not blocking tool response.
 */
async function persistToolUsage(p: PersistParams): Promise<void> {
  const resource = detectResource(p.params, p.toolName);

  let entityType: string | null = null;
  let entityUuid: string | null = null;
  let projectUuid: string | null = null;

  if (resource) {
    entityType = resource.entityType;
    entityUuid = resource.entityUuid;
    projectUuid = resource.projectUuid ?? null;
    if (!projectUuid) {
      projectUuid = await resolveProjectUuid(
        resource.entityType,
        resource.entityUuid,
        p.projectUuidCache
      );
    }
  }

  await prisma.toolUsageEvent.create({
    data: {
      companyUuid: p.auth.companyUuid,
      agentUuid: p.auth.actorUuid,
      sessionUuid: extractSessionUuid(p.params),
      toolName: p.toolName,
      source: "mcp",
      durationMs: p.durationMs,
      inputSize: safeJsonSize(p.params),
      outputSize: safeJsonSize(p.result),
      isError: p.isError,
      errorText: p.errorText,
      entityType,
      entityUuid,
      projectUuid,
    },
  });
}

/**
 * Wraps a McpServer to log all tool calls.
 * - Business rejections (isError: true) → warn
 * - Successful calls → debug
 * - Unhandled exceptions → error + re-throw
 *
 * Also persists each call to ToolUsageEvent asynchronously (fire-and-forget).
 *
 * Call BEFORE enablePresence so this wrapper is the outermost layer.
 */
export function enableToolCallLogging(server: McpServer, auth: AgentAuthContext): void {
  const agent = { uuid: auth.actorUuid, name: auth.agentName || "Unknown Agent" };
  // Session-scoped cache for projectUuid resolution (shared across all tool calls
  // for this MCP session), mirrors the pattern used in presence.ts enablePresence.
  const projectUuidCache = new Map<string, string>();
  const originalRegisterTool = server.registerTool.bind(server);

  server.registerTool = function (name: string, config: unknown, handler: unknown) {
    const originalHandler = handler as (params: Record<string, unknown>, extra: unknown) => Promise<unknown>;

    const wrappedHandler = async (params: Record<string, unknown>, extra: unknown) => {
      const start = Date.now();
      let result: unknown;

      try {
        result = await originalHandler(params, extra);
      } catch (err) {
        const durationMs = Date.now() - start;
        toolLogger.error(
          { tool: name, agent, params: truncateParams(params), err, durationMs },
          "MCP tool unhandled exception"
        );
        throw err;
      }

      const durationMs = Date.now() - start;
      const isErrorResult =
        typeof result === "object" && result !== null && (result as { isError?: boolean }).isError === true;
      const errorText = isErrorResult ? extractErrorText(result) : undefined;

      if (isErrorResult) {
        toolLogger.warn(
          { tool: name, agent, params: truncateParams(params), error: errorText, durationMs },
          "MCP tool business rejection"
        );
      } else {
        toolLogger.debug(
          { tool: name, agent, params: truncateParams(params), durationMs },
          "MCP tool call"
        );
      }

      // Fire-and-forget persistence — never block the tool response.
      persistToolUsage({
        auth,
        toolName: name,
        params,
        result,
        durationMs,
        isError: isErrorResult,
        errorText: errorText ?? null,
        projectUuidCache,
      }).catch((err) => {
        toolLogger.warn({ tool: name, err }, "Failed to persist ToolUsageEvent");
      });

      return result;
    };

    return originalRegisterTool(name, config as Parameters<typeof originalRegisterTool>[1], wrappedHandler as Parameters<typeof originalRegisterTool>[2]);
  } as typeof server.registerTool;
}

// Exported for testing
export { truncateParams, extractErrorText, safeJsonSize, extractSessionUuid };
