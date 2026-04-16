// src/mcp/tools/tool-logger.ts
// Central MCP tool-call logging wrapper.
// Intercepts all registerTool handlers to log business rejections (warn)
// and successful calls (debug). Must be called BEFORE enablePresence in server.ts
// so it wraps the outermost layer and captures the final result.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AgentAuthContext } from "@/types/auth";
import logger from "@/lib/logger";

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

/**
 * Wraps a McpServer to log all tool calls.
 * - Business rejections (isError: true) → warn
 * - Successful calls → debug
 * - Unhandled exceptions → error + re-throw
 *
 * Call BEFORE enablePresence so this wrapper is the outermost layer.
 */
export function enableToolCallLogging(server: McpServer, auth: AgentAuthContext): void {
  const agent = { uuid: auth.actorUuid, name: auth.agentName || "Unknown Agent" };
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

      if (typeof result === "object" && result !== null && (result as { isError?: boolean }).isError) {
        const errorText = extractErrorText(result);
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

      return result;
    };

    return originalRegisterTool(name, config as Parameters<typeof originalRegisterTool>[1], wrappedHandler as Parameters<typeof originalRegisterTool>[2]);
  } as typeof server.registerTool;
}

// Exported for testing
export { truncateParams, extractErrorText };
