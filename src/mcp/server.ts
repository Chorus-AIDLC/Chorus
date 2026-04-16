// src/mcp/server.ts
// MCP Server instance (ARCHITECTURE.md §5.2)

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerPublicTools } from "./tools/public";
import { registerPmTools } from "./tools/pm";
import { registerDeveloperTools } from "./tools/developer";
import { registerAdminTools } from "./tools/admin";
import { registerSessionTools } from "./tools/session";
import { enableToolCallLogging } from "./tools/tool-logger";
import { enablePresence } from "./tools/presence";
import type { AgentAuthContext } from "@/types/auth";

// MCP Server factory function
export function createMcpServer(auth: AgentAuthContext): McpServer {
  const server = new McpServer({
    name: "chorus",
    version: "1.0.0",
  });

  // Enable tool-call logging (must be before enablePresence so it wraps the outermost layer)
  enableToolCallLogging(server, auth);

  // Enable presence event emission for all tools (must be called before registerTool calls)
  enablePresence(server, auth);

  // Register public tools (available to all Agents)
  registerPublicTools(server, auth);

  // Register Session tools (available to all Agents)
  registerSessionTools(server, auth);

  // Register role-specific tools based on agent roles
  const roles = auth.roles || [];

  // Support two role formats: "pm" / "pm_agent", "developer" / "developer_agent", "admin" / "admin_agent"
  const hasPmRole = roles.some(r => r === "pm" || r === "pm_agent");
  const hasDevRole = roles.some(r => r === "developer" || r === "developer_agent");
  const hasAdminRole = roles.some(r => r === "admin" || r === "admin_agent");

  if (hasAdminRole) {
    registerAdminTools(server, auth);
  }
  if (hasPmRole || hasAdminRole) {
    registerPmTools(server, auth);
  }
  if (hasDevRole || hasAdminRole) {
    registerDeveloperTools(server, auth);
  }

  return server;
}
