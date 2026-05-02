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

  // Public tools — available to every authenticated agent (no permission gating)
  registerPublicTools(server, auth);
  registerSessionTools(server, auth);

  // Permission-gated tools. Each register function calls registerPermissionedTool
  // per tool, which checks auth.permissions.includes(required) before registering.
  registerPmTools(server, auth);
  registerDeveloperTools(server, auth);
  registerAdminTools(server, auth);

  return server;
}
