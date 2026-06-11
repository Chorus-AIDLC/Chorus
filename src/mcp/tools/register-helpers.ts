// src/mcp/tools/register-helpers.ts
// MCP tool registration helpers with permission gating (Tech Design §5.2)

import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { AnySchema, ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { AgentAuthContext } from "@/types/auth";
import type { Permission } from "@/lib/authz/types";
import { canAccessProject, canManageProject, type AnyAuth } from "@/lib/authz/project-access";

/** Standard MCP error content shape returned when a project is inaccessible. */
type McpErrorResult = { content: [{ type: "text"; text: string }]; isError: true };

function projectDeniedError(): McpErrorResult {
  return {
    content: [{ type: "text", text: "Project not found or access denied" }],
    isError: true,
  };
}

/**
 * Project-visibility guard for MCP tools that take a `projectUuid` directly
 * (i.e. tools that do NOT route through a gated service that already filters
 * by accessible projects). Returns an MCP error content object when the actor
 * cannot access the project, or null when access is granted. See Tech Design §6.
 */
export async function assertProjectAccess(
  auth: AnyAuth,
  projectUuid: string,
): Promise<McpErrorResult | null> {
  const allowed = await canAccessProject(auth, projectUuid);
  return allowed ? null : projectDeniedError();
}

/**
 * Project-management guard for MCP tools that mutate a project's membership or
 * visibility. Restricted to the owner (or super admin). Returns an MCP error
 * content object when the actor cannot manage the project, or null otherwise.
 */
export async function assertProjectManage(
  auth: AnyAuth,
  projectUuid: string,
): Promise<McpErrorResult | null> {
  const allowed = await canManageProject(auth, projectUuid);
  return allowed ? null : projectDeniedError();
}

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
