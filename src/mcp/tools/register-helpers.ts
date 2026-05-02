// src/mcp/tools/register-helpers.ts
// MCP tool registration helpers with permission gating (Tech Design §5.2)

import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { AnySchema, ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { AgentAuthContext } from "@/types/auth";
import type { Permission } from "@/lib/authz/types";

type ToolInputSchema = ZodRawShapeCompat | AnySchema | undefined;

interface PermissionedToolConfig<OutputArgs extends ZodRawShapeCompat | AnySchema, InputArgs extends ToolInputSchema> {
  title?: string;
  description?: string;
  inputSchema?: InputArgs;
  outputSchema?: OutputArgs;
  annotations?: ToolAnnotations;
  _meta?: Record<string, unknown>;
}

/**
 * Register an MCP tool only when the auth context holds the required Permission.
 * When the permission is missing, the tool is simply not registered and remains
 * invisible to the client. See Tech Design §5.2.
 */
export function registerPermissionedTool<
  OutputArgs extends ZodRawShapeCompat | AnySchema,
  InputArgs extends ToolInputSchema = undefined,
>(
  server: McpServer,
  auth: AgentAuthContext,
  required: Permission,
  name: string,
  config: PermissionedToolConfig<OutputArgs, InputArgs>,
  handler: ToolCallback<InputArgs>,
): void {
  if (!auth.permissions.includes(required)) return;
  server.registerTool(name, config, handler);
}
